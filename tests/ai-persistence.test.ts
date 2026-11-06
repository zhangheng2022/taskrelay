import { drainHistoryCleanups } from "../apps/cloud/src/history-cleanup";
import test from "node:test";
import assert from "node:assert/strict";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { HumanMessage } from "@langchain/core/messages";
import { D1Checkpointer } from "../apps/cloud/src/ai/checkpointer";
import { D1MemoryStore } from "../apps/cloud/src/ai/memory";
import { planConversation } from "../apps/cloud/src/ai/planning-graph";
import { invoke } from "../apps/cloud/src/models";
import { retainHistory } from "../apps/cloud/src/ai/lifecycle";
import { testDb } from "./helpers";
import { productionModelFixture } from "./production-model-fixture";
const secret = Buffer.alloc(32, 3).toString("base64");

test("D1 saver 保留消息类型、父检查点、命名空间和 pending writes；按 owner 隔离", async (t) => {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  const saver = new D1Checkpointer(db, "legacy_owner", secret),
    config = { configurable: { thread_id: "thread", checkpoint_ns: "branch" } };
  const cp = emptyCheckpoint();
  cp.id = "0001";
  cp.channel_values = { messages: [new HumanMessage("私有历史")] };
  const one = await saver.put(config, cp, {
    source: "input",
    step: 0,
    parents: {},
  });
  await saver.putWrites(one, [["result", "first"]], "task-b", "2");
  await saver.putWrites(one, [["result", "must-not-replace"]], "task-b", "2");
  await saver.putWrites(one, [["result", "earlier"]], "task-a", "1");
  const restored = await saver.getTuple(one);
  assert.equal((restored!.checkpoint.channel_values.messages as HumanMessage[])[0].type, "human");
  assert.deepEqual(restored!.pendingWrites, [
    ["task-a", "result", "earlier"],
    ["task-b", "result", "first"],
  ]);
  const two = await saver.put(one, { ...cp, id: "0002" }, { source: "loop", step: 1, parents: {} });
  assert.equal((await saver.getTuple(two))!.parentConfig!.configurable!.checkpoint_id, "0001");
  assert.equal(await saver.getTuple({ configurable: { thread_id: "thread" } }), undefined);
  assert.equal(await new D1Checkpointer(db, "other", secret).getTuple(one), undefined);
  const listed = [];
  for await (const item of saver.list(config, { before: two, limit: 1 }))
    listed.push(item.checkpoint.id);
  assert.deepEqual(listed, ["0001"]);
  assert.ok(
    !JSON.stringify(sql.prepare("SELECT * FROM ai_checkpoints").all()).includes("私有历史"),
  );
  await saver.deleteThread("thread");
  assert.equal(await saver.getTuple(config), undefined);
});

test("D1 store 加密持久化、过滤、更新删除、namespace 与 owner 隔离，不假装支持语义检索", async (t) => {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  const store = new D1MemoryStore(db, "legacy_owner", secret);
  await store.put(["preferences"], "one", { text: "用中文", rank: 2 });
  await store.put(["preferences", "style"], "two", { text: "简洁", rank: 1 });
  assert.equal((await store.get(["preferences"], "one"))!.value.text, "用中文");
  assert.equal((await store.search(["preferences"], { filter: { rank: { $gt: 1 } } })).length, 1);
  assert.equal((await new D1MemoryStore(db, "another", secret).search(["preferences"])).length, 0);
  assert.ok(!JSON.stringify(sql.prepare("SELECT * FROM ai_memories").all()).includes("用中文"));
  assert.deepEqual(await store.listNamespaces({ prefix: ["preferences"], maxDepth: 1 }), [
    ["preferences"],
  ]);
  await assert.rejects(() => store.search(["preferences"], { query: "style" }), /MEMORY_SEMANTIC/);
  await store.delete(["preferences"], "one");
  assert.equal(await store.get(["preferences"], "one"), null);
});

test("真实 graph 从 D1 恢复终态不再调用模型，改变输入拒绝；模型 unknown 不重放", async (t) => {
  const s = await productionModelFixture(t);
  s.env.requestUserId = "legacy_owner";
  s.replies('{"reply":"持久化结果"}');
  const thread = (await s.request("/api/user/threads", { modelId: "model_test" })).data;
  const scope = {
    env: s.env,
    owner: "legacy_owner",
    id: "graph_test",
    threadId: thread.id,
    kind: "chat" as const,
    guard: async () => {},
  };
  const profile = { model_id: "model_test", model_version: 1 };
  const messages = [{ role: "user" as const, content: "你好" }];
  assert.equal((await planConversation(scope, profile, messages)).reply, "持久化结果");
  assert.equal((await planConversation(scope, profile, messages)).reply, "持久化结果");
  assert.equal(s.jobs(), 1);
  await assert.rejects(
    () => planConversation(scope, profile, [{ role: "user", content: "替换" }]),
    /GRAPH_INPUT_CONFLICT/,
  );
  s.replies(new Error("MODEL_CALL_OUTCOME_UNKNOWN"));
  const call = () =>
    invoke(
      s.env,
      "model_test",
      1,
      { messages: [{ role: "user", content: "test" }] },
      null,
      "stable_call",
    );
  await assert.rejects(call);
  await assert.rejects(call, /MODEL_CALL_OUTCOME_UNKNOWN/);
  assert.equal(s.jobs(), 2);
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM quota_reservations WHERE id='stable_call'").get()!.n,
    1,
  );
});

test("超过200条历史完整分页；未接入执行的偏好变更不影响对话，删除会话后不能回填", async (t) => {
  const s = await productionModelFixture(t);
  s.sql.exec("UPDATE runs SET status='succeeded'");
  const th = (
    await s.request("/api/user/threads", {
      modelId: "model_test",
      taskId: s.run.taskId,
    })
  ).data;
  for (let i = 1; i <= 205; i++)
    s.sql
      .prepare(
        "INSERT INTO ai_messages(id,thread_id,seq,role,content,turn_id,at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        "m" + i,
        th.id,
        i,
        i % 2 ? "user" : "assistant",
        "history " + i,
        "seed",
        new Date().toISOString(),
      );
  const collected: number[] = [];
  let cursor: number | null = null;
  do {
    const page: any = (
      await s.request(
        "/api/user/threads/" + th.id + (cursor ? "?before=" + cursor : ""),
        undefined,
        "GET",
      )
    ).data;
    collected.push(...page.messages.map((m: any) => m.seq));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(new Set(collected).size, 205);
  assert.ok(collected.includes(1));
  s.sql.prepare("DELETE FROM ai_messages WHERE thread_id=?").run(th.id);
  s.replies('{"reply":"一条回答"}');
  assert.equal(
    (
      await s.request(`/api/user/threads/${th.id}/messages`, {
        requestId: "one",
        content: "你好",
      })
    ).data.status,
    "done",
  );
  assert.ok((s.sql.prepare("SELECT COUNT(*) n FROM ai_checkpoints").get()!.n as number) > 0);
  const checkpointCount = s.sql.prepare("SELECT COUNT(*) n FROM ai_checkpoints").get()!.n;
  const resultCount = s.sql
    .prepare("SELECT COUNT(*) n FROM ai_calls WHERE result IS NOT NULL")
    .get()!.n;
  assert.equal(
    (await s.request("/api/user/memories/preference", { text: "使用中文", confirmed: true }, "PUT"))
      .status,
    200,
  );
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ai_checkpoints").get()!.n, checkpointCount);
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM ai_calls WHERE result IS NOT NULL").get()!.n,
    resultCount,
  );
  const restored = (await s.request("/api/user/threads/" + th.id, undefined, "GET")).data;
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.version, 1);
  await s.request("/api/user/threads/" + th.id, undefined, "DELETE");
  for (let i = 0; i < 20; i++) if (!(await drainHistoryCleanups(s.env))) break;
  assert.equal((await s.request("/api/user/threads/" + th.id, undefined, "GET")).status, 404);
  assert.notEqual(
    (
      await s.request("/api/user/threads", {
        modelId: "model_test",
        taskId: s.run.taskId,
      })
    ).data.id,
    th.id,
  );
  const graph = s.sql.prepare("SELECT id FROM ai_graph_inputs LIMIT 1").get()!;
  const fenced = new D1Checkpointer(s.db, "legacy_owner", s.env.MASTER_KEY, async () => {}, true);
  await assert.rejects(
    () =>
      fenced.put({ configurable: { thread_id: graph.id } }, emptyCheckpoint(), {
        source: "input",
        step: 0,
        parents: {},
      }),
    /GRAPH_STALE/,
  );
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ai_checkpoints").get()!.n, 0);
});

test("并发同一消息只执行一次，另一消息不能抢占 active turn", async (t) => {
  const s = await productionModelFixture(t);
  s.sql.exec("UPDATE runs SET status='succeeded'");
  const th = (
    await s.request("/api/user/threads", {
      modelId: "model_test",
      taskId: s.run.taskId,
    })
  ).data;
  s.replies('{"reply":"唯一回复"}');
  const body = { requestId: "same", content: "你好" };
  const results = await Promise.all([
    s.request(`/api/user/threads/${th.id}/messages`, body),
    s.request(`/api/user/threads/${th.id}/messages`, body),
    s.request(`/api/user/threads/${th.id}/messages`, {
      ...body,
      requestId: "different",
    }),
  ]);
  assert.equal(s.jobs(), 1);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ai_messages").get()!.n, 2);
  assert.ok(results.some((r) => r.data.status === "done"));
  assert.equal(results[2].data.status, "queued");
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM conversation_inbox WHERE status='pending'").get()!.n,
    1,
  );
});

test("保留策略删除正文和派生结果，但保留请求墓碑阻止重放", async (t) => {
  const s = await productionModelFixture(t);
  const th = (
    await s.request("/api/user/threads", {
      modelId: "model_test",
    })
  ).data;
  await s.request(`/api/user/threads/${th.id}/messages`, {
    requestId: "one",
    content: "你好",
  });
  await retainHistory(s.env, "2099-01-01");
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ai_messages").get()!.n, 0);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ai_turns").get()!.n, 1);
  assert.equal((await s.request("/api/user/threads/" + th.id, undefined, "GET")).status, 404);
});
