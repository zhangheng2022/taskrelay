import test from "node:test";
import assert from "node:assert/strict";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { RelayChatModel } from "../apps/cloud/src/ai/model";
import {
  aiMessageToModelResponse,
  modelResponseToAIMessage,
} from "../packages/model/src/langchain";
import type { Message } from "../packages/model/src/index";
import { productionModelFixture } from "./production-model-fixture";

function helpGraphFixture(s: Awaited<ReturnType<typeof productionModelFixture>>) {
  s.sql
    .prepare(
      "INSERT INTO ai_threads(id,user_id,kind,model_id,model_version,created_at,updated_at) VALUES('lc_thread',?,'chat','model_test',1,?,?)",
    )
    .run(s.run.userId, new Date().toISOString(), new Date().toISOString());
  s.sql
    .prepare(
      "INSERT INTO ai_graph_inputs(owner,id,digest,parent_thread,created_at,kind,run_id,lease_epoch,generation) VALUES(?,'lc_graph','digest','lc_thread',?,'help',?,?,7)",
    )
    .run(s.run.userId, new Date().toISOString(), s.run.id, s.run.leaseEpoch);
  return new RelayChatModel(s.env, "model_test", 1, "lc_fenced", s.run.id, "lc_graph", 7);
}

for (const mutation of [
  "UPDATE runs SET lease_epoch=lease_epoch+1",
  "UPDATE runs SET lease_expires_at='2000-01-01'",
  "UPDATE runs SET cancel_requested=1",
  "UPDATE ai_graph_inputs SET generation=generation+1",
  "UPDATE ai_threads SET closed=1",
] as const)
  test(`help 模型晚结果被原子fence丢弃：${mutation}`, async (t) => {
    const s = await productionModelFixture(t),
      model = helpGraphFixture(s);
    s.respond(() => {
      s.sql.exec(mutation);
      return '{"answer":"过期答案"}';
    });
    await assert.rejects(
      model.withStructuredOutput(z.object({ answer: z.string() })).invoke("处理协助"),
      /MODEL_CALL_DISCARDED/,
    );
    const row = s.sql.prepare("SELECT status,result FROM ai_calls WHERE id='lc_fenced:0'").get()!;
    assert.equal(row.status, "unknown");
    assert.equal(row.result, null);
    assert.equal(s.jobs(), 1);
    assert.equal(
      s.sql.prepare("SELECT COUNT(*) AS n FROM model_usage").get()!.n,
      1,
      "实际提供方用量仍应计入",
    );
  });

test("失效help图不能读取旧操作缓存或发起新模型操作", async (t) => {
  const s = await productionModelFixture(t),
    model = helpGraphFixture(s);
  s.replies("已有答案");
  await model.invoke("处理协助");
  s.sql.exec("UPDATE ai_graph_inputs SET generation=generation+1");
  await assert.rejects(model.invoke("处理协助"), /MODEL_CALL_DISCARDED/);
  await assert.rejects(model.invoke("新协助", { operationId: "lc_new" }), /MODEL_CALL_DISCARDED/);
  assert.equal(s.jobs(), 1);
  assert.equal(s.sql.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE id='lc_new'").get()!.n, 0);
});

test("官方 Agent 摘要保留图归属与 generation，并完整注入用户原文", async (t) => {
  const s = await productionModelFixture(t);
  helpGraphFixture(s);
  s.respond((body) => (body.response_format ? '{"answer":"已读取"}' : "旧执行事实"));
  const model = new RelayChatModel(s.env, "model_test", 1, "lc_agent", s.run.id, "lc_graph", 7);
  const protectedInput: Message[] = [
    { role: "system", content: "规划" },
    { role: "user", content: "完整原话 0012Ab! 不得更改" },
  ];
  const history: Message[] = [
    { role: "assistant", content: "x".repeat(19000) },
    { role: "assistant", content: "近期执行事实" },
  ];
  assert.deepEqual(
    await model.runAgent(z.object({ answer: z.string() }), protectedInput, history, async () => {}),
    { answer: "已读取" },
  );
  const rows = s.sql.prepare("SELECT graph_id FROM ai_calls").all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.graph_id === "lc_graph"));
  assert.doesNotMatch(JSON.stringify(s.requests[0].body), /0012Ab/);
  assert.match(JSON.stringify(s.requests[1].body), /完整原话 0012Ab!/);
  s.sql.exec("UPDATE ai_graph_inputs SET generation=generation+1");
  await assert.rejects(
    model.runAgent(z.object({ answer: z.string() }), protectedInput, history, async () => {}),
    /MODEL_CALL_DISCARDED/,
  );
});

for (const protocol of ["chat", "responses"] as const)
  test(`LangChain ${protocol} 工具消息、用量和稳定操作编号贯穿实际出站`, async (t) => {
    const s = await productionModelFixture(t, protocol);
    const model = new RelayChatModel(s.env, "model_test", 1, "lc_first", s.run.id);
    const read = tool(async () => "unused", {
      name: "read",
      description: "读取页面",
      schema: z.object({ query: z.string() }),
    });
    s.replies(
      JSON.stringify({
        __model: {
          text: "先读取页面",
          calls: [{ id: "call_1", name: "read", arguments: '{"query":"订单"}' }],
        },
      }),
    );
    const first = await model.bindTools([read]).invoke([new HumanMessage("查询订单")]);
    assert.deepEqual(first.tool_calls, [
      { id: "call_1", name: "read", args: { query: "订单" }, type: "tool_call" },
    ]);
    assert.deepEqual(first.usage_metadata, {
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
    });
    s.replies("订单已发货");
    const messages = [
      new HumanMessage("查询订单"),
      first,
      new ToolMessage({ tool_call_id: "call_1", content: "已发货" }),
    ];
    const second = await model.invoke(messages, { operationId: "lc_second" });
    assert.equal(second.content, "订单已发货");
    await model.invoke(messages, { operationId: "lc_second" });
    assert.equal(s.jobs(), 2);
    const body = s.requests[1].body;
    if (protocol === "chat") {
      assert.equal(body.messages[1].tool_calls[0].id, "call_1");
      assert.equal(body.messages[2].tool_call_id, "call_1");
    } else {
      assert.ok(body.input.some((v: any) => v.role === "assistant" && v.content === "先读取页面"));
      assert.ok(
        body.input.some(
          (v: any) =>
            v.type === "function_call_output" && v.call_id === "call_1" && v.output === "已发货",
        ),
      );
    }
  });

for (const mode of ["schema", "json"] as const)
  test(`LangChain structured ${mode} 使用统一修复入口和 includeRaw`, async (t) => {
    const s = await productionModelFixture(t, "chat", mode),
      model = new RelayChatModel(s.env, "model_test", 1, "lc_structured", s.run.id);
    s.replies('{"value":"wrong"}', '{"value":7}');
    const result = await model
      .withStructuredOutput<{ value: number }>(z.object({ value: z.number() }), {
        includeRaw: true,
      })
      .invoke("读取数字");
    assert.deepEqual(result.parsed, { value: 7 });
    assert.ok(result.raw instanceof AIMessage);
    assert.equal(s.jobs(), 2);
    assert.equal(
      s.requests[0].body.response_format.type,
      mode === "schema" ? "json_schema" : "json_object",
    );
    const repeated = await model
      .withStructuredOutput<{ value: number }>(z.object({ value: z.number() }))
      .invoke("读取数字");
    assert.deepEqual(repeated, { value: 7 });
    assert.equal(s.jobs(), 2);
  });

test("LangChain 模型中断结果未知不自动重试，重复操作不重新出站", async (t) => {
  const s = await productionModelFixture(t),
    model = new RelayChatModel(s.env, "model_test", 1, "lc_unknown", s.run.id);
  s.replies(new Error("connection reset"));
  await assert.rejects(model.invoke("读取页面"));
  await assert.rejects(model.invoke("读取页面"), /MODEL_CALL_OUTCOME_UNKNOWN/);
  assert.equal(s.jobs(), 1);
});

for (const protocol of ["chat", "responses"] as const)
  test(`官方 Zod helper/${protocol} 格式投影后仍按原 Schema 修复无效网址`, async (t) => {
    const s = await productionModelFixture(t, protocol),
      model = new RelayChatModel(s.env, "model_test", 1, "lc_zod_helper", s.run.id);
    s.replies('{"url":"invalid","tags":[]}', '{"url":"https://example.com","tags":[]}');
    const result = await model
      .withStructuredOutput(z.object({ url: z.url(), tags: z.array(z.string()).default([]) }))
      .invoke("读取网址");
    assert.deepEqual(result, { url: "https://example.com", tags: [] });
    assert.equal(s.jobs(), 2);
    const format =
      protocol === "chat"
        ? s.requests[0].body.response_format.json_schema
        : s.requests[0].body.text.format;
    assert.equal(format.strict, true);
    assert.deepEqual(format.schema.required, ["url", "tags"]);
    assert.equal(format.schema.properties.url.format, undefined);
  });

test("非法工具参数保留原始编号与顺序，缺用量保持未知", () => {
  const response = {
    text: "",
    calls: [
      { id: "bad", name: "act", arguments: "{" },
      { id: "good", name: "wait", arguments: "{}" },
    ],
    usage: { input: null, output: null },
  };
  const message = modelResponseToAIMessage(response);
  assert.equal(message.invalid_tool_calls?.[0].id, "bad");
  assert.equal(message.usage_metadata, undefined);
  assert.deepEqual(aiMessageToModelResponse(message), response);
});

test("LangChain 标准图片块在普通与结构化调用中都检查模型视觉能力", async (t) => {
  const s = await productionModelFixture(t),
    model = new RelayChatModel(s.env, "model_test", 1, "lc_no_vision", s.run.id);
  const messages = [
    new HumanMessage({
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,cGl4ZWw=" } }],
    }),
  ];
  await assert.rejects(model.invoke(messages), /VISION_NOT_SUPPORTED/);
  await assert.rejects(
    model.withStructuredOutput(z.object({ color: z.string() })).invoke(messages),
    /VISION_NOT_SUPPORTED/,
  );
  assert.equal(s.jobs(), 0);
});

for (const protocol of ["chat", "responses"] as const)
  test(`LangChain ${protocol} 标准图片内容块保留在原消息位置`, async (t) => {
    const s = await productionModelFixture(t, protocol),
      model = new RelayChatModel(s.env, "model_test", 1, "lc_image", s.run.id);
    s.sql
      .prepare(
        "UPDATE model_profiles SET capabilities=json_set(capabilities,'$.vision',json('true')) WHERE id='model_test' AND version=1",
      )
      .run();
    s.replies("red");
    await model.invoke([
      new HumanMessage({
        content: [
          { type: "text", text: "颜色？" },
          { type: "image_url", image_url: { url: "data:image/png;base64,cGl4ZWw=" } },
        ],
      }),
    ]);
    const message = (
      protocol === "chat" ? s.requests[0].body.messages : s.requests[0].body.input
    )[0];
    assert.equal(message.content[0].text, "颜色？");
    assert.equal(
      protocol === "chat" ? message.content[1].image_url.url : message.content[1].image_url,
      "data:image/png;base64,cGl4ZWw=",
    );
  });
