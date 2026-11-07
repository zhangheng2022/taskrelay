import { dbTime } from "../apps/cloud/src/database";
import { fixturePng } from "./image-fixture";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { productionModelFixture } from "./production-model-fixture";
import { appendMessage, conversationContext } from "../apps/cloud/src/chat-messages";
import { drainCommands } from "../apps/cloud/src/ai/commands";
import { claim, enqueue } from "../apps/cloud/src/store";

async function setup(t: TestContext) {
  const s = await productionModelFixture(t);
  const thread = (
    await s.request("/api/user/threads", { modelId: "model_test", taskId: s.run.taskId })
  ).data;
  s.sql.prepare("UPDATE runs SET thread_id=? WHERE id=?").run(thread.id, s.run.id);
  return { ...s, thread };
}

test("撤回与加密回复分离，取消已缓存正文的运行，后续运行只读占位而保留正常授权回复", async (t) => {
  const s = await setup(t),
    revoked = "synthetic-withdrawn-secret",
    allowed = "synthetic-authorized-reply";
  for (const [id, content] of [
    ["withdrawn", revoked],
    ["authorized", allowed],
  ])
    await appendMessage(s.env, s.thread.id, {
      id,
      role: "user",
      source: "user",
      content,
      private: true,
      runId: s.run.id,
    });
  await appendMessage(s.env, s.thread.id, {
    id: "derived-reply",
    source: "cloud",
    content: "旧答复复述：" + revoked,
    parts: [{ type: "tool", name: "act", result: "工具回显：" + revoked }],
  });
  s.sql
    .prepare(
      "UPDATE task_versions SET definition=json_set(definition,'$.goal',?,'$.executionOutline',json_array(?)) WHERE task_id=? AND version=1",
    )
    .run(revoked, revoked, s.run.taskId);
  const contextPath = `/api/runner/runs/${s.run.id}/context`;
  assert.ok(
    (await s.request(contextPath, { epoch: s.run.leaseEpoch })).data.messages.some(
      (m: { content: string }) => m.content === revoked,
    ),
  );
  const route = `/api/user/threads/${s.thread.id}/messages/withdrawn/private`;
  assert.equal((await s.request(route, {})).status, 200);
  assert.equal((await s.request(route, {})).status, 200);
  assert.equal(
    s.sql.prepare("SELECT cancel_requested FROM runs WHERE id=?").get(s.run.id)!.cancel_requested,
    1,
  );
  assert.equal(
    (await s.request(contextPath, { epoch: s.run.leaseEpoch })).data.error,
    "CANCEL_REQUESTED",
  );
  assert.equal(
    (
      await s.request(`/api/runner/runs/${s.run.id}/model`, {
        epoch: s.run.leaseEpoch,
        requestId: "cached-secret",
        messages: [{ role: "user", content: revoked }],
      })
    ).data.error,
    "CANCEL_REQUESTED",
  );
  assert.equal(
    (
      await s.request(`/api/runner/runs/${s.run.id}/tool`, {
        epoch: s.run.leaseEpoch,
        id: "stale-action",
        phase: "start",
        digest: "stale-action",
      })
    ).data.error,
    "CANCEL_REQUESTED",
  );
  assert.equal(
    (
      await s.request(`/api/runner/runs/${s.run.id}/messages`, {
        epoch: s.run.leaseEpoch,
        id: "late-derived",
        content: "迟到回复复述：" + revoked,
      })
    ).status,
    200,
  );
  assert.equal(s.jobs(), 0);
  assert.equal(
    (await s.request(`/api/user/tasks/${s.run.taskId}/run`, { requestId: "old-snapshot" })).data
      .error,
    "TASK_CONTEXT_WITHDRAWN",
  );
  assert.equal(
    (await s.request(`/api/user/tasks/${s.run.taskId}/state`, { enabled: true })).data.error,
    "TASK_CONTEXT_WITHDRAWN",
  );
  const page = (await s.request(`/api/user/threads/${s.thread.id}`, undefined, "GET")).data;
  assert.equal(page.messages.find((m: { id: string }) => m.id === "withdrawn").content, revoked);
  assert.ok(
    JSON.stringify(
      page.messages.find((m: { id: string }) => m.id === "derived-reply").parts,
    ).includes(revoked),
  );
  assert.equal(
    (
      await s.request(`/api/runner/runs/${s.run.id}/finish`, {
        epoch: s.run.leaseEpoch,
        status: "cancelled",
        result: { summary: "停止旧执行", outcome: "stopped", evidence: [] },
      })
    ).status,
    200,
  );
  await assert.rejects(
    enqueue(s.db, s.run.task, "old-snapshot"),
    /TASK_CONTEXT_OR_VERSION_CHANGED/,
  );
  assert.equal(
    (await s.request(`/api/runner/runs/${s.run.id}/browser-closed`, { epoch: s.run.leaseEpoch }))
      .status,
    200,
  );
  s.replies(
    JSON.stringify({
      reply: "新目标已交办",
      start: true,
      title: "新目标",
      goal: "仅读取新页面",
      entryUrl: "https://example.com/",
      accountId: null,
      executionOutline: ["仅读取页面"],
    }),
  );
  assert.equal(
    (
      await s.request(`/api/user/threads/${s.thread.id}/messages`, {
        requestId: "fresh-plan",
        content: "请仅读取新的页面。",
      })
    ).data.status,
    "done",
  );
  assert.ok(!JSON.stringify(s.requests).includes(revoked));
  assert.equal(
    s.sql.prepare("SELECT context_withdrawn FROM tasks WHERE id=?").get(s.run.taskId)!
      .context_withdrawn,
    0,
  );
  const next = (await claim(s.db, "device_test", "after-withdrawal"))!;
  assert.equal(next.task.version, 2);
  assert.ok(!JSON.stringify(next.task).includes(revoked));
  const future = await conversationContext(s.env, s.thread.id, 0, { runId: next.id });
  assert.ok(!JSON.stringify(future).includes(revoked));
  assert.equal(future.find((m) => m.id === "authorized")!.content, allowed);
});

test("撤回迁移识别旧仅本人可见记录，兼容正常加密回复并停止旧运行和命令", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    const migrations = new URL("../scripts/db/legacy-schema/", import.meta.url);
    for (const file of readdirSync(migrations)
      .filter((name) => /^00(?:0\d|1\d|20)_.*\.sql$/.test(name))
      .sort())
      sql.exec(readFileSync(new URL(file, migrations), "utf8"));
    sql.exec(`
      INSERT INTO tasks(id,version,definition,status,created_at,updated_at) VALUES('old-task',1,'{}','active','2026-01-01','2026-01-01');
      INSERT INTO ai_threads(id,user_id,kind,model_id,model_version,created_at,updated_at) VALUES
        ('private-thread','legacy_owner','chat','fixture',1,'2026-01-01','2026-01-01'),
        ('reply-thread','legacy_owner','chat','fixture',1,'2026-01-01','2026-01-01');
      UPDATE ai_threads SET task_id='old-task',active_turn='old-turn',draft='{"goal":"private-derived"}',summary='private-derived' WHERE id='private-thread';
      INSERT INTO ai_messages(id,thread_id,seq,role,content,turn_id,at,private_content) VALUES
        ('old','private-thread',1,'user','[用户已将这条内容设为仅本人可见]','old-turn','2026-01-01','cipher'),
        ('derived','private-thread',2,'assistant','private-derived','old-turn','2026-01-01',NULL),
        ('reply','reply-thread',1,'user','[用户已提供私密信息]','reply-turn','2026-01-01','cipher');
      INSERT INTO runs(id,task_id,task_snapshot,status,scheduled_for,deadline,account_key,idempotency_key,created_at,updated_at,thread_id) VALUES
        ('old-run','old-task','{}','running','2026-01-01','2099-01-01','old-account','old-key','2026-01-01','2026-01-01','private-thread'),
        ('reply-run','old-task','{}','running','2026-01-01','2099-01-01','reply-account','reply-key','2026-01-01','2026-01-01','reply-thread');
      INSERT INTO conversation_commands(id,thread_id,run_task,state,created_at) VALUES('old-command','private-thread','{}','committed','2026-01-01');
      INSERT INTO ai_turns(id,thread_id,request_id,digest,version,status,result,created_at,updated_at) VALUES('old-turn','private-thread','old-request','digest',1,'running','private-derived','2026-01-01','2026-01-01');
      INSERT INTO ai_graph_inputs(owner,id,digest,parent_thread,parent_turn,created_at) VALUES('legacy_owner','old-graph','digest','private-thread','old-turn','2026-01-01');
      INSERT INTO ai_dispatch(id,graph_id,thread_id,owner,kind,turn_id,state,created_at) VALUES('old-event','old-graph','private-thread','legacy_owner','chat','old-turn','running','2026-01-01');
      INSERT INTO ai_checkpoints(owner,thread,ns,id,checkpoint,metadata,at) VALUES('legacy_owner','old-graph','','checkpoint','private-derived','{}','2026-01-01');
      INSERT INTO ai_writes(owner,thread,ns,checkpoint,task,path,idx,channel,value) VALUES('legacy_owner','old-graph','','checkpoint','task','',0,'output','private-derived');
      INSERT INTO ai_calls(id,user_id,graph_id,digest,status,result,created_at,updated_at) VALUES('old-call','legacy_owner','old-graph','digest','done','private-derived','2026-01-01','2026-01-01');
    `);
    sql.exec(
      readFileSync(
        new URL("../scripts/db/legacy-schema/0021_context_withdrawal.sql", import.meta.url),
        "utf8",
      ),
    );
    assert.equal(
      sql.prepare("SELECT context_withdrawn FROM ai_messages WHERE id='old'").get()!
        .context_withdrawn,
      1,
    );
    assert.equal(
      sql.prepare("SELECT context_withdrawn FROM ai_messages WHERE id='reply'").get()!
        .context_withdrawn,
      0,
    );
    assert.equal(
      sql.prepare("SELECT cancel_requested FROM runs WHERE thread_id='private-thread'").get()!
        .cancel_requested,
      1,
    );
    assert.equal(
      sql.prepare("SELECT cancel_requested FROM runs WHERE thread_id='reply-thread'").get()!
        .cancel_requested,
      0,
    );
    assert.equal(sql.prepare("SELECT run_task FROM conversation_commands").get()!.run_task, null);
    assert.equal(
      sql.prepare("SELECT context_withdrawn FROM ai_messages WHERE id='derived'").get()!
        .context_withdrawn,
      1,
    );
    assert.equal(sql.prepare("SELECT context_withdrawn FROM tasks").get()!.context_withdrawn, 1);
    assert.equal(sql.prepare("SELECT active FROM ai_graph_inputs").get()!.active, 0);
    assert.equal(sql.prepare("SELECT generation FROM ai_graph_inputs").get()!.generation, 1);
    assert.equal(sql.prepare("SELECT state FROM ai_dispatch").get()!.state, "retired");
    assert.equal(sql.prepare("SELECT status FROM ai_turns").get()!.status, "cancelled");
    assert.equal(
      sql.prepare("SELECT active_turn FROM ai_threads WHERE id='private-thread'").get()!
        .active_turn,
      null,
    );
    assert.equal(
      sql.prepare("SELECT draft FROM ai_threads WHERE id='private-thread'").get()!.draft,
      null,
    );
    assert.equal(sql.prepare("SELECT COUNT(*) n FROM ai_checkpoints").get()!.n, 0);
    assert.equal(sql.prepare("SELECT COUNT(*) n FROM ai_writes").get()!.n, 0);
    assert.equal(sql.prepare("SELECT result FROM ai_calls").get()!.result, null);
    assert.deepEqual(sql.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    sql.close();
  }
});

test("待交接命令读出后删除聊天，不再排队且不能改挂到新聊天", async (t) => {
  const s = await setup(t);
  s.sql.exec("UPDATE runs SET status='succeeded'; DELETE FROM account_locks");
  s.sql
    .prepare(
      "INSERT INTO conversation_commands(id,thread_id,task_id,run_task,state,created_at) VALUES('pending-delete',?,?,?,'committed',?)",
    )
    .run(s.thread.id, s.run.taskId, JSON.stringify(s.run.task), dbTime(new Date().toISOString()));
  let release!: () => void, selected!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      selected = resolve;
    });
  const prepare = s.db.prepare.bind(s.db);
  t.mock.method(s.db, "prepare", (query: string) => {
    const statement = prepare(query);
    if (query.startsWith("SELECT * FROM conversation_commands WHERE")) {
      const all = statement.all.bind(statement);
      t.mock.method(statement, "all", async () => {
        const value = await all();
        selected();
        await gate;
        return value;
      });
    }
    return statement;
  });
  const draining = drainCommands(s.env);
  await ready;
  assert.equal((await s.request(`/api/user/threads/${s.thread.id}`, {}, "DELETE")).status, 200);
  const replacement = (
    await s.request("/api/user/threads", { modelId: "model_test", taskId: s.run.taskId })
  ).data;
  assert.notEqual(replacement.id, s.thread.id);
  release();
  await draining;
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM runs WHERE status='queued'").get()!.n, 0);
  assert.equal(await claim(s.db, "device_test", "deleted-command"), null);
});

const png = fixturePng.toString("base64");
test("相同截图并发请求各自拥有暂存对象，冲突仅清理落败对象并返回同一图片", async (t) => {
  const s = await setup(t),
    images = new Map<string, ArrayBuffer>();
  let release!: () => void,
    puts = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  s.env.EVIDENCE_STORE = {
    getByName: (key: string) => ({
      put: async (_key: string, bytes: ArrayBuffer, expires: number | null, pending: boolean) => {
        assert.equal(expires, null);
        assert.equal(pending, true);
        images.set(key, bytes);
        if (++puts === 2) release();
        await gate;
      },
      remove: async () => {
        images.delete(key);
      },
      get: async () => images.get(key) ?? null,
    }),
  } as unknown as typeof s.env.EVIDENCE_STORE;
  const path = `/api/runner/runs/${s.run.id}/snapshots`,
    body = { epoch: s.run.leaseEpoch, captureId: "overlap", image: png };
  const results = await Promise.all([s.request(path, body), s.request(path, body)]);
  assert.deepEqual(
    results.map((result) => result.status),
    [200, 200],
  );
  assert.deepEqual(results[0].data, results[1].data);
  const artifact = s.sql.prepare("SELECT object_key FROM artifacts").get()!;
  assert.equal(images.size, 1);
  assert.ok(images.has(String(artifact.object_key)));
  assert.equal((await s.request(path, body)).status, 200);
  assert.equal(puts, 2);
});

test("截图写入索引的响应丢失不删除可能已发布的对象，重试可读取原图片", async (t) => {
  const s = await setup(t),
    images = new Map<string, ArrayBuffer>();
  s.env.EVIDENCE_STORE = {
    getByName: (key: string) => ({
      put: async (_key: string, bytes: ArrayBuffer) => {
        images.set(key, bytes);
      },
      remove: async () => {
        images.delete(key);
      },
      get: async () => images.get(key) ?? null,
    }),
  } as unknown as typeof s.env.EVIDENCE_STORE;
  const prepare = s.db.prepare.bind(s.db);
  let fail = true;
  t.mock.method(s.db, "prepare", (query: string) => {
    const statement = prepare(query);
    if (query.startsWith("INSERT OR IGNORE INTO artifacts")) {
      const run = statement.run.bind(statement);
      t.mock.method(statement, "run", async () => {
        const result = await run();
        if (fail) {
          fail = false;
          throw Error("lost database response");
        }
        return result;
      });
    }
    return statement;
  });
  const path = `/api/runner/runs/${s.run.id}/snapshots`,
    body = { epoch: s.run.leaseEpoch, captureId: "uncertain-index", image: png };
  assert.equal((await s.request(path, body)).status, 500);
  assert.equal(images.size, 1);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM artifacts").get()!.n, 1);
  assert.equal((await s.request(path, body)).status, 200);
  assert.equal(images.size, 1);
});

test("截图暂存后删除聊天，迟到上传不发布并清理自己的对象", async (t) => {
  const s = await setup(t),
    images = new Map<string, ArrayBuffer>();
  let release!: () => void, uploaded!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      uploaded = resolve;
    });
  s.env.EVIDENCE_STORE = {
    getByName: (key: string) => ({
      put: async (_key: string, bytes: ArrayBuffer) => {
        images.set(key, bytes);
        uploaded();
        await gate;
      },
      remove: async () => {
        images.delete(key);
      },
    }),
  } as unknown as typeof s.env.EVIDENCE_STORE;
  const upload = s.request(`/api/runner/runs/${s.run.id}/snapshots`, {
    epoch: s.run.leaseEpoch,
    captureId: "late-upload",
    image: png,
  });
  await ready;
  assert.equal((await s.request(`/api/user/threads/${s.thread.id}`, {}, "DELETE")).status, 200);
  release();
  assert.equal((await upload).status, 404);
  assert.equal(images.size, 0);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM artifacts").get()!.n, 0);
});

test("暂存对象已由alarm退休时，迟到索引发布不能引用已回收对象", async (t) => {
  const s = await setup(t),
    images = new Map<string, ArrayBuffer>();
  s.env.EVIDENCE_STORE = {
    getByName: (key: string) => ({
      put: async (_key: string, bytes: ArrayBuffer) => {
        images.set(key, bytes);
        // 注入生产alarm完成退休后、原上传请求才继续的跨存储顺序。
        s.sql
          .prepare("INSERT INTO evidence_retirements(object_key,retired_at) VALUES(?,?)")
          .run(key, dbTime(new Date().toISOString()));
        images.delete(key);
      },
      remove: async () => {
        images.delete(key);
      },
    }),
  } as unknown as typeof s.env.EVIDENCE_STORE;
  const result = await s.request(`/api/runner/runs/${s.run.id}/snapshots`, {
    epoch: s.run.leaseEpoch,
    captureId: "retired-upload",
    image: png,
  });
  assert.equal(result.status, 404);
  assert.equal(images.size, 0);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM artifacts").get()!.n, 0);
});
