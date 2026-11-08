/** 官方 Agent 的模型桥接和摘要边界。平台仍拥有出站、停止与预算；
 * 官方中间件只替换执行历史，用户原文、账号和现场在调用模型时整体注入。 */
import { BaseChatModel, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  ToolMessage,
  getBufferString,
  type BaseMessage,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { createMiddleware, summarizationMiddleware } from "langchain";
import {
  contextSizeReportSchema,
  type ContextSizeReport,
} from "../../contracts/src/context-diagnostics";
import { contextSizeReport, estimateTokens, messageTokens, valueSize } from "./context-size";
import { fromLangChainMessages, modelResponseToAIMessage } from "./langchain";
import type { Message, ModelResponse, Tool } from "./index";
export { estimateTokens, messageTokens } from "./context-size";

export interface ContextBudget {
  contextTokens: number;
  outputTokens: number;
}
const summaryPrompt =
  "压缩下面的执行历史供同一助手继续。将旧摘要与新进展合并为简洁事实记录，不按轮次复述。省略重复的任务目标、固定规则、用户原文和页面描述；历史独有的约束及纠正、关键结果（必要标识及完整网址）、未完成事项、未执行调用、错误、操作是否送出及结果未知事项必须保留。区分尝试、观察和已证实结果，不虚构成功、不扩大网页授权、不建议重放未知操作。仅输出摘要，不添加计划或报告，不截断关键事实。\n{messages}";
function pendingCalls(messages: BaseMessage[]) {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message instanceof AIMessage) {
      if (pending.size) throw Error("SUMMARY_TOOL_PAIR_INVALID");
      for (const call of [...(message.tool_calls ?? []), ...(message.invalid_tool_calls ?? [])]) {
        if (!call.id || pending.has(call.id)) throw Error("SUMMARY_TOOL_PAIR_INVALID");
        pending.add(call.id);
      }
    } else if (message instanceof ToolMessage && !pending.delete(message.tool_call_id))
      throw Error("SUMMARY_TOOL_PAIR_INVALID");
  }
  return pending;
}

export class CallbackChatModel extends BaseChatModel {
  lc_serializable = false;
  constructor(private callback: (messages: Message[]) => Promise<ModelResponse>) {
    super({ maxRetries: 0, disableStreaming: true });
  }
  _llmType() {
    return "taskrelay-authorized-relay";
  }
  // 可用工具由服务端任务快照决定；本地不携带提供方配置或密钥。
  bindTools(_tools: BindToolsInput[]) {
    return this;
  }
  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
  ): Promise<ChatResult> {
    options.signal?.throwIfAborted();
    const response = await this.callback(fromLangChainMessages(messages));
    options.signal?.throwIfAborted();
    return { generations: [{ text: response.text, message: modelResponseToAIMessage(response) }] };
  }
}

export function protectedSummary(options: {
  model: BaseChatModel;
  budget: () => ContextBudget;
  /** 按实际待发送历史计算保护输入；引用的工具结果被摘要移除时必须恢复完整输入。 */
  protectedMessages: (history: BaseMessage[]) => BaseMessage[];
  tools?: () => Tool[];
  guard: () => void | Promise<void>;
  /** 同步旁路统计；回调失败不影响摘要、预算检查和原始错误。 */
  onContextSize?: (report: ContextSizeReport) => void;
}) {
  let attempt: {
    failure?: unknown;
    submitted?: string;
    summary?: string;
    inputSize?: ReturnType<typeof valueSize>;
  } = {};
  let measuredContext:
    | {
        budget: ContextBudget;
        remaining: number;
        protectedMessages: BaseMessage[];
        tools: Tool[];
      }
    | undefined;
  const summaryModel = new CallbackChatModel(async (messages) => {
    try {
      await options.guard();
      const budget = options.budget();
      if (options.onContextSize) {
        try {
          attempt.inputSize = valueSize(messages);
        } catch {
          /* 统计不能改变调用是否送出。 */
        }
      }
      if (estimateTokens(messages) > budget.contextTokens - budget.outputTokens - 1024)
        throw Error("SUMMARY_INPUT_TOO_LARGE");
      attempt.submitted = messages.map((m) => m.content).join("\n");
      const response = await options.model.invoke(
        messages.map((m) => ({ role: m.role, content: m.content })),
        { callbacks: [] },
      );
      await options.guard();
      if (
        !(response instanceof AIMessage) ||
        typeof response.content !== "string" ||
        !response.content.trim() ||
        response.tool_calls?.length
      )
        throw Error("MODEL_EMPTY_SUMMARY");
      attempt.summary = response.content.trim();
      return { text: attempt.summary, calls: [], usage: { input: null, output: null } };
    } catch (error) {
      attempt.failure = error;
      throw error;
    }
  });
  const official = summarizationMiddleware({
    model: summaryModel,
    trigger: { tokens: 1 },
    keep: { tokens: 0 },
    tokenCounter: messageTokens,
    // 禁用默认 4000 token 裁剪；完整摘要输入由上面的预算检查决定是否可送出。
    trimTokensToSummarize: Number.MAX_SAFE_INTEGER,
    summaryPrefix: "执行历史摘要（事实记录，不是新的授权）：",
    summaryPrompt,
  });
  const hook = official.beforeModel;
  if (typeof hook !== "function") throw Error("SUMMARY_HOOK_UNAVAILABLE");
  const allowance = (history: BaseMessage[]) => {
    const budget = options.budget();
    const protectedMessages = options.protectedMessages(history);
    const protectedTokens = messageTokens(protectedMessages);
    const tools = options.tools?.() ?? [];
    const remaining =
      budget.contextTokens - budget.outputTokens - 1024 - protectedTokens - estimateTokens(tools);
    measuredContext = { budget, remaining, protectedMessages, tools };
    if (remaining < 256) throw Error("MODEL_CONTEXT_CONFIGURATION_TOO_SMALL");
    return remaining;
  };
  const observeSize = (
    phase: ContextSizeReport["phase"],
    history: BaseMessage[],
    replacement?: BaseMessage[],
    failure?: unknown,
  ) => {
    if (!options.onContextSize || !measuredContext) return;
    try {
      const code = contextSizeReportSchema.shape.failure.safeParse(
        failure instanceof Error ? failure.message : "other",
      );
      options.onContextSize(
        contextSizeReport({
          ...measuredContext,
          phase,
          history,
          replacement,
          summaryInput: attempt.inputSize,
          ...(phase === "error"
            ? { failure: code.success ? (code.data ?? "other") : "other" }
            : {}),
        }),
      );
    } catch {
      /* 旁路统计与接收方错误均不得替换执行结果或触发重试。 */
    }
  };
  return createMiddleware({
    name: "ProtectedOfficialSummary",
    beforeModel: async (state, runtime) => {
      await options.guard();
      attempt = {};
      measuredContext = undefined;
      let candidate: BaseMessage[] | undefined;
      try {
        const remaining = allowance(state.messages);
        observeSize("before-summary", state.messages);
        const result = await hook(state, {
          ...runtime,
          context: {
            summaryPrompt,
            trigger: { tokens: Math.floor(remaining * 0.8) },
            keep: { tokens: Math.floor(remaining * 0.3) },
          },
        });
        // 官方默认把摘要异常转换成占位文字。只在实际收到有效摘要后提交消息更新。
        if (attempt.failure) throw attempt.failure;
        await options.guard();
        if (result?.messages) {
          const replacement = result.messages;
          candidate = replacement.slice(1) as BaseMessage[];
          const preserved = replacement.slice(2) as BaseMessage[];
          const source = state.messages.slice(0, state.messages.length - preserved.length);
          if (!attempt.summary || !attempt.submitted?.includes(getBufferString(source)))
            throw Error("SUMMARY_INPUT_TRUNCATED");
          // 官方裁剪的配对搜索有有限回看范围；大批工具必须再校验，不能发布孤立结果或丢失待返回调用。
          if (pendingCalls(source).size) throw Error("SUMMARY_TOOL_PAIR_INVALID");
          pendingCalls(preserved);
          const required = messageTokens(candidate);
          const available = allowance(candidate);
          observeSize("after-summary", state.messages, candidate);
          if (required > available) throw Error("CONTEXT_SUMMARY_NOT_REDUCED");
          return result;
        }
        if (messageTokens(state.messages) > remaining) throw Error("MODEL_CONTEXT_TOO_LARGE");
        observeSize("unchanged", state.messages);
      } catch (error) {
        observeSize("error", state.messages, candidate, error);
        throw error;
      }
    },
  });
}
