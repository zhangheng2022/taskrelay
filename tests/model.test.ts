import test from "node:test";
import assert from "node:assert/strict";
import { infer, structured } from "../packages/model/src/index";
import type { ModelProfile } from "../packages/contracts/src/index";
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
test("Chat Completions 保留任意模型名、工具调用及未知用量", async () => {
  const result = await infer(
    profile,
    "key",
    {
      messages: [{ role: "user", content: "test" }],
      tools: [
        { name: "check", description: "test", parameters: { type: "object" } },
      ],
    },
    async (url, init) => {
      assert.equal(String(url), "https://provider.example/v1/chat/completions");
      assert.equal(init?.redirect, "manual");
      const b = JSON.parse(String(init?.body));
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
      assert.ok(String(url).endsWith("/responses"));
      const b = JSON.parse(String(init?.body));
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
test("JSON 格式失败最多修正一次，绝不自动切换模型", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      structured(
        profile,
        "key",
        [{ role: "user", content: "test" }],
        { type: "object" },
        (x) => x,
        async () => {
          calls++;
          return Response.json({
            choices: [{ message: { content: "invalid json" } }],
          });
        },
      ),
    /MODEL_INVALID_JSON/,
  );
  assert.equal(calls, 2);
});

test("供应商错误仅暴露白名单分类，不泄露上游正文或密钥", async () => {
  for (const [code, expected] of [
    [
      "unsupported_country_region_territory",
      "MODEL_HTTP_403_UNSUPPORTED_REGION",
    ],
    ["unexpected-secret-key", "MODEL_HTTP_403"],
  ]) {
    await assert.rejects(
      () =>
        infer(
          profile,
          "private-key",
          { messages: [{ role: "user", content: "test" }] },
          async () =>
            Response.json(
              { error: { code, message: "private-key upstream body" } },
              { status: 403 },
            ),
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
