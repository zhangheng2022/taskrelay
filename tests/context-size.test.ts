import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  contextLargestLimit,
  contextSizeLimit,
  contextSizeReportSchema,
} from "../packages/contracts/src/context-diagnostics";
import {
  contextSizeReport,
  estimateTokens,
  messageTokens,
  valueSize,
} from "../packages/model/src/context-size";
import { fromLangChainMessages } from "../packages/model/src/langchain";
import { ExecutionClock } from "../apps/desktop/src/executor/timing";
import { Journal } from "../apps/desktop/src/main/journal";

test("体积统计使用原预算算法，区分保护输入、工具、历史和完整保留的近期结果", () => {
  const secret = "私密诊断占位内容🔒";
  const page = {
    url: `https://private.example/${secret}`,
    title: secret,
    tabs: [{ title: secret }, { title: secret.repeat(12) }],
    loading: { state: "complete" },
    network: [{ detail: secret.repeat(50) }],
  };
  const input = {
    goal: secret,
    executionOutline: [secret],
    userMessages: [{ content: secret }, { content: secret.repeat(10) }],
    accounts: [{ password: secret }],
    accountContext: { token: secret },
    accountName: secret,
    untrustedPage: page,
    [secret]: secret,
  };
  const protectedMessages = [new SystemMessage(secret), new HumanMessage(JSON.stringify(input))];
  const history = [
    new HumanMessage(secret),
    new AIMessage({
      content: "",
      tool_calls: [{ id: secret, name: "extract", args: { instruction: secret } }],
    }),
    new ToolMessage({
      tool_call_id: secret,
      content: JSON.stringify({
        data: secret.repeat(100),
        metadata: { token: secret },
        observation: page,
      }),
    }),
  ];
  const tools = [{ name: "extract", description: secret }];
  const replacement = [new SystemMessage("短摘要"), ...history.slice(1)];
  const report = contextSizeReportSchema.parse(
    contextSizeReport({
      phase: "after-summary",
      budget: { contextTokens: 16000, outputTokens: 4096 },
      remaining: 7000,
      protectedMessages,
      tools,
      history,
      replacement,
      summaryInput: valueSize([{ role: "user", content: secret }]),
    }),
  );
  const raw = JSON.stringify(fromLangChainMessages(history));
  assert.equal(report.history.bytes, Buffer.byteLength(raw, "utf8"));
  assert.equal(
    report.history.estimatedTokens,
    Math.ceil(Buffer.byteLength(raw) / 2) + history.length * 16,
  );
  assert.equal(messageTokens(history), report.history.estimatedTokens);
  assert.equal(estimateTokens(tools), Math.ceil(Buffer.byteLength(JSON.stringify(tools)) / 2));
  assert.equal(report.protectedMessages.estimatedTokens, messageTokens(protectedMessages));
  assert.deepEqual(report.tools, { ...valueSize(tools), count: 1 });
  assert.equal(report.history.byRole.tool?.messages, 1);
  assert.equal(report.history.byRole.assistant?.messages, 1);
  const sections = report.protectedMessages.largest.find((m) => m.role === "user")!.sections;
  assert.equal(
    sections.find((s) => s.section === "untrustedPage.network")?.bytes,
    valueSize(page.network).bytes,
  );
  assert.deepEqual(
    sections.find((s) => s.section === "userMessages"),
    {
      section: "userMessages",
      ...valueSize(input.userMessages),
      items: 2,
      largestItemIndex: 1,
      largestItemBytes: valueSize(input.userMessages[1]).bytes,
    },
  );
  const largest = report.history.largest[0];
  assert.equal(largest.index, 2);
  assert.equal(largest.tool, "extract");
  assert.equal(
    largest.sections.find((s) => s.section === "data")?.bytes,
    valueSize(secret.repeat(100)).bytes,
  );
  assert.equal(report.summaryMessage?.estimatedTokens, messageTokens(replacement.slice(0, 1)));
  assert.equal(report.preserved?.estimatedTokens, messageTokens(history.slice(1)));
  assert.equal(report.summarized?.messages, 1);
  assert.equal(report.replacement?.estimatedTokens, messageTokens(replacement));
  assert.doesNotMatch(JSON.stringify(report), /私密|private\.example|password|token/);
  assert.equal(
    history[2].content,
    JSON.stringify({ data: secret.repeat(100), metadata: { token: secret }, observation: page }),
  );
});

test("最大消息使用组内原始下标，未知工具和任意字段名不进入诊断", () => {
  const history: BaseMessage[] = Array.from(
    { length: 7 },
    (_, i) => new HumanMessage("x".repeat(i * 100)),
  );
  history.push(
    new AIMessage({
      content: "",
      tool_calls: [{ id: "private-id", name: "private-tool", args: {} }],
    }),
  );
  history.push(
    new ToolMessage({
      tool_call_id: "private-id",
      content: JSON.stringify({ "private-field": "x".repeat(2000) }),
    }),
  );
  const report = contextSizeReport({
    phase: "before-summary",
    budget: { contextTokens: 16000, outputTokens: 4096 },
    remaining: 7000,
    protectedMessages: [],
    tools: [],
    history,
  });
  assert.equal(report.history.largest.length, contextLargestLimit);
  assert.deepEqual(
    report.history.largest.map((m) => m.index),
    [8, 6, 5, 4, 3],
  );
  assert.equal(report.history.largest[0].tool, "other");
  assert.deepEqual(report.history.largest[0].sections, []);
  assert.doesNotMatch(JSON.stringify(report), /private-/);
});

test("终态检查点与导出诊断保留最近八份体积统计，严格拒绝嵌套原文", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "taskrelay-context-size-"));
  const journal = new Journal(dir),
    clock = new ExecutionClock();
  t.after(() => {
    clock.close();
    journal.close();
    rmSync(dir, { recursive: true });
  });
  const sample = contextSizeReport({
    phase: "error",
    failure: "CONTEXT_SUMMARY_NOT_REDUCED",
    budget: { contextTokens: 16000, outputTokens: 4096 },
    remaining: 7000,
    protectedMessages: [],
    tools: [],
    history: [new HumanMessage("private-content")],
  });
  for (let round = 1; round <= contextSizeLimit + 2; round++) {
    clock.round = round;
    clock.contextSize(sample);
  }
  sample.history.bytes = 999999;
  const report = clock.report();
  assert.equal(report.contextSizes?.length, contextSizeLimit);
  assert.equal(report.contextSizes[0].round, 3);
  assert.notEqual(report.contextSizes[0].report.history.bytes, sample.history.bytes);
  report.contextSizes[0].report.history.bytes = 999999;
  assert.notEqual(clock.report().contextSizes![0].report.history.bytes, 999999);
  const beforeInvalid = clock.report().contextSizes;
  clock.contextSize({ ...sample, content: "private-content" } as typeof sample);
  assert.deepEqual(clock.report().contextSizes, beforeInvalid);
  assert.equal(
    contextSizeReportSchema.safeParse({
      ...sample,
      history: {
        ...sample.history,
        largest: [{ ...sample.history.largest[0], content: "private-content" }],
      },
    }).success,
    false,
  );
  const valid = clock.report();
  journal.checkpoint("run", "generation", 1, "decision", { timing: valid });
  journal.checkpoint("run", "generation", 1, "finished", { status: "failed", timing: valid });
  const exported = journal.diagnostic().journal;
  assert.equal(exported.length, 1);
  assert.deepEqual(exported[0].timing, valid);
  assert.doesNotMatch(JSON.stringify(exported), /private-content/);
});
