import test from "node:test";
import assert from "node:assert/strict";
import { productionModelFixture } from "./production-model-fixture";
import { dispatchGraphEvent } from "../apps/cloud/src/ai/dispatch";
import { retainHistory } from "../apps/cloud/src/ai/lifecycle";
import { D1Checkpointer } from "../apps/cloud/src/ai/checkpointer";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";

async function setup(t: Parameters<typeof productionModelFixture>[0]) {
  const s = await productionModelFixture(t);
  const thread = (
    await s.request("/api/user/threads", {
      modelId: "model_test",
      taskId: s.run.taskId,
    })
  ).data;
  s.sql.prepare("UPDATE runs SET thread_id=? WHERE id=?").run(thread.id, s.run.id);
  const help = {
    epoch: s.run.leaseEpoch,
    id: "durable_help",
    origin: "https://example.com",
    message: "需要哪项登录信息？",
  };
  const path = `/api/runner/runs/${s.run.id}/help`;
  return { ...s, thread, help, path };
}
const answer = (message: string, askUser = false) =>
  JSON.stringify({ message, askUser, accountId: null });

test("协助请求只持久入队，alarm暂停后靠加密原回复恢复，重启和重复消息不重复调用", async (t) => {
  const s = await setup(t),
    wakes: string[] = [];
  s.env.AI_TURNS = {
    getByName: (id: string) => ({
      enqueue: async () => {
        wakes.push(id);
      },
    }),
  } as unknown as typeof s.env.AI_TURNS;
  assert.deepEqual((await s.request(s.path, s.help)).data, { ready: false });
  assert.deepEqual((await s.request(s.path, s.help)).data, { ready: false });
  assert.equal(s.jobs(), 0);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ai_dispatch").get()!.n, 1);
  const graphId = wakes[0];
  s.replies(answer("请提供登录信息。", true));
  await dispatchGraphEvent(s.env, graphId);
  assert.equal(s.jobs(), 1);
  assert.equal(
    s.sql.prepare("SELECT status FROM ai_graph_inputs WHERE id=?").get(graphId)!.status,
    "waiting",
  );
  assert.ok(s.sql.prepare("SELECT interrupt_id FROM execution_help").get()!.interrupt_id);
  s.sql.prepare("UPDATE ai_graph_inputs SET created_at='2000-01-01' WHERE id=?").run(graphId);
  await retainHistory(s.env, "1990-01-01");
  assert.equal(
    s.sql.prepare("SELECT status FROM ai_graph_inputs WHERE id=?").get(graphId)!.status,
    "waiting",
  );
  assert.equal(await dispatchGraphEvent(s.env, graphId), false);
  const reply = {
    requestId: "original_reply",
    content: "密码为 00aB! test，先确认是否支持短信。",
  };
  await s.request(`/api/user/threads/${s.thread.id}/messages`, reply);
  assert.equal(s.jobs(), 1);
  assert.ok(!JSON.stringify(s.sql.prepare("SELECT * FROM ai_dispatch").all()).includes("00aB!"));
  s.replies(answer("保留完整原话，由执行器确认短信登录。"));
  await dispatchGraphEvent({ ...s.env }, graphId);
  assert.equal((await s.request(s.path, s.help)).data.ready, true);
  assert.equal(s.jobs(), 2);
  await s.request(`/api/user/threads/${s.thread.id}/messages`, reply);
  await dispatchGraphEvent(s.env, graphId);
  assert.equal(s.jobs(), 2);
  assert.ok(
    !JSON.stringify(s.sql.prepare("SELECT checkpoint FROM ai_checkpoints").all()).includes("00aB!"),
  );
});

test("首次协助推理期间普通补充自动持久唤醒，不要求用户再回复一次", async (t) => {
  const s = await setup(t),
    original = "先查看短信登录，不要使用密码登录。";
  const provider = globalThis.fetch;
  let injected = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const response = await provider(input, init);
    if (!injected && String(input).startsWith("https://provider.example/")) {
      injected = true;
      const posted = await s.request(`/api/user/threads/${s.thread.id}/messages`, {
        requestId: "during_first_solve",
        content: original,
      });
      assert.equal(posted.status, 202);
      assert.equal(
        posted.data.messages.find((m: { content: string }) => m.content === original).reply_to,
        s.help.id,
      );
    }
    return response;
  });
  s.replies(answer("请提供密码。", true));
  assert.deepEqual((await s.request(s.path, s.help)).data, { ready: false });
  assert.equal(
    s.sql
      .prepare("SELECT COUNT(*) n FROM ai_dispatch WHERE kind='refresh' AND state='pending'")
      .get()!.n,
    1,
  );
  s.replies(answer("用户已改为短信登录，请按原话继续。"));
  assert.equal((await s.request(s.path, s.help)).data.ready, true);
  assert.equal(s.jobs(), 2);
  assert.match(JSON.stringify(s.requests.at(-1)!.body), /先查看短信登录/);
  assert.equal(s.sql.prepare("SELECT awaiting_user FROM execution_help").get()!.awaiting_user, 0);
});

test("协助unknown不重发，删除聊天清除持久等待和所有派生密文", async (t) => {
  const s = await setup(t);
  s.replies(new Error("MODEL_CALL_OUTCOME_UNKNOWN"));
  const first = await s.request(s.path, s.help);
  assert.equal(first.data.error, "MODEL_CALL_OUTCOME_UNKNOWN");
  assert.equal((await s.request(s.path, s.help)).data.error, "MODEL_CALL_OUTCOME_UNKNOWN");
  assert.equal(s.jobs(), 1);
  await s.request(`/api/user/threads/${s.thread.id}`, undefined, "DELETE");
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ai_checkpoints").get()!.n, 0);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ai_writes").get()!.n, 0);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM execution_help").get()!.n, 0);
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM ai_dispatch WHERE state IN ('running','pending')").get()!
      .n,
    0,
  );
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM ai_calls WHERE result IS NOT NULL").get()!.n,
    0,
  );
});

test("取消发生在checkpoint前置检查与写入之间时，D1原子fence拒绝旧写入", async (t) => {
  const s = await setup(t);
  s.replies(answer("请补充。", true));
  await s.request(s.path, s.help);
  const graph = s.sql.prepare("SELECT id,generation FROM ai_graph_inputs").get()!;
  const saver = new D1Checkpointer(
    s.db,
    "legacy_owner",
    s.env.MASTER_KEY,
    async () => {
      s.sql.prepare("UPDATE runs SET cancel_requested=1 WHERE id=?").run(s.run.id);
    },
    true,
    Number(graph.generation),
  );
  const cp = emptyCheckpoint();
  cp.id = "cancelled_write";
  await assert.rejects(
    saver.put({ configurable: { thread_id: graph.id } }, cp, {
      source: "input",
      step: 0,
      parents: {},
    }),
    /GRAPH_STALE/,
  );
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ai_checkpoints WHERE id=?").get(cp.id)!.n, 0);
});

test("协助问题写入失败时同事务回滚等待状态，不出现看不到问题的等待", async (t) => {
  const s = await setup(t);
  s.sql.exec(`CREATE TRIGGER fail_help_publication BEFORE INSERT ON ai_messages
    WHEN NEW.source='cloud' AND NEW.private_content IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'publication fixture failure'); END`);
  s.replies(answer("请提供验证码。", true));
  const response = await s.request(s.path, s.help);
  assert.equal(response.data.error, "AI_GRAPH_FAILED");
  assert.equal(s.sql.prepare("SELECT response FROM execution_help").get()!.response, null);
  assert.equal(s.sql.prepare("SELECT awaiting_user FROM execution_help").get()!.awaiting_user, 0);
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM ai_messages WHERE source='cloud'").get()!.n,
    0,
  );
});

test("正常最终回复的用户消息游标在收尾事务里检查，失配不释放租约与账号锁", async (t) => {
  const s = await setup(t);
  const message = await s.request(`/api/user/threads/${s.thread.id}/messages`, {
    requestId: "new_goal",
    content: "先查看另一页，再回复。",
  });
  const seq = message.data.messages.at(-1).seq;
  const result = {
    summary: "旧目标已读完。",
    outcome: "reported",
    evidence: [],
  };
  const body = {
    epoch: s.run.leaseEpoch,
    status: "succeeded",
    result,
    expectedUserSeq: 0,
  };
  const changed = await s.request(`/api/runner/runs/${s.run.id}/finish`, body);
  assert.equal(changed.data.error, "INSTRUCTIONS_CHANGED");
  const run = s.sql
    .prepare("SELECT status,lease_expires_at,result FROM runs WHERE id=?")
    .get(s.run.id)!;
  assert.equal(run.status, "running");
  assert.ok(run.lease_expires_at);
  assert.equal(run.result, null);
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM account_locks WHERE run_id=?").get(s.run.id)!.n,
    1,
  );
  const finished = await s.request(`/api/runner/runs/${s.run.id}/finish`, {
    ...body,
    expectedUserSeq: seq,
  });
  assert.equal(finished.status, 200);
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM account_locks WHERE run_id=?").get(s.run.id)!.n,
    1,
    "结果提交不等于浏览器退出",
  );
  const closed = await s.request(`/api/runner/runs/${s.run.id}/browser-closed`, {
    epoch: s.run.leaseEpoch,
  });
  assert.equal(closed.status, 200);
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM account_locks WHERE run_id=?").get(s.run.id)!.n,
    0,
  );
});
