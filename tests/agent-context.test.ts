import test from "node:test";
import assert from "node:assert/strict";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { createAgent } from "langchain";
import { CallbackChatModel, protectedSummary } from "../packages/model/src/agent-context";
import { SessionCheckpointer } from "../apps/desktop/src/executor/session-checkpointer";
import type { Message, ModelResponse } from "../packages/model/src/index";
import type { ContextSizeReport } from "../packages/contracts/src/context-diagnostics";

const reply = (text: string): ModelResponse => ({
  text,
  calls: [],
  usage: { input: null, output: null },
});
const history = () => [
  new AIMessage({
    content: "",
    tool_calls: [{ id: "read", name: "extract", args: { instruction: "读取旧页面" } }],
  }),
  new ToolMessage({ tool_call_id: "read", content: "x".repeat(11000) }),
  new HumanMessage("最近执行事实"),
];

test("实际摘要请求聚焦进展但保留完整旧历史，未知写入与必要完整网址进入后续决策", async () => {
  const url = "https://example.com/result?request=" + "a%2Fb".repeat(90) + "#完整片段";
  const oldResult = JSON.stringify({
    error: "SENT_RESULT_UNKNOWN",
    sent: true,
    requestId: "keep-request-identity",
    url,
    facts: "x".repeat(12000),
  });
  let summaries = 0,
    decisions = 0;
  const summaryText = `请求 keep-request-identity 已送出，结果未知，禁止重放。后续用户纠正：只核对，不再提交。必要网址：${url}`;
  const summary = new CallbackChatModel(async (messages) => {
    summaries++;
    const prompt = messages.map((m) => m.content).join("\n");
    assert.match(prompt, /旧摘要与新进展合并/);
    assert.match(prompt, /历史独有的约束及纠正/);
    assert.match(prompt, /操作是否送出及结果未知/);
    assert.ok(prompt.includes(oldResult));
    assert.ok(prompt.includes("只核对，不再提交"));
    assert.doesNotMatch(prompt, /完整用户原话 0012Ab/);
    return reply(summaryText);
  });
  const model = new CallbackChatModel(async (messages) => {
    decisions++;
    assert.ok(messages.some((m) => m.content.includes(summaryText)));
    return reply("等待核对未知结果");
  });
  const agent = createAgent({
    model,
    tools: [],
    middleware: [
      protectedSummary({
        model: summary,
        budget: () => ({ contextTokens: 10000, outputTokens: 1024 }),
        protectedMessages: () => [new HumanMessage("完整用户原话 0012Ab")],
        guard: () => {},
      }),
    ],
  });
  await agent.invoke(
    {
      messages: [
        new HumanMessage("只核对，不再提交"),
        new AIMessage({ content: "", tool_calls: [{ id: "sent", name: "act", args: {} }] }),
        new ToolMessage({ tool_call_id: "sent", content: oldResult }),
        new HumanMessage("最新执行事实"),
      ],
    },
    { callbacks: [] },
  );
  assert.equal(summaries, 1);
  assert.equal(decisions, 1);
});

for (const mode of ["failure", "empty", "stopped", "lease", "oversize"] as const)
  test(`官方摘要 ${mode} 不提交历史替换、不继续决策`, async () => {
    const sizes: ContextSizeReport[] = [];
    let summaries = 0,
      decisions = 0,
      invalid = false;
    const saver = new SessionCheckpointer();
    const summary = new CallbackChatModel(async () => {
      summaries++;
      if (mode === "failure") throw Error("MODEL_CALL_OUTCOME_UNKNOWN");
      if (mode === "stopped" || mode === "lease") invalid = true;
      return reply(mode === "empty" ? "" : mode === "oversize" ? "s".repeat(16000) : "旧事实");
    });
    const model = new CallbackChatModel(async () => {
      decisions++;
      return reply("完成");
    });
    const agent = createAgent({
      model,
      tools: [],
      checkpointer: saver,
      middleware: [
        protectedSummary({
          model: summary,
          budget: () => ({ contextTokens: 8192, outputTokens: 1024 }),
          protectedMessages: () => [new HumanMessage("完整用户原话")],
          guard: () => {
            if (invalid) throw Error(mode === "lease" ? "LEASE_EXPIRED" : "EXECUTION_STOPPED");
          },
          onContextSize: (report) => sizes.push(report),
        }),
      ],
    });
    const input = history(),
      config = {
        configurable: { thread_id: `summary_${mode}` },
        callbacks: [],
        durability: "sync" as const,
      };
    await assert.rejects(
      agent.invoke({ messages: input }, config),
      /UNKNOWN|EMPTY_SUMMARY|STOPPED|LEASE_EXPIRED|NOT_REDUCED/,
    );
    assert.equal(summaries, 1);
    assert.equal(decisions, 0);
    assert.equal(sizes.at(-1)?.phase, "error");
    assert.ok(sizes.at(-1)?.summaryInput?.bytes);
    if (mode === "oversize") {
      const report = sizes.at(-1)!;
      assert.equal(report.failure, "CONTEXT_SUMMARY_NOT_REDUCED");
      assert.ok(report.replacement!.estimatedTokens > report.budget.historyAllowanceTokens);
      assert.ok(report.summaryMessage!.estimatedTokens > report.budget.historyAllowanceTokens);
    }
    const saved = await agent.graph.getState(config);
    assert.deepEqual(
      saved.values.messages.map((m: BaseMessage) => m.content),
      input.map((m) => m.content),
    );
    assert.equal(
      saved.values.messages.some(
        (m: BaseMessage) =>
          typeof m.content === "string" && m.content.includes("Error generating summary"),
      ),
      false,
    );
  });

test("开启统计或统计回调抛错，均不改变摘要和决策请求及返回消息", async () => {
  const invoke = async (collect: "off" | "on" | "throw") => {
    const requests: Array<{ purpose: string; messages: Message[] }> = [];
    const sizes: ContextSizeReport[] = [];
    const summary = new CallbackChatModel(async (messages) => {
      requests.push({ purpose: "summary", messages });
      return reply("旧事实");
    });
    const model = new CallbackChatModel(async (messages) => {
      requests.push({ purpose: "decision", messages });
      return reply("完成");
    });
    const agent = createAgent({
      model,
      tools: [],
      middleware: [
        protectedSummary({
          model: summary,
          budget: () => ({ contextTokens: 8192, outputTokens: 1024 }),
          protectedMessages: () => [new HumanMessage("完整用户原话")],
          guard: () => {},
          onContextSize:
            collect === "off"
              ? undefined
              : (report) => {
                  sizes.push(report);
                  if (collect === "throw") throw Error("DIAGNOSTIC_FAILURE");
                },
        }),
      ],
    });
    const result = await agent.invoke({ messages: history() }, { callbacks: [] });
    return { requests, messages: result.messages.map((m) => m.content), sizes };
  };
  const baseline = await invoke("off");
  assert.deepEqual(
    baseline.requests.map((r) => r.purpose),
    ["summary", "decision"],
  );
  for (const mode of ["on", "throw"] as const) {
    const measured = await invoke(mode);
    assert.deepEqual(measured.requests, baseline.requests);
    assert.deepEqual(measured.messages, baseline.messages);
    assert.equal(measured.sizes.at(-1)?.phase, "after-summary");
  }
});

test("超过摘要输入窗口时不裁剪为最后若干消息或分块重试", async () => {
  let calls = 0;
  const model = new CallbackChatModel(async () => {
    calls++;
    return reply("完成");
  });
  const agent = createAgent({
    model,
    tools: [],
    middleware: [
      protectedSummary({
        model,
        budget: () => ({ contextTokens: 8192, outputTokens: 1024 }),
        protectedMessages: () => [],
        guard: () => {},
      }),
    ],
  });
  await assert.rejects(
    agent.invoke(
      { messages: [new HumanMessage("x".repeat(50000)), new HumanMessage("最近事实")] },
      { callbacks: [] },
    ),
    /SUMMARY_INPUT_TOO_LARGE/,
  );
  assert.equal(calls, 0);
});

test("官方摘要保留尚未返回的调用且不产生孤立工具结果", async () => {
  const sent: Message[][] = [];
  const summary = new CallbackChatModel(async () => reply("旧读取已完成"));
  const model = new CallbackChatModel(async (messages) => {
    sent.push(messages);
    return reply("完成");
  });
  const agent = createAgent({
    model,
    tools: [],
    middleware: [
      protectedSummary({
        model: summary,
        budget: () => ({ contextTokens: 8192, outputTokens: 1024 }),
        protectedMessages: () => [],
        guard: () => {},
      }),
    ],
  });
  await agent.invoke(
    {
      messages: [
        ...history(),
        new AIMessage({ content: "", tool_calls: [{ id: "pending", name: "observe", args: {} }] }),
      ],
    },
    { callbacks: [] },
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].at(-1)?.tool_calls?.[0].id, "pending");
  assert.equal(
    sent[0].some((m) => m.role === "tool"),
    false,
  );
});
