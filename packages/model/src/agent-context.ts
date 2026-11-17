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
function summaryCutoff(
  messages: BaseMessage[],
  fitsRetention: (retained: BaseMessage[]) => boolean,
  summaryInputLimit: number,
) {
  const boundaries = [0];
  const pending = new Set<string>();
  for (const [index, message] of messages.entries()) {
    if (message instanceof AIMessage) {
      if (pending.size) throw Error("SUMMARY_TOOL_PAIR_INVALID");
      for (const call of [...(message.tool_calls ?? []), ...(message.invalid_tool_calls ?? [])]) {
        if (!call.id || pending.has(call.id)) throw Error("SUMMARY_TOOL_PAIR_INVALID");
        pending.add(call.id);
      }
    } else if (message instanceof ToolMessage && !pending.delete(message.tool_call_id))
      throw Error("SUMMARY_TOOL_PAIR_INVALID");
    if (!pending.size) boundaries.push(index + 1);
  }

  // 待返回调用始终留在尾部。向前扩大保留区时，现场引用省下的体积至多等于其来源内容的体积。
  let left = 0;
  let right = boundaries.length - 1;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (fitsRetention(messages.slice(boundaries[middle]))) right = middle;
    else left = middle + 1;
  }
  const preferred = boundaries[left];
  const fitsSummary = (cutoff: number) => {
    const content = summaryPrompt.replace("{messages}", getBufferString(messages.slice(0, cutoff)));
    return estimateTokens([{ role: "user", content }]) <= summaryInputLimit;
  };
  if (!preferred || fitsSummary(preferred)) return preferred;

  // 摘要请求有独立窗口。保留更多完整消息组来缩小摘要输入，最终决策仍按实际预算校验。
  right = left - 1;
  left = 0;
  while (left < right) {
    const middle = Math.ceil((left + right) / 2);
    if (fitsSummary(boundaries[middle])) left = middle;
    else right = middle - 1;
  }
  // 若第一组本身超限，交给摘要入口记录体积并报错，禁止裁剪原文或发送请求。
  return boundaries[left] || preferred;
}

const inputLimit = (budget: ContextBudget) => budget.contextTokens - budget.outputTokens - 1024;

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
      if (estimateTokens(messages) > inputLimit(budget)) throw Error("SUMMARY_INPUT_TOO_LARGE");
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
    keep: { messages: 0 },
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
    const remaining = inputLimit(budget) - protectedTokens - estimateTokens(tools);
    return { budget, remaining, protectedMessages, tools };
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
        measuredContext = allowance(state.messages);
        const { remaining } = measuredContext;
        if (remaining < 256) throw Error("MODEL_CONTEXT_CONFIGURATION_TOO_SMALL");
        observeSize("before-summary", state.messages);
        const historyTokens = messageTokens(state.messages);
        if (historyTokens < Math.floor(remaining * 0.8)) {
          observeSize("unchanged", state.messages);
          return;
        }

        // 保留历史可为当前现场提供引用，只计入它相对完整现场净增加的体积。
        const fullContext = allowance([]).remaining;
        const summaryRoom = fullContext - Math.floor(fullContext * 0.3);
        const cutoff = summaryCutoff(
          state.messages,
          (retained) => allowance(retained).remaining - messageTokens(retained) >= summaryRoom,
          inputLimit(measuredContext.budget),
        );
        const result = await hook(state, {
          ...runtime,
          context: {
            summaryPrompt,
            keep: { messages: state.messages.length - cutoff },
          },
        });
        // 官方默认把摘要异常转换成占位文字。只在实际收到有效摘要后提交消息更新。
        if (attempt.failure) throw attempt.failure;
        await options.guard();
        if (result?.messages) {
          const replacement = result.messages;
          const compacted = replacement.slice(1) as BaseMessage[];
          candidate = compacted;
          const preserved = state.messages.slice(cutoff);
          if (
            compacted.length !== preserved.length + 1 ||
            preserved.some((message, index) => message !== compacted[index + 1])
          )
            throw Error("SUMMARY_TOOL_PAIR_INVALID");
          const source = state.messages.slice(0, cutoff);
          if (!attempt.summary || !attempt.submitted?.includes(getBufferString(source)))
            throw Error("SUMMARY_INPUT_TRUNCATED");
          const required = messageTokens(candidate);
          measuredContext = allowance(candidate);
          const { remaining: available } = measuredContext;
          if (available < 256) throw Error("MODEL_CONTEXT_CONFIGURATION_TOO_SMALL");
          observeSize("after-summary", state.messages, candidate);
          if (required > available) throw Error("CONTEXT_SUMMARY_NOT_REDUCED");
          return result;
        }
        if (historyTokens > remaining) throw Error("MODEL_CONTEXT_TOO_LARGE");
        observeSize("unchanged", state.messages);
      } catch (error) {
        observeSize("error", state.messages, candidate, error);
        throw error;
      }
    },
  });
}
