/** 官方 createAgent 接管决策与工具循环；本适配器只维护串行执行、租约边界、
 * 同代协助恢复与最终提交。协助先 interrupt，云端登记由外层驱动完成，禁止重放浏览器操作。 */
import { Command, interrupt, isGraphInterrupt } from "@langchain/langgraph";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { createAgent, createMiddleware } from "langchain";
import pLimit from "p-limit";
import type { z } from "zod";
import type { Message, ModelResponse } from "../../../../packages/model/src/index";
import type { ContextSizeReport } from "../../../../packages/contracts/src/context-diagnostics";
import {
  fromLangChainMessages,
  toLangChainMessages,
  aiMessageToModelResponse,
} from "../../../../packages/model/src/langchain";
import {
  CallbackChatModel,
  protectedSummary,
  type ContextBudget,
} from "../../../../packages/model/src/agent-context";
import {
  executorArguments,
  executorTools,
  type ExecutionHelp,
  type HelpResponse,
} from "../../../../packages/contracts/src/execution";
import { SessionCheckpointer } from "./session-checkpointer";
import { referencePageContext } from "./page-context";

export type ExecutorCall = ModelResponse["calls"][number];
export interface ExecutionGraphPort {
  guard(): void;
  observe(): Promise<{ messages: Message[]; userSeq: number; history?: Message[] }>;
  decide(
    messages: Message[],
    purpose: "decision" | "summary",
  ): Promise<{ response: ModelResponse }>;
  budget?(): ContextBudget;
  contextSize?(report: ContextSizeReport): void;
  history?(messages: Message[]): void;
  changed(userSeq: number): Promise<boolean>;
  perform(call: ExecutorCall, args: Record<string, unknown>, userSeq: number): Promise<unknown>;
  registerHelp(
    args: Record<string, unknown>,
    call: ExecutorCall,
  ): Promise<{ request: ExecutionHelp; answer: HelpResponse }>;
  pollHelp(request: ExecutionHelp): Promise<HelpResponse>;
  consumeHelp(request: ExecutionHelp, answer: HelpResponse): Promise<unknown>;
  record(call: ExecutorCall, result: unknown): void | Promise<void>;
  error(call: ExecutorCall, error: Error): Promise<void>;
  say(text: string, eventId: string): Promise<unknown>;
  finish(text: string, userSeq: number): Promise<boolean>;
}
interface HelpResume {
  request: ExecutionHelp;
  answer: HelpResponse;
}
interface HelpInterrupt {
  kind: "execution-help";
  call: ExecutorCall;
  args: Record<string, unknown>;
}
interface Slot {
  call: ExecutorCall;
  prior: Promise<void>;
  done: { promise: Promise<void>; resolve: () => void };
  invalid: boolean;
  interrupted: boolean;
}
const resultMessage = (call: ExecutorCall, result: unknown) =>
  new ToolMessage({
    tool_call_id: call.id,
    name: call.name,
    content: JSON.stringify(result) ?? "null",
  });

export async function runExecutionGraph(port: ExecutionGraphPort) {
  for (const name of [
    "LANGSMITH_TRACING",
    "LANGCHAIN_TRACING_V2",
    "LANGCHAIN_TRACING",
    "LANGCHAIN_VERBOSE",
  ]) {
    const value = getEnvironmentVariable(name);
    if (value && value !== "false" && value !== "0") throw Error("AI_EXTERNAL_TRACING_DISABLED");
  }
  const saver = new SessionCheckpointer(),
    threadId = crypto.randomUUID(),
    serial = pLimit(1);
  const config = {
    configurable: { thread_id: threadId },
    recursionLimit: Infinity,
    callbacks: [],
    durability: "sync" as const,
  };
  let protectedMessages: BaseMessage[] = [],
    userSeq = 0,
    emptyReplies = 0;
  let batch = { slots: new Map<string, Slot>(), frozen: false };
  const model = new CallbackChatModel(
    async (messages) => (await port.decide(messages, "decision")).response,
  );
  const summaryModel = new CallbackChatModel(
    async (messages) => (await port.decide(messages, "summary")).response,
  );
  const tools = executorTools.map((definition) => {
    const schema: z.ZodObject =
      executorArguments[definition.name as keyof typeof executorArguments];
    return tool(
      async (args, config) => {
        const slot = batch.slots.get(config.toolCall?.id ?? "");
        if (!slot) throw Error("TOOL_BATCH_MISMATCH");
        if (["ask", "requestAccountUpdate"].includes(slot.call.name)) {
          batch.frozen = true;
          slot.interrupted = true;
          // 不在 interrupt 之前创建协助 ID、发送网络请求或保存截图。
          const resumed = interrupt<HelpInterrupt, HelpResume>({
            kind: "execution-help",
            call: slot.call,
            args,
          });
          port.guard();
          return JSON.stringify(await port.consumeHelp(resumed.request, resumed.answer)) ?? "null";
        }
        return JSON.stringify(await port.perform(slot.call, args, userSeq)) ?? "null";
      },
      { name: definition.name, description: definition.description, schema },
    );
  });
  const boundary = createMiddleware({
    name: "ExecutorBoundary",
    beforeModel: async () => {
      port.guard();
      const observed = await port.observe();
      protectedMessages = toLangChainMessages(observed.messages);
      userSeq = observed.userSeq;
      if (observed.history?.length) return { messages: toLangChainMessages(observed.history) };
    },
    wrapModelCall: async (request, handler) => {
      port.guard();
      port.history?.(fromLangChainMessages(request.messages));
      return handler({
        ...request,
        messages: [
          ...referencePageContext(protectedMessages, request.messages),
          ...request.messages,
        ],
      });
    },
    afterModel: async (state) => {
      port.guard();
      const response = state.messages.at(-1);
      if (!(response instanceof AIMessage)) throw Error("MODEL_INVALID_RESPONSE");
      const calls = aiMessageToModelResponse(response).calls;
      batch = { slots: new Map(), frozen: false };
      let prior = Promise.resolve();
      const invalid = new Set(response.invalid_tool_calls?.map((call) => call.id));
      for (const call of calls) {
        if (!call.id || batch.slots.has(call.id)) throw Error("MODEL_TOOL_CALL_ID_INVALID");
        let resolve = () => {};
        const promise = new Promise<void>((accept) => {
          resolve = accept;
        });
        const done = { promise, resolve };
        batch.slots.set(call.id, {
          call,
          prior,
          done,
          invalid: invalid.has(call.id),
          interrupted: false,
        });
        prior = done.promise;
      }
      if (calls.length) {
        emptyReplies = 0;
        if (
          typeof response.content === "string" &&
          response.content.trim() &&
          !calls.some((call) =>
            ["ask", "offerAccountSave", "requestAccountUpdate"].includes(call.name),
          )
        )
          await port.say(response.content, calls[0].id);
      }
      // 框架只调度原生 tool_calls。无效 JSON 保留原 ID 和顺序，进入校验反馈，绝不执行。
      if (invalid.size) {
        const updated = new AIMessage({
          ...response.toDict().data,
          id: response.id,
          invalid_tool_calls: [],
          tool_calls: calls.map((call) => ({
            id: call.id,
            name: call.name,
            args: invalid.has(call.id) ? {} : JSON.parse(call.arguments),
            type: "tool_call" as const,
          })),
        });
        return { messages: [updated] };
      }
    },
    wrapToolCall: async (request, handler) => {
      const slot = batch.slots.get(request.toolCall.id ?? "");
      if (!slot) throw Error("TOOL_BATCH_MISMATCH");
      // 框架 v2 可同时派发多个 Send。先等待原始调用序号，再进入 p-limit(1)；
      // 不依赖回调抵达顺序或 maxConcurrency，且中断时余下调用均有无副作用反馈。
      await slot.prior;
      return serial(async () => {
        let result: ToolMessage;
        try {
          port.guard();
          if (batch.frozen && !slot.interrupted)
            result = resultMessage(slot.call, { error: "REPLAN_AFTER_HELP", executed: false });
          else if (!slot.interrupted && (await port.changed(userSeq)))
            result = resultMessage(slot.call, { error: "INSTRUCTIONS_CHANGED", executed: false });
          else {
            if (slot.invalid) throw Error("MODEL_TOOL_ARGUMENTS_INVALID");
            if (!Object.hasOwn(executorArguments, slot.call.name))
              throw Error("TOOL_NOT_AVAILABLE");
            const schema = executorArguments[slot.call.name as keyof typeof executorArguments];
            if (!schema.safeParse(request.toolCall.args).success)
              throw Error("TOOL_ARGUMENTS_INVALID");
            const output = await handler(request);
            if (!(output instanceof ToolMessage)) throw Error("TOOL_RESULT_INVALID");
            result = output;
          }
        } catch (error) {
          if (isGraphInterrupt(error)) throw error;
          port.guard();
          await port.error(slot.call, error as Error);
          result = resultMessage(slot.call, { error: (error as Error).message });
        } finally {
          slot.done.resolve();
        }
        await port.record(
          slot.call,
          typeof result.content === "string" ? JSON.parse(result.content) : result.content,
        );
        return result;
      });
    },
  });
  const summary = protectedSummary({
    model: summaryModel,
    budget: () => port.budget?.() ?? { contextTokens: 16000, outputTokens: 4096 },
    protectedMessages: (history) => referencePageContext(protectedMessages, history),
    tools: () => executorTools,
    guard: () => port.guard(),
    onContextSize: port.contextSize ? (report) => port.contextSize?.(report) : undefined,
  });
  const agent = createAgent({
    model,
    tools,
    version: "v2",
    checkpointer: saver,
    middleware: [boundary, summary],
  });
  try {
    let input: Parameters<typeof agent.invoke>[0] = {
      messages: [new HumanMessage("依据受保护的用户原文、当前现场和执行历史处理任务。")],
    };
    for (;;) {
      const result = await agent.invoke(input, config);
      const state = await agent.graph.getState(config);
      const pauses = state.tasks.flatMap((task) => task.interrupts ?? []);
      if (pauses.length) {
        if (pauses.length !== 1) throw Error("GRAPH_UNEXPECTED_PAUSE");
        const pause = pauses[0].value as HelpInterrupt;
        if (pause.kind !== "execution-help" || !batch.slots.has(pause.call.id))
          throw Error("GRAPH_UNEXPECTED_PAUSE");
        port.guard();
        const registered = await port.registerHelp(pause.args, pause.call);
        const answer = registered.answer.ready
          ? registered.answer
          : await port.pollHelp(registered.request);
        port.guard();
        input = new Command({
          resume: { request: registered.request, answer } satisfies HelpResume,
        });
        continue;
      }
      if (state.next.length) throw Error("GRAPH_UNEXPECTED_PAUSE");
      const last = result.messages.at(-1),
        text = last instanceof AIMessage && typeof last.content === "string" ? last.content : "";
      port.guard();
      if (!text.trim()) {
        if (++emptyReplies > 1) throw Error("MODEL_EMPTY_REPLY");
        await port.record(
          { id: "empty", name: "model", arguments: "{}" },
          { error: "MODEL_EMPTY_REPLY" },
        );
        input = {
          messages: [
            new HumanMessage("上一条模型回复为空。请依据已有事实调用必要工具或给出非空最终回复。"),
          ],
        };
        continue;
      }
      if (!(await port.changed(userSeq)) && (await port.finish(text, userSeq))) return;
      input = {
        messages: [
          new HumanMessage(
            "最终提交前收到新指令，请结合最新用户原文继续。已执行操作保留，不要自动重放。",
          ),
        ],
      };
    }
  } finally {
    await saver.deleteThread(threadId);
  }
}
