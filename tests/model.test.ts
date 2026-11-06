import { requestUrl, jsonBody } from "./http-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { infer } from "../packages/model/src/index";
import { outputSchema } from "../packages/model/src/schema";
import type { ModelProfile } from "../packages/contracts/src/index";
import { executorTools, executorArguments } from "../packages/contracts/src/execution";
const profile: ModelProfile = {
  id: "test",
  version: 1,
  name: "compatible",
  baseUrl: "https://provider.example/v1",
  model: "vendor/non-gpt-model",
  protocol: "chat",
  hasKey: true,
  inputPrice: null,
  outputPrice: null,
  capabilities: {
    connection: true,
    tools: true,
    structured: "json",
    vision: false,
    testedAt: null,
  },
};
for (const protocol of ["chat", "responses"] as const)
  test(`${protocol} 正式执行工具经过提供方格式投影，本机仍保留完整 Zod 校验`, async () => {
    const original = structuredClone(executorTools);
    await infer(
      { ...profile, protocol },
      "key",
      { messages: [{ role: "user", content: "只读测试" }], tools: executorTools },
      async (_url, init) => {
        const body = jsonBody(init?.body);
        const tools =
          protocol === "chat"
            ? body.tools.map((item: { function: unknown }) => item.function)
            : body.tools;
        assert.equal(tools.length, 11);
        assert.doesNotMatch(JSON.stringify(tools), /"format":"uri"|"minLength"|"maxLength"/);
        for (const item of tools)
          assert.deepEqual(item.parameters.required, Object.keys(item.parameters.properties));
        return Response.json(
          protocol === "chat"
            ? { choices: [{ message: { content: "完成" } }] }
            : { output: [{ type: "message", content: [{ type: "output_text", text: "完成" }] }] },
        );
      },
    );
    assert.deepEqual(executorTools, original);
    assert.equal(executorArguments.navigate.safeParse({ url: "invalid" }).success, false);
    assert.equal(executorArguments.act.safeParse({ instruction: "" }).success, false);
  });
test("严格输出投影不修改原 Schema，也不把同名业务字段当作关键字删除", () => {
  const schema = {
    type: "object",
    properties: {
      default: { type: "string", default: "x" },
      oneOf: { type: "string", const: "value" },
    },
    required: ["default", "oneOf"],
    additionalProperties: false,
  };
  const original = structuredClone(schema);
  const projected = outputSchema(schema) as any;
  assert.deepEqual(schema, original);
  assert.deepEqual(projected.properties.default, { type: "string" });
  assert.deepEqual(projected.properties.oneOf, {
    type: "string",
    enum: ["value"],
  });
});
test("Chat Completions 保留任意模型名、工具调用及未知用量", async () => {
  const result = await infer(
    profile,
    "key",
    {
      messages: [{ role: "user", content: "test" }],
      tools: [{ name: "check", description: "test", parameters: { type: "object" } }],
    },
    async (url, init) => {
      assert.equal(requestUrl(url), "https://provider.example/v1/chat/completions");
      assert.equal(init?.redirect, "manual");
      const b = jsonBody(init?.body);
      assert.equal(b.model, "vendor/non-gpt-model");
      assert.equal(b.tools[0].function.name, "check");
      return Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "1",
                  function: { name: "check", arguments: '{"value":7}' },
                },
              ],
            },
          },
        ],
      });
    },
  );
  assert.equal(result.usage.input, null);
  assert.equal(result.calls[0].name, "check");
});
test("Responses 正确映射请求、调用结果与实际用量", async () => {
  const r = await infer(
    { ...profile, protocol: "responses" },
    "key",
    {
      messages: [{ role: "tool", content: "ok", tool_call_id: "call_1" }],
      schema: { type: "object" },
    },
    async (url, init) => {
      assert.ok(requestUrl(url).endsWith("/responses"));
      const b = jsonBody(init?.body);
      assert.equal(b.input[0].type, "function_call_output");
      assert.equal(b.store, false);
      assert.equal(b.text.format.type, "json_schema");
      return Response.json({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: '{"ok":true}' }],
          },
        ],
        usage: { input_tokens: 18, output_tokens: 5 },
      });
    },
  );
  assert.equal(r.text, '{"ok":true}');
  assert.deepEqual(r.usage, { input: 18, output: 5 });
});
test("供应商错误仅暴露白名单分类，不泄露上游正文或密钥", async () => {
  for (const [code, expected] of [
    ["unsupported_country_region_territory", "MODEL_HTTP_403_UNSUPPORTED_REGION"],
    ["unexpected-secret-key", "MODEL_HTTP_403"],
  ]) {
    await assert.rejects(
      () =>
        infer(profile, "private-key", { messages: [{ role: "user", content: "test" }] }, async () =>
          Response.json({ error: { code, message: "private-key upstream body" } }, { status: 403 }),
        ),
      { message: expected },
    );
  }
});

test("带密钥的模型请求拒绝重定向，不向其他地址重发", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      infer(
        profile,
        "private-key",
        { messages: [{ role: "user", content: "test" }] },
        async (_url, init) => {
          calls++;
          assert.equal(init?.redirect, "manual");
          return new Response(null, {
            status: 307,
            headers: { Location: "https://untrusted.example/collect" },
          });
        },
      ),
    /MODEL_REDIRECT_BLOCKED/,
  );
  assert.equal(calls, 1);
});

test("SDK 标准 Responses 结果与兼容结果均保留文字、工具及用量", async () => {
  const response = await infer(
    { ...profile, protocol: "responses" },
    "key",
    { messages: [{ role: "user", content: "test" }] },
    async (_url, init) => {
      assert.match(new Headers(init?.headers).get("user-agent") ?? "", /OpenAI/);
      return Response.json({
        object: "response",
        output: [
          { type: "message", content: [{ type: "output_text", text: "实际结果" }] },
          { type: "function_call", call_id: "a", name: "extract", arguments: "{}" },
        ],
        usage: { input_tokens: 3, output_tokens: 4 },
      });
    },
  );
  assert.equal(response.text, "实际结果");
  assert.deepEqual(response.calls, [{ id: "a", name: "extract", arguments: "{}" }]);
  assert.deepEqual(response.usage, { input: 3, output: 4 });
});

test("SDK 对限流、服务故障和传输断流均不重试且不暴露错误正文", async () => {
  for (const scenario of [
    "rate",
    "server",
    "network",
    "stream",
    "oversize",
    "gateway",
    "invalid",
  ] as const) {
    let calls = 0,
      cancelled = false;
    const expected = {
      rate: "MODEL_HTTP_429",
      server: "MODEL_HTTP_503",
      network: "MODEL_CALL_OUTCOME_UNKNOWN",
      stream: "MODEL_CALL_OUTCOME_UNKNOWN",
      oversize: "MODEL_RESPONSE_TOO_LARGE",
      gateway: "MODEL_HTTP_403_GATEWAY_DENIED",
      invalid: "MODEL_INVALID_RESPONSE",
    }[scenario];
    await assert.rejects(
      infer(profile, "private-key", { messages: [{ role: "user", content: "test" }] }, async () => {
        calls++;
        if (scenario === "network") throw Error("private-key reset");
        if (scenario === "stream")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(Error("private-key body"));
              },
            }),
          );
        if (scenario === "oversize")
          return new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new Uint8Array(2_000_001));
              },
              cancel() {
                cancelled = true;
              },
            }),
          );
        if (scenario === "gateway" || scenario === "invalid")
          return new Response("private-key html", { status: scenario === "gateway" ? 403 : 200 });
        return Response.json(
          { error: { message: "private-key upstream body" } },
          { status: scenario === "rate" ? 429 : 503 },
        );
      }),
      { message: expected },
    );
    assert.equal(calls, 1, scenario);
    if (scenario === "oversize") assert.equal(cancelled, true);
  }
});

test("SDK 不继承环境组织凭据；未配置密钥的兼容端点不发送 Authorization", async (t) => {
  t.mock.property(process, "env", {
    ...process.env,
    OPENAI_ORG_ID: "private-org",
    OPENAI_PROJECT_ID: "private-project",
  });
  await infer(
    profile,
    "",
    { messages: [{ role: "user", content: "test" }] },
    async (_url, init) => {
      const headers = new Headers(init?.headers);
      for (const name of ["authorization", "openai-organization", "openai-project"])
        assert.equal(headers.get(name), null);
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    },
  );
});

test("SDK 超时覆盖未结束的响应正文并取消读取，不重发", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let ready!: () => void,
    cancelled = false,
    calls = 0;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const pending = infer(
    profile,
    "key",
    { messages: [{ role: "user", content: "test" }] },
    async () => {
      calls++;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            ready();
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
  );
  const checked = assert.rejects(pending, { message: "MODEL_TIMEOUT" });
  await started;
  t.mock.timers.tick(60_001);
  await checked;
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});
