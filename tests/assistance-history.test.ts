import { seedMessage } from "./helpers";
import test from "node:test";
import assert from "node:assert/strict";
import { productionModelFixture } from "./production-model-fixture";
import { seal } from "../apps/cloud/src/crypto";

test("加密协助与普通消息共用 seq 分页，保留期清理正文和密文", async (t) => {
  const s = await productionModelFixture(t),
    thread = (await s.request("/api/user/threads", { modelId: "model_test", taskId: s.run.taskId }))
      .data;
  for (let i = 1; i <= 51; i++)
    seedMessage(s.sql, {
      id: "reply_" + i,
      thread_id: thread.id,
      seq: i,
      role: "user",
      content: "[私密回复]",
      private_content: await seal(
        "fixture-" + i,
        s.env.MASTER_KEY,
        `message:${thread.id}:reply_${i}`,
      ),
      turn_id: "history",
      at: Date.now(),
    });
  const page = (await s.request(`/api/user/threads/${thread.id}`, undefined, "GET")).data;
  assert.equal(page.messages.length, 50);
  assert.equal(page.nextReplyCursor, undefined);
  const older = (
    await s.request(`/api/user/threads/${thread.id}?before=${page.nextCursor}`, undefined, "GET")
  ).data;
  assert.equal(older.messages.length, 1);
  assert.equal(older.messages[0].content, "fixture-1");
  const { retainHistory } = await import("../apps/cloud/src/ai/lifecycle");
  await retainHistory(s.env, "2099-01-01");
  assert.equal(s.sql.prepare("SELECT count(*) n FROM message_bodies").get()!.n, 0);
});

test("已误发普通聊天的内容可转为本人可见，后续模型只能读取占位内容", async (t) => {
  const s = await productionModelFixture(t);
  const thread = (
    await s.request("/api/user/threads", { modelId: "model_test", taskId: s.run.task.id })
  ).data;
  const secret = "fake-old-password-OnlyTest";
  seedMessage(s.sql, {
    id: "private_test",
    thread_id: thread.id,
    seq: 1,
    role: "user",
    content: secret,
    turn_id: "old_turn",
    at: "2026-11-04",
  });
  s.sql.prepare("UPDATE ai_threads SET summary=?,version=1 WHERE id=?").run(secret, thread.id);
  const result = await s.request(
    `/api/user/threads/${thread.id}/messages/private_test/private`,
    {},
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const raw = s.sql
    .prepare("SELECT content,private_content FROM message_details WHERE id='private_test'")
    .get()!;
  assert.ok(!JSON.stringify(raw).includes(secret));
  assert.equal(
    s.sql.prepare("SELECT summary FROM ai_threads WHERE id=?").get(thread.id)!.summary,
    "",
  );
  const page = (await s.request(`/api/user/threads/${thread.id}`, undefined, "GET")).data;
  assert.equal(page.messages[0].content, secret);
  assert.equal(page.messages[0].private, true);
  s.sql.exec("UPDATE runs SET status='succeeded'");
  s.replies(
    JSON.stringify({
      reply: "等待执行。",
      operation: "respond",
      scope: "current",
      startWhen: "now",
      task: null,
    }),
  );
  assert.equal(
    (
      await s.request(`/api/user/threads/${thread.id}/messages`, {
        requestId: "after-private",
        content: "查看当前进展",
      })
    ).data.status,
    "done",
  );
  assert.ok(!JSON.stringify(s.requests).includes(secret));
});
