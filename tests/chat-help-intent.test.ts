import { requestUrl } from "./http-fixture";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { productionModelFixture } from "./production-model-fixture";
import { appendMessage, conversationContext } from "../apps/cloud/src/chat-messages";
import { unseal } from "../apps/cloud/src/crypto";

async function setup(t: TestContext, protocol: "chat" | "responses" = "chat") {
  const s = await productionModelFixture(t, protocol);
  const thread = (
    await s.request("/api/user/threads", { modelId: "model_test", taskId: s.run.taskId })
  ).data;
  s.sql.prepare("UPDATE runs SET thread_id=? WHERE id=?").run(thread.id, s.run.id);
  return {
    ...s,
    thread,
    path: `/api/runner/runs/${s.run.id}/help`,
    help: {
      epoch: s.run.leaseEpoch,
      id: "help_context",
      origin: "https://example.com",
      message: "如何继续登录？",
    },
  };
}
const reply = (message: string, askUser = false) =>
  JSON.stringify({ message, askUser, accountId: null });

test("协助轮询只发布一次问题，回复后内部答案不回显，新一轮更正允许同文问题", async (t) => {
  const s = await setup(t);
  s.replies(reply("请提供有效密码。", true));
  const first = await s.request(s.path, s.help);
  assert.equal(first.data.questionRound, 0);
  await s.request(s.path, s.help);
  await s.request(s.path, s.help);
  const questions = () =>
    s.sql
      .prepare("SELECT id,content,private_content FROM message_details WHERE source='cloud'")
      .all();
  assert.equal(questions().length, 1);
  assert.ok(questions()[0].private_content);
  await s.request(`/api/user/threads/${s.thread.id}/messages`, {
    requestId: "password_one",
    content: "first-password",
  });
  assert.equal(questions().length, 1); // 没有额外“已收到”气泡。
  s.replies(reply("请提供有效密码。", true));
  await s.request(s.path, s.help);
  assert.equal(questions().length, 2);
  assert.notEqual(questions()[0].id, questions()[1].id);
  await s.request(`/api/user/threads/${s.thread.id}/messages`, {
    requestId: "password_two",
    content: "corrected-password",
  });
  s.replies(reply("现在可继续。"));
  assert.equal((await s.request(s.path, s.help)).data.ready, true);
  assert.equal(questions().length, 2);
});
test("协助模型尚未发布等待状态时，提前回复也加密并绑定当前来源", async (t) => {
  const s = await setup(t),
    original = "00early-password!";
  const providerFetch = globalThis.fetch;
  let inject = true;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const response = await providerFetch(input, init);
    if (inject && requestUrl(input).startsWith("https://provider.example/")) {
      inject = false;
      assert.equal(
        s.sql.prepare("SELECT awaiting_user FROM execution_help WHERE id=?").get(s.help.id)!
          .awaiting_user,
        0,
      );
      assert.equal(
        (
          await s.request(`/api/user/threads/${s.thread.id}/messages`, {
            requestId: "early_reply",
            content: original,
          })
        ).status,
        202,
      );
    }
    return response;
  });
  s.replies(reply("请提供密码。", true));
  assert.equal((await s.request(s.path, s.help)).data.ready, false);
  const stored = s.sql
    .prepare("SELECT * FROM message_details WHERE thread_id=? AND role='user'")
    .get(s.thread.id)!;
  assert.ok(stored.private_content);
  assert.equal(stored.reply_to, s.help.id);
  assert.ok(!JSON.stringify(stored).includes(original));
  const context = await conversationContext(s.env, s.thread.id, 0, { runId: s.run.id });
  assert.ok(context.some((m) => m.content === original && m.private && m.origin === s.help.origin));
  s.replies(reply("已收到密码，继续。"));
  assert.equal((await s.request(s.path, s.help)).data.ready, true);
  const payload = JSON.parse(s.requests.at(-1)!.body.messages.at(-1).content);
  assert.ok(payload.userMessages.some((m: any) => m.content === original));
});

test("协助登记前的执行中补充加密，完成的旧协助不会被重新绑定", async (t) => {
  const s = await setup(t);
  for (const [requestId, content] of [
    ["before_help", "账号和密码一起提供 00early!"],
    ["after_help", "更正密码 00corrected!"],
  ]) {
    await s.request(`/api/user/threads/${s.thread.id}/messages`, { requestId, content });
    const rows = s.sql
      .prepare("SELECT * FROM message_details WHERE thread_id=? AND role='user' ORDER BY seq DESC")
      .all(s.thread.id);
    assert.ok(rows[0].private_content);
    assert.equal(rows[0].reply_to, null);
    assert.ok(!JSON.stringify(rows).includes(content));
    const page = (await s.request(`/api/user/threads/${s.thread.id}`, undefined, "GET")).data;
    assert.ok(page.messages.some((m: any) => m.content === content));
    if (requestId === "before_help") {
      s.replies(reply("已有信息，继续。"));
      assert.equal((await s.request(s.path, s.help)).data.ready, true);
    }
  }
});
for (const invalidation of ["cancel", "expired", "closed"] as const) {
  test(`登录协助回复已送达后 ${invalidation}：拒绝继续处理旧运行`, async (t) => {
    const s = await setup(t);
    s.replies(reply("请在本聊天回复登录信息。", true));
    assert.equal((await s.request(s.path, s.help)).data.ready, false);
    await s.request(`/api/user/threads/${s.thread.id}/messages`, {
      requestId: "late_login",
      content: "账号 qa@example.com，密码 00private!",
    });
    const jobs = s.jobs();
    if (invalidation === "cancel")
      s.sql.prepare("UPDATE runs SET cancel_requested=1 WHERE id=?").run(s.run.id);
    if (invalidation === "expired")
      s.sql.prepare("UPDATE runs SET lease_expires_at=946684800000 WHERE id=?").run(s.run.id);
    if (invalidation === "closed")
      s.sql.prepare("UPDATE ai_threads SET closed=1 WHERE id=?").run(s.thread.id);
    const result = await s.request(s.path, s.help);
    assert.notEqual(result.status, 200);
    assert.equal(s.jobs(), jobs);
    assert.equal(
      s.sql.prepare("SELECT response FROM execution_help WHERE id=?").get(s.help.id)!.response,
      null,
    );
  });
}
for (const protocol of ["chat", "responses"] as const) {
  test(`协助意图/${protocol}：完整回复进入任务上下文，不拆分密码与新要求`, async (t) => {
    const s = await setup(t, protocol);
    s.replies(reply("请补充登录信息。", true));
    assert.equal((await s.request(s.path, s.help)).data.ready, false);
    const original =
      "账号 owner@example.com，密码是 00aB! test；先看看有没有短信登录，有就改用短信。";
    const posted = await s.request(`/api/user/threads/${s.thread.id}/messages`, {
      requestId: "whole_reply",
      content: original,
    });
    assert.equal(posted.status, 202);
    const userMessage = posted.data.messages.find((m: any) => m.content === original);
    assert.equal(userMessage.private, true);
    s.replies(reply("用户要求优先查看短信登录，请结合原文继续。"));
    const resolved = await s.request(s.path, s.help);
    assert.equal(resolved.status, 200, JSON.stringify(resolved.data));
    assert.deepEqual(resolved.data, {
      ready: true,
      message: "用户要求优先查看短信登录，请结合原文继续。",
    });
    const body = s.requests.at(-1)!.body,
      payload = JSON.parse((protocol === "chat" ? body.messages : body.input).at(-1).content);
    assert.ok(
      payload.userMessages.some((m: any) => m.id === userMessage.id && m.content === original),
    );
    assert.equal(payload.conversation, undefined);
    assert.ok(
      (protocol === "chat" ? body.messages : body.input)
        .slice(0, -1)
        .every((m: any) => !JSON.stringify(m).includes(original)),
    );
    assert.equal(body.model, "vendor/non-gpt");
    const context = await s.request(`/api/runner/runs/${s.run.id}/context`, {
      epoch: s.run.leaseEpoch,
      after: 0,
    });
    assert.ok(context.data.messages.some((m: any) => m.content === original && m.private));
    assert.ok(
      !JSON.stringify(await conversationContext(s.env, s.thread.id)).includes("00aB! test"),
    );
    await assert.rejects(
      conversationContext(s.env, s.thread.id, 0, { runId: "unrelated_run" }),
      /THREAD_NOT_FOUND/,
    );
    const cursor = context.data.messages.find((m: any) => m.id === userMessage.id).seq;
    assert.ok(
      (await conversationContext(s.env, s.thread.id, cursor, { runId: s.run.id })).every(
        (m) => m.seq > cursor,
      ),
    );
    const calls = s.jobs();
    assert.deepEqual((await s.request(s.path, s.help)).data, resolved.data);
    assert.equal(s.jobs(), calls);
  });
  test(`协助意图/${protocol}：云端回复意外复述敏感信息仍加密保存`, async (t) => {
    const s = await setup(t, protocol);
    s.replies(reply("请补充信息。", true));
    await s.request(s.path, s.help);
    const original = '密码 0012aB! "空 格"';
    await s.request(`/api/user/threads/${s.thread.id}/messages`, {
      requestId: "private_reply",
      content: original,
    });
    s.replies(reply("已收到：" + original));
    const result = await s.request(s.path, s.help);
    assert.equal(result.data.message, "已收到：" + original);
    assert.ok(
      !JSON.stringify(
        s.sql
          .prepare("SELECT content,private_content FROM message_details WHERE thread_id=?")
          .all(s.thread.id),
      ).includes("0012aB!"),
    );
    const saved = s.sql.prepare("SELECT response FROM execution_help WHERE id=?").get(s.help.id)!;
    assert.ok(!String(saved.response).includes("0012aB!"));
    assert.ok(JSON.parse(String(saved.response)).encrypted);
    assert.deepEqual((await s.request(s.path, s.help)).data, result.data);
  });
  test(`协助意图/${protocol}：账号更正和旧验证码完整可见，由模型判断适用性`, async (t) => {
    const s = await setup(t, protocol),
      originals = [
        "旧账号 old@example.com，验证码 001234",
        "不要使用旧账号，改用 new@example.com，刚才验证码已失效",
      ];
    for (const [index, content] of originals.entries())
      await appendMessage(s.env, s.thread.id, {
        id: "history_" + index,
        role: "user",
        source: "user",
        runId: s.run.id,
        content,
        private: true,
      });
    s.replies(reply("请提供新账号本次有效的验证码。", true));
    assert.equal((await s.request(s.path, s.help)).data.ready, false);
    const body = s.requests.at(-1)!.body,
      payload = JSON.parse((protocol === "chat" ? body.messages : body.input).at(-1).content);
    for (const content of originals)
      assert.ok(payload.userMessages.some((m: any) => m.content === content));
    const calls = s.jobs();
    assert.deepEqual((await s.request(s.path, s.help)).data, { ready: false, questionRound: 0 });
    assert.equal(s.jobs(), calls);
  });
}

test("等待协助时连续回复均加密，模型结合最后的补充判断", async (t) => {
  const s = await setup(t);
  s.replies(reply("请说明。", true));
  await s.request(s.path, s.help);
  const originals = ["密码是 0012", "刚才的不对，改用扫码登录"];
  for (const [i, content] of originals.entries())
    await s.request(`/api/user/threads/${s.thread.id}/messages`, {
      requestId: "multi_" + i,
      content,
    });
  const rows = s.sql
    .prepare(
      "SELECT content,private_content,reply_to FROM message_details WHERE role='user' AND thread_id=?",
    )
    .all(s.thread.id);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.private_content && row.reply_to === s.help.id));
  assert.ok(!JSON.stringify(rows).includes("0012"));
  s.replies(reply("用户更正为扫码登录，请重新规划。"));
  assert.equal((await s.request(s.path, s.help)).data.ready, true);
  const payload = JSON.parse(s.requests.at(-1)!.body.messages.at(-1).content);
  for (const content of originals)
    assert.ok(payload.userMessages.some((m: any) => m.content === content));
});

test("模型判断期间的新补充不会被旧答案覆盖，原回复重试不恢复已处理询问", async (t) => {
  const s = await setup(t);
  s.replies(reply("请补充信息。", true));
  await s.request(s.path, s.help);
  const original = { requestId: "inflight_password", content: "00password" };
  await s.request(`/api/user/threads/${s.thread.id}/messages`, original);
  const providerFetch = globalThis.fetch;
  let inject = true;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const response = await providerFetch(input, init);
    if (inject && requestUrl(input).startsWith("https://provider.example/")) {
      inject = false;
      await s.request(`/api/user/threads/${s.thread.id}/messages`, {
        requestId: "inflight_change",
        content: "改用验证码，不要使用刚才的密码",
      });
    }
    return response;
  });
  s.replies(reply("已有登录信息。"));
  assert.equal((await s.request(s.path, s.help)).data.ready, false);
  assert.equal(
    s.sql.prepare("SELECT response FROM execution_help WHERE id=?").get(s.help.id)!.response,
    null,
  );
  s.replies(reply("请确认验证码发送到哪个账号？", true));
  assert.equal((await s.request(s.path, s.help)).data.ready, false);
  assert.equal(
    s.sql.prepare("SELECT reply_message_id FROM execution_help WHERE id=?").get(s.help.id)!
      .reply_message_id,
    null,
  );
  const jobs = s.jobs();
  await s.request(`/api/user/threads/${s.thread.id}/messages`, original);
  assert.equal((await s.request(s.path, s.help)).data.ready, false);
  assert.equal(s.jobs(), jobs);
});

test("长执行记录可压缩，用户原文和敏感回复逐字保留且不重复追加", async (t) => {
  const s = await setup(t),
    originals = ["账号 owner@example.com", "密码 00aB! test，优先短信登录"];
  for (const [i, content] of originals.entries())
    await appendMessage(s.env, s.thread.id, {
      id: "original_" + i,
      role: "user",
      source: "user",
      runId: s.run.id,
      content,
      private: true,
    });
  for (let i = 0; i < 3; i++)
    await appendMessage(s.env, s.thread.id, {
      id: "long_history_" + i,
      source: "executor",
      runId: s.run.id,
      content: "已观察当前页面".repeat(450),
    });
  s.respond((body) => {
    if (!body.response_format) return "此前已观察页面。";
    const payload = JSON.parse(body.messages.at(-1).content),
      messages = [...(payload.userMessages ?? []), ...(payload.conversation ?? [])];
    for (const content of originals)
      assert.equal(messages.filter((m: any) => m.content === content).length, 1);
    return reply("已有完整信息，执行器可继续判断。");
  });
  const result = await s.request(s.path, s.help);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.ready, true);
  assert.ok(s.requests.length > 1);
});

test("用户原文超出已配置上下文时明确报错，不静默截断", async (t) => {
  const s = await setup(t);
  s.replies(reply("请补充信息。", true));
  await s.request(s.path, s.help);
  const original = "完整原文".repeat(2500);
  await s.request(`/api/user/threads/${s.thread.id}/messages`, {
    requestId: "oversized_reply",
    content: original,
  });
  const jobs = s.jobs(),
    result = await s.request(s.path, s.help);
  assert.equal(result.data.error, "MODEL_CONTEXT_CONFIGURATION_TOO_SMALL");
  assert.equal(s.jobs(), jobs);
  const page = (await s.request(`/api/user/threads/${s.thread.id}`, undefined, "GET")).data;
  assert.ok(page.messages.some((m: any) => m.content === original));
});

test("内部求助原文加密保留，不复制到用户聊天", async (t) => {
  const s = await setup(t),
    message = "刚才输入 00private! 后页面报错，应如何继续？";
  s.replies(reply("请检查页面错误提示。"));
  assert.equal((await s.request(s.path, { ...s.help, message })).data.ready, true);
  const row = s.sql.prepare("SELECT request FROM execution_help WHERE id=?").get(s.help.id)!;
  assert.ok(!String(row.request).includes("00private!"));
  const stored = JSON.parse(String(row.request));
  assert.equal(stored.origin, s.help.origin);
  assert.equal(stored.message, undefined);
  assert.equal(
    await unseal<string>(
      stored.encryptedMessage,
      s.env.MASTER_KEY,
      `help-request:${s.run.id}:${s.help.id}`,
    ),
    message,
  );
  assert.equal(
    s.sql.prepare("SELECT id FROM ai_messages WHERE id=?").get(s.help.id + "_request"),
    undefined,
  );
  assert.equal(
    (await conversationContext(s.env, s.thread.id, 0, { runId: s.run.id })).some(
      (m) => m.content === message,
    ),
    false,
  );
});
