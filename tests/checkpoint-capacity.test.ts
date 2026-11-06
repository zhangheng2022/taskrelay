import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { HumanMessage } from '@langchain/core/messages';
import { D1Checkpointer } from '../apps/cloud/src/ai/checkpointer';
import { planConversation } from '../apps/cloud/src/ai/planning-graph';
import { testDb } from './helpers';
import { productionModelFixture } from './production-model-fixture';

const metadata = { source: 'input' as const, step: 0, parents: {} };
const key = Buffer.alloc(32, 8).toString('base64');

// 在读取事务结束、调用者收到数据之前插入一次真实写入；旧实现的 first()
// 路径也经过同一插点，能复现 marker 与碎片分开读取时的缺片竞态。
function afterCheckpointRead(t: import('node:test').TestContext, db: D1Database, operation: () => Promise<void>) {
  const prepare = db.prepare.bind(db), batch = db.batch.bind(db), selected = new WeakSet<D1PreparedStatement>();
  let fired = false;
  const interleave = async () => { if (!fired) { fired = true; await operation(); } };
  t.mock.method(db, 'prepare', (query: string) => {
    const statement = prepare(query);
    if (query.startsWith('SELECT * FROM ai_checkpoints')) {
      selected.add(statement);
      const first = statement.first.bind(statement);
      t.mock.method(statement, 'first', async <T>(column?: string) => {
        const value = column === undefined ? await first<T>() : await first<T>(column);
        await interleave(); return value;
      });
    }
    return statement;
  });
  t.mock.method(db, 'batch', async <T>(statements: D1PreparedStatement[]) => {
    const result = await batch<T>(statements);
    if (statements.some(statement => selected.has(statement))) await interleave();
    return result;
  });
}

for (const replacement of ['checkpoint', 'pending-write'] as const) test(`读取使用同一事务的 marker 和全部碎片，并发替换不误报丢片：${replacement}`, async t => {
  const { db, sql } = testDb(); t.after(() => sql.close());
  const saver = new D1Checkpointer(db, 'owner', key), text = '完整私密检查点 😀'.repeat(30_000);
  const cp = emptyCheckpoint(); cp.channel_values = { input: text };
  const config = await saver.put({ configurable: { thread_id: 'interleaved', checkpoint_ns: 'branch' } }, cp, { ...metadata, parents: { original: text } });
  await saver.putWrites(config, [['__error__', text]], 'task');
  afterCheckpointRead(t, db, async () => {
    if (replacement === 'checkpoint') await saver.put(config, { ...cp, channel_values: { input: text + '新值' } }, { ...metadata, parents: { original: text + '新值' } });
    else await saver.putWrites(config, [['__error__', text + '新值']], 'task');
  });
  const observed = (await saver.getTuple(config))!;
  assert.equal(observed.checkpoint.channel_values.input, text);
  assert.equal(observed.metadata!.parents.original, text);
  assert.equal(observed.pendingWrites![0][2], text);
  const latest = (await saver.getTuple(config))!;
  if (replacement === 'checkpoint') {
    assert.equal(latest.checkpoint.channel_values.input, text + '新值');
    assert.equal(latest.metadata!.parents.original, text + '新值');
  } else assert.equal(latest.pendingWrites![0][2], text + '新值');
});

test('list 的父行在索引读取后被删除时跳过，getTuple 返回 undefined', async t => {
  const { db, sql } = testDb(); t.after(() => sql.close());
  const saver = new D1Checkpointer(db, 'owner', key), cp = emptyCheckpoint();
  cp.channel_values = { input: '分块数据'.repeat(100_000) };
  const config = await saver.put({ configurable: { thread_id: 'removed' } }, cp, metadata);
  const prepare = db.prepare.bind(db); let removed = false;
  t.mock.method(db, 'prepare', (query: string) => {
    const statement = prepare(query);
    if (/SELECT (?:id|\*) FROM ai_checkpoints WHERE.*id</.test(query)) {
      const all = statement.all.bind(statement);
      t.mock.method(statement, 'all', async <T>() => {
        const rows = await all<T>();
        if (!removed) { removed = true; await saver.deleteThread('removed'); }
        return rows;
      });
    }
    return statement;
  });
  const listed = [];
  for await (const tuple of saver.list(config)) listed.push(tuple);
  assert.equal(removed, true); assert.deepEqual(listed, []);
  assert.equal(await saver.getTuple(config), undefined);
});

test('大检查点和 pending writes 原样恢复、幂等隔离、替换及删除级联清理', async t => {
  const { db, sql } = testDb(); t.after(() => sql.close());
  const saver = new D1Checkpointer(db, 'owner', key);
  const text = '原始私密输入 0012Ab! 😀'.repeat(30_000);
  const cp = emptyCheckpoint(); cp.channel_values = { messages: [new HumanMessage(text)] };
  const config = await saver.put({ configurable: { thread_id: 'large' } }, cp, { ...metadata, parents: { original: text } });
  await saver.putWrites(config, [['output', text]], 'task');
  await saver.putWrites(config, [['output', '不应覆盖'.repeat(100_000)]], 'task');
  await saver.putWrites(config, [['__error__', text]], 'failure');
  await saver.putWrites(config, [['__error__', text + '更新']], 'failure');
  const restored = (await saver.getTuple(config))!;
  assert.equal((restored.checkpoint.channel_values.messages as HumanMessage[])[0].content, text);
  assert.equal(restored.metadata!.parents.original, text);
  assert.equal(restored.pendingWrites!.find(w => w[0] === 'task')![2], text);
  assert.equal(restored.pendingWrites!.find(w => w[0] === 'failure')![2], text + '更新');
  assert.equal(await new D1Checkpointer(db, 'other', key).getTuple(config), undefined);
  for (const table of ['ai_checkpoint_chunks', 'ai_write_chunks']) {
    const rows = sql.prepare(`SELECT value FROM ${table}`).all();
    assert.ok(rows.length > 1);
    assert.ok(rows.every(r => Buffer.byteLength(String(r.value)) <= 500_000 && !String(r.value).includes('原始私密输入')));
  }
  // 分块插入失败时，旧索引及全部旧碎片也必须回滚，不能留下半个检查点。
  sql.exec("CREATE TRIGGER fail_chunk BEFORE INSERT ON ai_checkpoint_chunks WHEN NEW.part=1 BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
  cp.channel_values = { messages: [new HumanMessage(text + '替换失败')] };
  await assert.rejects(saver.put(config, cp, metadata), /fixture failure/);
  assert.equal(((await saver.getTuple(config))!.checkpoint.channel_values.messages as HumanMessage[])[0].content, text);
  sql.exec('DROP TRIGGER fail_chunk');
  cp.channel_values = { output: '小值' };
  await saver.put(config, cp, metadata);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM ai_checkpoint_chunks').get()!.n, 0);
  // 丢片必须显式失败，不能拼接出截断的消息继续调用模型。
  sql.exec('DELETE FROM ai_write_chunks WHERE part=1');
  await assert.rejects(saver.getTuple(config), /CHECKPOINT_CHUNKS_MISSING/);
  await saver.deleteThread('large');
  for (const table of ['ai_checkpoints', 'ai_writes', 'ai_checkpoint_chunks', 'ai_write_chunks'])
    assert.equal(sql.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
});

test('真实规划图在完整历史超过 D1 单值限制时仍可进入摘要并完成', async t => {
  const s = await productionModelFixture(t); s.env.requestUserId = 'legacy_owner';
  s.sql.exec("UPDATE model_profiles SET config=json_set(config,'$.contextTokens',650000,'$.outputTokens',4096) WHERE id='model_test' AND version=1");
  const thread = (await s.request('/api/user/threads', { modelId: 'model_test' })).data;
  const prepare = s.db.prepare.bind(s.db);
  t.mock.method(s.db, 'prepare', (query: string) => {
    const statement = prepare(query), bind = statement.bind.bind(statement);
    t.mock.method(statement, 'bind', (...values: unknown[]) => {
      if (/INSERT.*ai_(checkpoints|writes|checkpoint_chunks|write_chunks)/.test(query)) {
        for (const value of values) if (typeof value === 'string')
          assert.ok(Buffer.byteLength(value) < 2_000_000, 'D1 单值上限');
      }
      return bind(...values);
    });
    return statement;
  });
  s.respond(body => body.response_format?JSON.stringify({ reply: '请明确任务目标。', start: false, title: null, goal: null, entryUrl: null, accountId: null, executionOutline: [] }):'已读取历史，仍需用户明确任务目标。');
  const messages = [
    { role: 'system' as const, content: '保留用户原话，按目标处理。' },
    { role: 'user' as const, content: JSON.stringify({ userMessages: [{ role: 'user', content: '原文保留 0012Ab! 继续' }] }) },
  ];
  const history=Array.from({length:100},()=>({role:'assistant' as const,content:'a'.repeat(12000)}));
  const result = await planConversation({ env: s.env, owner: 'legacy_owner', id: 'large_graph', threadId: thread.id, kind: 'chat', guard: async () => {} }, { model_id: 'model_test', model_version: 1 }, messages,history);
  assert.equal(result.reply, '请明确任务目标。');
  assert.ok(s.jobs() > 1, '调用摘要及规划模型');
  const finalRequest = JSON.stringify(s.requests.at(-1)!.body);
  assert.match(finalRequest, /原文保留 0012Ab! 继续/);
  assert.ok(finalRequest.length<JSON.stringify(history).length/2,'保留约三成近期历史');
  const tuple = await new D1Checkpointer(s.db, 'legacy_owner', s.env.MASTER_KEY).getTuple({ configurable: { thread_id: 'large_graph' } });
  assert.deepEqual(tuple!.checkpoint.channel_values.messages, messages);
  assert.deepEqual(tuple!.checkpoint.channel_values.history,history);
});
