import { test } from "node:test";
import assert from "node:assert/strict";
import { infer } from "../packages/model/src/index";
import { previewText } from "../packages/model/src/preview";
import { productionModelFixture } from "./production-model-fixture";
import type { AppEnv } from "../apps/cloud/src/env";
import type { DraftPublication } from "../apps/cloud/src/chat-drafts";
import { allowedDraft } from "../apps/cloud/src/chat-drafts";
import { boundedStream } from "../packages/model/src/stream";
import { generateStructured } from "../apps/cloud/src/models";

const profile = {
  baseUrl: "https://provider.example/v1",
  protocol: "chat" as const,
  model: "test",
};
const enc = new TextEncoder();
const event = (value: unknown) => enc.encode(`data: ${JSON.stringify(value)}\n\n`);
function completion(content: string, finish: string | null = null) {
  return {
    id: "chat",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  };
}
function sse(events: unknown[], done = true) {
  return new Response(
    new ReadableStream({
      start(c) {
        for (const value of events) c.enqueue(event(value));
        if (done) c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("Chat 流在终态之前交付中文正文，工具分片完整汇总并保留真实用量", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let first!: () => void;
  const seen = new Promise<void>((r) => {
    first = r;
  });
  const texts: string[] = [];
  let requests = 0,
    completed = false;
  const result = infer(
    profile,
    "key",
    { messages: [], stream: true },
    async (_url, init) => {
      requests++;
      assert.equal(typeof init?.body, "string");
      assert.equal(JSON.parse(init!.body as string).stream, true);
      return new Response(
        new ReadableStream({
          start(c) {
            controller = c;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
    async (text) => {
      texts.push(text);
      first();
    },
  ).then((value) => {
    completed = true;
    return value;
  });
  await new Promise((r) => setTimeout(r, 0));
  const chinese = event(completion("你好"));
  for (const byte of chinese) controller.enqueue(new Uint8Array([byte]));
  await seen;
  assert.equal(completed, false);
  assert.deepEqual(texts, ["你好"]);
  controller.enqueue(
    event({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call", function: { name: "check", arguments: '{"ok":' } },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
  );
  controller.enqueue(
    event({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: "true}" } }] },
          finish_reason: "tool_calls",
        },
      ],
    }),
  );
  controller.enqueue(event({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 6 } }));
  controller.enqueue(enc.encode("data: [DONE]\n\n"));
  controller.close();
  const full = await result;
  assert.deepEqual(full.calls, [{ id: "call", name: "check", arguments: '{"ok":true}' }]);
  assert.deepEqual(full.usage, { input: 8, output: 6 });
  assert.equal(requests, 1);
});

test("Responses 仅公开 output_text，完成事件汇总工具与用量", async () => {
  const texts: string[] = [];
  const result = await infer(
    { ...profile, protocol: "responses" },
    "key",
    { messages: [], stream: true },
    async () =>
      sse(
        [
          { type: "response.reasoning_text.delta", delta: "internal" },
          { type: "response.output_text.delta", delta: "公开" },
          { type: "response.function_call_arguments.delta", delta: "secret" },
          {
            type: "response.completed",
            response: {
              output: [
                { type: "message", content: [{ type: "output_text", text: "公开" }] },
                { type: "function_call", call_id: "call", name: "check", arguments: "{}" },
              ],
              usage: { input_tokens: 10, output_tokens: 3 },
            },
          },
        ],
        false,
      ),
    async (value) => {
      texts.push(value);
    },
  );
  assert.deepEqual(texts, ["公开"]);
  assert.equal(result.calls[0].name, "check");
  assert.deepEqual(result.usage, { input: 10, output: 3 });
});

for (const protocol of ["chat", "responses"] as const)
  test(`${protocol} 提前断流不能成功且不重发`, async () => {
    let requests = 0;
    await assert.rejects(
      infer({ ...profile, protocol }, "key", { messages: [], stream: true }, async () => {
        requests++;
        return sse(
          protocol === "chat"
            ? [completion("半句")]
            : [{ type: "response.output_text.delta", delta: "半句" }],
          false,
        );
      }),
      /MODEL_STREAM_INCOMPLETE/,
    );
    assert.equal(requests, 1);
  });

test("流式大小限制取消底层读取，HTTP 错误不泄露供应商正文", async () => {
  let cancelled = false;
  await assert.rejects(
    infer(
      profile,
      "key",
      { messages: [], stream: true },
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(2_000_001));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    ),
    /MODEL_RESPONSE_TOO_LARGE/,
  );
  assert.equal(cancelled, true);
  await assert.rejects(
    infer(profile, "key", { messages: [], stream: true }, async () =>
      Response.json({ error: { message: "private", code: "invalid_api_key" } }, { status: 401 }),
    ),
    /^Error: MODEL_HTTP_401_INVALID_KEY$/,
  );
});

test("结构化预览识别顶层字段、完整布尔值与跨块转义", () => {
  assert.equal(previewText('{"reply":"你好\\n\\u4e16\\u754c', "reply"), "你好\n世界");
  assert.equal(previewText('{"reply":"你好\\u4e', "reply"), "你好");
  assert.equal(previewText('{"reply":"\\uD83D', "reply"), "");
  assert.equal(previewText('{"reply":"\\uD83D\\uDE00', "reply"), "😀");
  assert.equal(previewText('{"nested":{"reply":"secret"},"reply":"public', "reply"), "public");
  assert.equal(previewText('{"message":"internal","askUser":false}', "question"), "");
  assert.equal(previewText('{"message":"question","askUser":true', "question"), "");
  assert.equal(previewText('{"askUser":true,"message":"问题', "question"), "问题");
  assert.equal(previewText('{"reply":"first","reply":"second"}', "reply"), "");
});

test("生产入口使用固定配置流式并推送正文，重复请求不受回退开关影响", async (t) => {
  const f = await productionModelFixture(t);
  await f.env.DB.prepare("UPDATE settings SET value='1' WHERE key='modelStreamingEnabled'").run();
  await f.env.DB.prepare(
    "UPDATE model_profile_versions SET capabilities=json_set(capabilities,'$.streaming.tools','supported') WHERE id='model_test' AND version=1",
  ).run();
  const thread = await f.request("/api/user/threads", {
    modelId: "model_test",
    taskId: "task_test",
  });
  assert.equal(thread.status, 200);
  await f.db.prepare("UPDATE runs SET thread_id=? WHERE id=?").bind(thread.data.id, f.run.id).run();
  const previews: DraftPublication[] = [];
  f.env.NOTIFICATIONS = {
    getByName: () => ({
      publishDraft: async (value: DraftPublication) => {
        if (await allowedDraft(f.env, value.owner, value.target)) previews.push(value);
      },
      publish: async () => {},
      closeDrafts: async () => {},
      drafts: async () => [],
    }),
  } as unknown as AppEnv["NOTIFICATIONS"];
  f.replies(sse([completion("正在查看"), completion("", "stop")]));
  const body = {
    epoch: f.run.leaseEpoch,
    requestId: "stream_request",
    supportsDrafts: true,
    messages: [{ role: "user", content: "查询" }],
  };
  const response = await f.request(`/api/runner/runs/${f.run.id}/model`, body);
  assert.equal(response.status, 200);
  assert.equal(f.requests.at(-1)?.body.stream, true);
  assert.equal(previews[0]?.draft.content, "正在查看");
  assert.equal(previews[0]?.draft.status, "streaming");
  assert.equal(previews.at(-1)?.draft.status, "pending");
  const count = f.requests.length;
  await f.env.DB.prepare("UPDATE settings SET value='0' WHERE key='modelStreamingEnabled'").run();
  const replay = await f.request(`/api/runner/runs/${f.run.id}/model`, body);
  assert.equal(replay.status, 200);
  assert.equal(f.requests.length, count);
});

test("未知流式能力先做独立探测，仅明确不支持且控制探测成功时兼容非流式", async (t) => {
  const f = await productionModelFixture(t);
  await f.db.prepare("UPDATE settings SET value='1' WHERE key='modelStreamingEnabled'").run();
  f.replies(
    "ignored stream",
    JSON.stringify({
      __model: { text: "", calls: [{ id: "check", name: "check", arguments: '{"ok":true}' }] },
    }),
    "业务回复",
  );
  const response = await f.request(`/api/runner/runs/${f.run.id}/model`, {
    epoch: f.run.leaseEpoch,
    requestId: "fallback",
    messages: [{ role: "user", content: "用户业务只允许发送一次" }],
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.response.text, "业务回复");
  assert.deepEqual(
    f.requests.map((r) => r.body.tool_choice),
    ["auto", "auto", "auto"],
  );
  assert.deepEqual(
    f.requests.map((r) => r.body.stream),
    [true, false, false],
  );
  assert.ok(!JSON.stringify(f.requests.slice(0, 2)).includes("用户业务只允许发送一次"));
  const row = await f.db
    .prepare("SELECT capabilities FROM model_profile_versions WHERE id='model_test' AND version=1")
    .first<{ capabilities: string }>();
  assert.equal(JSON.parse(row!.capabilities).streaming.tools, "unsupported");
});

test("工具能力探测采用执行器的自动选择并验证真实函数及参数", async (t) => {
  const f = await productionModelFixture(t);
  f.replies(
    "OK",
    JSON.stringify({
      __model: { text: "", calls: [{ id: "call", name: "check", arguments: '{"value":7}' }] },
    }),
    '{"ok":true}',
  );
  const { status, data: capabilities } = await f.request("/api/admin/models/model_test/test", {});
  assert.equal(status, 200);
  assert.equal(f.requests[1].body.tool_choice, "auto");
  assert.equal(capabilities.tools, true);
  f.replies("OK", "check with value 7", '{"ok":true}');
  assert.equal((await f.request("/api/admin/models/model_test/test", {})).data.tools, false);
});

test("能力探测网络故障不降级、不提交用户业务、不标记不支持", async (t) => {
  const f = await productionModelFixture(t);
  await f.db.prepare("UPDATE settings SET value='1' WHERE key='modelStreamingEnabled'").run();
  f.replies(new Error("network"));
  const response = await f.request(`/api/runner/runs/${f.run.id}/model`, {
    epoch: f.run.leaseEpoch,
    requestId: "probe_error",
    messages: [{ role: "user", content: "不发送业务" }],
  });
  assert.notEqual(response.status, 200);
  assert.equal(f.requests.length, 1);
  assert.ok(!JSON.stringify(f.requests).includes("不发送业务"));
  const row = await f.db
    .prepare("SELECT capabilities FROM model_profile_versions WHERE id='model_test' AND version=1")
    .first<{ capabilities: string }>();
  assert.equal(JSON.parse(row!.capabilities).streaming, undefined);
});

test("流读取取消终止底层等待并保留超时分类", async () => {
  const abort = new AbortController();
  let cancelled = false,
    failure = "";
  const response = boundedStream(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
    abort.signal,
    (code) => {
      failure = code;
    },
  );
  const reading = response.text();
  abort.abort();
  await assert.rejects(reading, /MODEL_TIMEOUT/);
  assert.equal(failure, "MODEL_TIMEOUT");
  assert.equal(cancelled, true);
});

test("结构化修复生成新草稿版本，内部字段不会进入预览", async (t) => {
  const f = await productionModelFixture(t);
  await f.db.prepare("UPDATE settings SET value='1' WHERE key='modelStreamingEnabled'").run();
  await f.db
    .prepare(
      "UPDATE model_profile_versions SET capabilities=json_set(capabilities,'$.streaming.structured','supported') WHERE id='model_test' AND version=1",
    )
    .run();
  const publications: DraftPublication[] = [];
  f.env.NOTIFICATIONS = {
    getByName: () => ({
      publishDraft: async (p: DraftPublication) => {
        publications.push(structuredClone(p));
      },
    }),
  } as unknown as AppEnv["NOTIFICATIONS"];
  f.replies(
    sse([completion('{"reply":"首稿","internal":"secret"}'), completion("", "stop")]),
    sse([completion('{"reply":"修复正文","valid":true}'), completion("", "stop")]),
  );
  const result = await generateStructured(
    { ...f.env, requestUserId: "fixture_owner" },
    "model_test",
    1,
    { type: "object" },
    (value) => {
      const v = value as { reply: string; valid?: boolean };
      if (!v.valid) throw Error("invalid");
      return v;
    },
    [],
    null,
    "INVALID",
    "repair-test",
    undefined,
    undefined,
    undefined,
    { threadId: "thread", id: "draft", mode: "reply", source: "cloud" },
  );
  assert.equal(result.data.reply, "修复正文");
  assert.deepEqual([...new Set(publications.map((p) => p.draft.version))], [0, 1]);
  assert.ok(publications.every((p) => !p.draft.content.includes("secret")));
  assert.equal(publications.at(-1)?.draft.callId, "repair-test:1");
  assert.equal(f.requests.length, 2);
});

test("草稿授权拒绝停止、旧租约、用户补充、旧图代次和关闭聊天", async (t) => {
  const f = await productionModelFixture(t);
  const { data: thread } = await f.request("/api/user/threads", {
    modelId: "model_test",
    taskId: "task_test",
  });
  await f.db.prepare("UPDATE runs SET thread_id=? WHERE id=?").bind(thread.id, f.run.id).run();
  const target = {
    threadId: thread.id,
    id: "draft",
    mode: "text" as const,
    source: "executor" as const,
    runId: f.run.id,
    epoch: f.run.leaseEpoch,
    deviceId: "device_test",
    userSeq: 0,
  };
  assert.equal(await allowedDraft(f.env, f.run.userId, target), true);
  assert.equal(await allowedDraft(f.env, "other", target), false);
  assert.equal(
    await allowedDraft(f.env, f.run.userId, { ...target, epoch: target.epoch + 1 }),
    false,
  );
  assert.equal(await allowedDraft(f.env, f.run.userId, { ...target, userSeq: 1 }), false);
  await f.db.prepare("UPDATE runs SET cancel_requested=1 WHERE id=?").bind(f.run.id).run();
  assert.equal(await allowedDraft(f.env, f.run.userId, target), false);
  await f.db.prepare("UPDATE runs SET cancel_requested=0 WHERE id=?").bind(f.run.id).run();
  await f.db
    .prepare(
      "INSERT INTO ai_graph_inputs(owner,id,digest,parent_thread,created_at,generation) VALUES(?,'graph','digest',?,?,2)",
    )
    .bind(f.run.userId, thread.id, Date.now())
    .run();
  assert.equal(
    await allowedDraft(f.env, f.run.userId, { ...target, graphId: "graph", generation: 1 }),
    false,
  );
  assert.equal(
    await allowedDraft(f.env, f.run.userId, { ...target, graphId: "graph", generation: 2 }),
    true,
  );
  await f.db.prepare("UPDATE ai_graph_inputs SET status='failed' WHERE id='graph'").run();
  assert.equal(
    await allowedDraft(f.env, f.run.userId, { ...target, graphId: "graph", generation: 2 }),
    false,
    "完整输出后的业务校验失败也必须撤销草稿写入并标记未完成",
  );
  await f.db.prepare("UPDATE ai_threads SET closed=1 WHERE id=?").bind(thread.id).run();
  assert.equal(await allowedDraft(f.env, f.run.userId, target), false);
});

test("管理员可独立关闭新调用流式与预览，指标不返回正文", async (t) => {
  const f = await productionModelFixture(t);
  const updated = await f.request(
    "/api/admin/streaming",
    { modelStreamingEnabled: true, chatPreviewEnabled: false },
    "PATCH",
  );
  assert.equal(updated.status, 200);
  const result = await f.request("/api/admin/streaming", undefined, "GET");
  assert.equal(result.data.modelStreamingEnabled, true);
  assert.equal(result.data.chatPreviewEnabled, false);
  assert.deepEqual(result.data.metrics, []);
});
