import test from "node:test";
import assert from "node:assert/strict";
import { productionModelFixture } from "./production-model-fixture";
import { appendMessage, conversationContext } from "../apps/cloud/src/chat-messages";
import { retainHistory } from "../apps/cloud/src/ai/lifecycle";

test("运行补充写入时即加密；维护不依赖旧 backfill 标记，本人和当前执行器仍可读取", async (t) => {
  const s = await productionModelFixture(t),
    thread = (await s.request("/api/user/threads", { modelId: "model_test", taskId: s.run.taskId }))
      .data;
  s.sql.prepare("UPDATE runs SET thread_id=? WHERE id=?").run(thread.id, s.run.id);
  const original = '00early! "空 格"';
  await appendMessage(s.env, thread.id, {
    id: "private_input",
    role: "user",
    source: "user",
    runId: s.run.id,
    content: original,
  });
  const raw = s.sql.prepare("SELECT * FROM message_details WHERE id='private_input'").get()!;
  assert.ok(raw.private_content);
  assert.ok(!JSON.stringify(raw).includes("00early!"));
  const context = await conversationContext(s.env, thread.id, 0, { runId: s.run.id });
  assert.equal(context[0].content, original);
  const page = (await s.request(`/api/user/threads/${thread.id}`, undefined, "GET")).data;
  assert.equal(page.messages[0].content, original);
  await retainHistory(s.env, "2000-01-01T00:00:00Z");
  assert.equal(
    s.sql.prepare("SELECT key FROM settings WHERE key='chatInputProtectionBackfillV1'").get(),
    undefined,
  );
  assert.deepEqual(
    s.sql.prepare("SELECT * FROM message_details WHERE id='private_input'").get(),
    raw,
  );
});
