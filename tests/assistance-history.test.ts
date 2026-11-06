import test from "node:test";
import assert from "node:assert/strict";
import { productionModelFixture } from "./production-model-fixture";
import { seal } from "../apps/cloud/src/crypto";

test("加密协助历史独立分页，清理保留期同时清理密文", async (t) => {
  const s = await productionModelFixture(t);
  const thread = (
    await s.request("/api/user/threads", { modelId: "model_test", taskId: s.run.task.id })
  ).data;
  const insert = s.sql.prepare(
    "INSERT INTO challenges(id,run_id,lease_epoch,version,step_id,kind,instruction,target,status,expires_at) VALUES(?,?,1,1,?,'information','测试','#field','consumed','2099-01-01')",
  );
  for (let i = 0; i < 51; i++) {
    const id = "fixture_" + i;
    insert.run(id, s.run.id, id);
    s.sql
      .prepare(
        "INSERT INTO assistance_replies(challenge_id,run_id,thread_id,content_secret,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        id,
        s.run.id,
        thread.id,
        await seal("fixture-" + i, s.env.MASTER_KEY, `assistance:${id}`),
        "2026-11-04T01:00:00Z",
      );
  }
  const page = (await s.request(`/api/user/threads/${thread.id}`, undefined, "GET")).data;
  assert.equal(page.replies.length, 50);
  const older = (
    await s.request(
      `/api/user/threads/${thread.id}?beforeReply=${page.nextReplyCursor}`,
      undefined,
      "GET",
    )
  ).data;
  assert.equal(older.replies.length, 1);
  assert.equal(older.replies[0].content, "fixture-0");
  const { retainHistory } = await import("../apps/cloud/src/ai/lifecycle");
  await retainHistory(s.env, "2099-01-01");
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM assistance_replies").get()!.n, 0);
});

test("已误发普通聊天的内容可转为本人可见，后续模型只能读取占位内容", async (t) => {
  const s = await productionModelFixture(t);
  const thread = (
    await s.request("/api/user/threads", { modelId: "model_test", taskId: s.run.task.id })
  ).data;
  const secret = "fake-old-password-OnlyTest";
  s.sql
    .prepare(
      "INSERT INTO ai_messages(id,thread_id,seq,role,content,turn_id,at) VALUES('private_test',?,1,'user',?,'old_turn','2026-11-04')",
    )
    .run(thread.id, secret);
  s.sql.prepare("UPDATE ai_threads SET summary=?,version=1 WHERE id=?").run(secret, thread.id);
  const result = await s.request(
    `/api/user/threads/${thread.id}/messages/private_test/private`,
    {},
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const raw = s.sql
    .prepare("SELECT content,private_content FROM ai_messages WHERE id='private_test'")
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
