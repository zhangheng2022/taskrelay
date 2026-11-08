import test from "node:test";
import assert from "node:assert/strict";
import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { JsonPlusSerializer } from "@langchain/langgraph-checkpoint";
import { SessionCheckpointer } from "../apps/desktop/src/executor/session-checkpointer";
import {
  runExecutionGraph,
  type ExecutionGraphPort,
} from "../apps/desktop/src/executor/execution-graph";
import { smokeExecutionGraph } from "../apps/desktop/src/executor/graph-smoke";
import type { Message, ModelResponse } from "../packages/model/src/index";
import type { ContextSizeReport } from "../packages/contracts/src/context-diagnostics";
import { compactPageUrls } from "../apps/desktop/src/executor/page-context";

const response = (calls: ModelResponse["calls"] = [], text = ""): ModelResponse => ({
  text,
  calls,
  usage: { input: null, output: null },
});
const call = (id: string, name = "act") => ({
  id,
  name,
  arguments: JSON.stringify(name === "ask" ? { message: "请提供验证码" } : { instruction: id }),
});

test("安装 smoke 使用真实执行图验证包内工具消息与协助中断恢复", async () => {
  assert.deepEqual(await smokeExecutionGraph(), {
    langgraphExecution: true,
    langchainToolMessages: true,
    graphInterruptResume: true,
    graphToolExecutions: 1,
    graphHelpRegistrations: 1,
  });
});

function harness(turns: ModelResponse[]) {
  const sent: Message[][] = [],
    performed: string[] = [],
    recorded: unknown[] = [];
  let userSeq = 1,
    registered = 0,
    polled = 0,
    consumed = 0,
    final = "";
  const port: ExecutionGraphPort = {
    guard: () => {},
    observe: async () => ({
      messages: [
        { role: "system", content: "执行测试" },
        {
          role: "user",
          content: JSON.stringify({ userMessages: [{ content: "完整秘密输入 0012Ab" }], userSeq }),
        },
      ],
      userSeq,
    }),
    decide: async (messages) => {
      sent.push(messages);
      return { response: turns.shift() ?? response([], "完成") };
    },
    changed: async (seq) => seq !== userSeq,
    perform: async (tool) => {
      performed.push(tool.id);
      return { observed: true };
    },
    registerHelp: async (args) => {
      registered++;
      return {
        request: {
          id: "stable_help",
          message: String(args.message),
          origin: "https://example.com",
        },
        answer: { ready: false },
      };
    },
    pollHelp: async (request) => {
      polled++;
      assert.equal(request.id, "stable_help");
      userSeq++;
      return { ready: true, message: "0012" };
    },
    consumeHelp: async (request, answer) => {
      consumed++;
      assert.equal(request.id, "stable_help");
      return answer.message;
    },
    record: (_call, result) => {
      recorded.push(result);
    },
    error: async () => {},
    say: async () => {},
    finish: async (text) => {
      final = text;
      return true;
    },
  };
  return {
    port,
    sent,
    performed,
    recorded,
    change: () => {
      userSeq++;
    },
    result: () => ({ registered, polled, consumed, final }),
  };
}

test("实际执行图在摘要移走引用目标后恢复完整现场，并按实际保护输入重新计算预算", async () => {
  const h = harness([]),
    sizes: ContextSizeReport[] = [];
  const url = "https://example.com/login?state=" + "x".repeat(3000);
  const page = compactPageUrls({
    url,
    title: "旧现场仍是当前现场",
    tabs: [{ index: 0, url }],
    loading: { readyState: "complete" },
  });
  let summaries = 0;
  h.port.budget = () => ({ contextTokens: 10000, outputTokens: 1024 });
  h.port.contextSize = (report) => sizes.push(report);
  h.port.observe = async () => ({
    userSeq: 1,
    messages: [
      { role: "system", content: "执行测试" },
      {
        role: "user",
        content: JSON.stringify({ userMessages: [{ content: "完整原文" }], untrustedPage: page }),
      },
    ],
    history: [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "old", type: "function", function: { name: "act", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "old",
        content: JSON.stringify({ observation: page, feedback: { success: true } }),
      },
      { role: "user", content: "最新事实" + "x".repeat(8000) },
    ],
  });
  h.port.decide = async (messages, purpose) => {
    if (purpose === "summary") {
      summaries++;
      return { response: response([], "旧操作已返回，并已观察页面；保留当前完整现场。") };
    }
    h.sent.push(messages);
    return { response: response([], "完成") };
  };
  await runExecutionGraph(h.port);
  assert.equal(summaries, 1);
  assert.equal(h.sent.length, 1);
  const payload = JSON.parse(h.sent[0][1].content);
  assert.equal(payload.untrustedPage.url, url);
  assert.deepEqual(payload.userMessages, [{ content: "完整原文" }]);
  assert.ok(!h.sent[0].some((m) => m.tool_call_id === "old"));
  const before = sizes.find((s) => s.phase === "before-summary")!,
    after = sizes.find((s) => s.phase === "after-summary")!;
  assert.ok(
    after.protectedMessages.estimatedTokens > before.protectedMessages.estimatedTokens + 1000,
  );
  assert.ok(after.replacement!.estimatedTokens <= after.budget.historyAllowanceTokens);
  assert.equal(h.performed.length, 0);
});

test("图中断恢复只登记一次协助，不重跑前一浏览器动作，未执行调用保留原生配对", async () => {
  const h = harness([
    response([call("before"), call("help", "ask"), call("stale")]),
    response([call("after")]),
    response([], "已完成"),
  ]);
  await runExecutionGraph(h.port);
  assert.deepEqual(h.performed, ["before", "after"]);
  assert.deepEqual(h.result(), { registered: 1, polled: 1, consumed: 1, final: "已完成" });
  const followup = h.sent[1];
  assert.deepEqual(
    followup.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
    ["before", "help", "stale"],
  );
  assert.match(followup.find((m) => m.tool_call_id === "stale")!.content, /REPLAN_AFTER_HELP/);
  assert.equal(followup.find((m) => m.tool_call_id === "help")!.content, '"0012"');
});

test("同批工具严格串行，用户补充使剩余调用失效而不是并发执行", async () => {
  const h = harness([response([call("first"), call("second")]), response([], "已按新要求处理")]);
  let active = 0,
    maxActive = 0;
  h.port.perform = async (tool) => {
    active++;
    maxActive = Math.max(active, maxActive);
    await Promise.resolve();
    h.performed.push(tool.id);
    h.change();
    active--;
    return "done";
  };
  await runExecutionGraph(h.port);
  assert.equal(maxActive, 1);
  assert.deepEqual(h.performed, ["first"]);
  const cancelled = h.sent[1].find((m) => m.tool_call_id === "second");
  assert.match(cancelled!.content, /INSTRUCTIONS_CHANGED/);
  assert.deepEqual(
    h.sent[1].filter((m) => m.role === "tool").map((m) => m.tool_call_id),
    ["first", "second"],
  );
});

test("工具异常和非法参数均回到模型，不重试副作用且保持调用结果配对", async () => {
  const invalid = { id: "invalid", name: "act", arguments: "{broken" };
  const h = harness([response([call("error"), invalid]), response([], "受阻")]);
  let attempted = 0;
  h.port.perform = async () => {
    attempted++;
    throw Error("SENT_RESULT_UNKNOWN");
  };
  await runExecutionGraph(h.port);
  assert.equal(attempted, 1);
  assert.equal(h.result().final, "受阻");
  assert.deepEqual(
    h.sent[1].filter((m) => m.role === "tool").map((m) => m.tool_call_id),
    ["error", "invalid"],
  );
  assert.match(h.sent[1].find((m) => m.tool_call_id === "error")!.content, /SENT_RESULT_UNKNOWN/);
});

test("官方摘要保留近期工具配对，用户原文不进入摘要", async () => {
  const h = harness([response([call("first")]), response([call("second")]), response([], "完成")]);
  const decide = h.port.decide.bind(h.port);
  const summaries: Message[][] = [];
  h.port.budget = () => ({ contextTokens: 11000, outputTokens: 1024 });
  h.port.perform = async (tool) => {
    h.performed.push(tool.id);
    return { feedback: tool.id === "first" ? "x".repeat(12000) : "近期结果" };
  };
  h.port.decide = async (messages, purpose) => {
    if (purpose === "summary") {
      summaries.push(messages);
      return { response: response([], "已完成 first，结果已读取。") };
    }
    return decide(messages, purpose);
  };
  await runExecutionGraph(h.port);
  assert.ok(summaries.length > 0);
  assert.doesNotMatch(JSON.stringify(summaries), /0012Ab/);
  assert.match(JSON.stringify(h.sent[2]), /0012Ab/);
  assert.deepEqual(
    h.sent[2].filter((m) => m.role === "tool").map((m) => m.tool_call_id),
    ["second"],
  );
  assert.deepEqual(
    h.sent[2].find((m) => m.role === "assistant")!.tool_calls?.map((c) => c.id),
    ["second"],
  );
});

test("无用户变更的三个工具全部按原始顺序执行，最大并发为一", async () => {
  const h = harness([response([call("a"), call("b"), call("c")]), response([], "完成")]);
  let active = 0,
    max = 0;
  h.port.perform = async (tool) => {
    active++;
    max = Math.max(max, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.performed.push(tool.id);
    active--;
    return { ok: true };
  };
  await runExecutionGraph(h.port);
  assert.deepEqual(h.performed, ["a", "b", "c"]);
  assert.equal(max, 1);
});

test("空模型回复仅允许一次有反馈的纠正，未知模型结果不重发", async () => {
  const h = harness([response(), response()]);
  await assert.rejects(runExecutionGraph(h.port), /MODEL_EMPTY_REPLY/);
  assert.equal(h.sent.length, 2);
  assert.match(JSON.stringify(h.sent[1]), /上一条模型回复为空/);
  let calls = 0;
  h.port.decide = async () => {
    calls++;
    throw Error("MODEL_CALL_OUTCOME_UNKNOWN");
  };
  await assert.rejects(runExecutionGraph(h.port), /MODEL_CALL_OUTCOME_UNKNOWN/);
  assert.equal(calls, 1);
});

test("普通最终文字结束；提交期间新指令保留同一线程历史继续", async () => {
  const h = harness([response([call("done")]), response([], "旧答复"), response([], "新答复")]);
  let finishes = 0;
  h.port.finish = async (text) => {
    if (++finishes === 1) {
      h.change();
      return false;
    }
    assert.equal(text, "新答复");
    return true;
  };
  await runExecutionGraph(h.port);
  assert.equal(finishes, 2);
  assert.deepEqual(h.performed, ["done"]);
  assert.match(JSON.stringify(h.sent[2]), /旧答复/);
  assert.equal(JSON.parse(h.sent[2][1].content).userSeq, 2);
});

test("同代 checkpoint 保留最新和父节点，超过默认步数后可中断恢复但全新 saver 不能恢复", async () => {
  const serializer = new JsonPlusSerializer();
  let typedReads = 0;
  const saver = new SessionCheckpointer({
    dumpsTyped: async (value) => {
      const [type, bytes] = await serializer.dumpsTyped(value);
      return [`session:${type}`, bytes];
    },
    loadsTyped: async (type, bytes) => {
      assert.ok(type.startsWith("session:"));
      typedReads++;
      return serializer.loadsTyped(type.slice(8), bytes);
    },
  });
  const State = Annotation.Root({
    count: Annotation<number>({ reducer: (_, v) => v, default: () => 0 }),
    reply: Annotation<string>(),
    payload: Annotation<Uint8Array>(),
  });
  let effects = 0;
  const graph = new StateGraph(State)
    .addNode("step", (state) => {
      effects++;
      return { count: state.count + 1 };
    })
    .addNode("wait", () => ({ reply: interrupt<string, string>("验证码") }))
    .addEdge(START, "step")
    .addConditionalEdges("step", (state) => (state.count < 40 ? "step" : "wait"), ["step", "wait"])
    .addEdge("wait", END)
    .compile({ checkpointer: saver });
  const config = {
    configurable: { thread_id: "one_generation" },
    recursionLimit: Infinity,
    durability: "sync" as const,
  };
  await graph.invoke({ payload: new Uint8Array([0, 127, 255]) }, config);
  assert.equal(effects, 40);
  assert.ok((await graph.getState(config)).tasks.some((t) => t.interrupts?.length));
  let snapshots = 0;
  for await (const _ of saver.list(config)) snapshots++;
  assert.equal(snapshots, 2);
  await graph.invoke(new Command({ resume: "0012" }), config);
  assert.equal(effects, 40);
  assert.equal((await graph.getState(config)).values.reply, "0012");
  assert.deepEqual((await graph.getState(config)).values.payload, new Uint8Array([0, 127, 255]));
  snapshots = 0;
  for await (const _ of saver.list(config)) snapshots++;
  assert.equal(snapshots, 2);
  assert.equal(await new SessionCheckpointer().getTuple(config), undefined);
  assert.ok(typedReads > 0);
  await saver.deleteThread("one_generation");
  assert.equal(await saver.getTuple(config), undefined);
});
