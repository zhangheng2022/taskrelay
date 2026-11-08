/** 上下文的本地估算与只读体积统计。沿用原 UTF-8 字节/2 和每消息 16 的估算，
 * 不访问 tokenizer/网络，不修改消息，不返回内容；字段统计只展开固定白名单。 */
import type { BaseMessage } from "@langchain/core/messages";
import {
  contextLargestLimit,
  contextSectionSchema,
  contextToolSchema,
  type ContextSizeReport,
} from "../../contracts/src/context-diagnostics";
import { fromLangChainMessages } from "./langchain";

export function valueSize(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  return { bytes, estimatedTokens: Math.ceil(bytes / 2) };
}
/** 与原预算检查相同的保守估算，不是提供方计费用量。 */
export const estimateTokens = (value: unknown) => valueSize(value).estimatedTokens;
export const messageTokens = (messages: BaseMessage[]) =>
  estimateTokens(fromLangChainMessages(messages)) + messages.length * 16;

function messageTotal(messages: BaseMessage[]) {
  const size = valueSize(fromLangChainMessages(messages));
  return {
    ...size,
    estimatedTokens: size.estimatedTokens + messages.length * 16,
    messages: messages.length,
  };
}
type Section = ContextSizeReport["history"]["largest"][number]["sections"][number];
function sections(content: string): Section[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const root = parsed as Record<string, unknown>;
  const result: Section[] = [];
  const add = (name: string, value: unknown) => {
    const field = contextSectionSchema.safeParse(name);
    if (!field.success || value === undefined) return;
    const entry: Section = { section: field.data, ...valueSize(value) };
    if (Array.isArray(value)) {
      entry.items = value.length;
      for (const [index, item] of value.entries()) {
        const bytes = valueSize(item).bytes;
        if (entry.largestItemBytes === undefined || bytes > entry.largestItemBytes) {
          entry.largestItemIndex = index;
          entry.largestItemBytes = bytes;
        }
      }
    }
    result.push(entry);
  };
  for (const field of contextSectionSchema.options) {
    if (!field.includes(".") && Object.hasOwn(root, field)) add(field, root[field]);
  }
  for (const pageField of ["untrustedPage", "observation"] as const) {
    const page = root[pageField];
    if (!page || typeof page !== "object" || Array.isArray(page)) continue;
    for (const field of ["url", "title", "tabs", "loading", "network"]) {
      if (Object.hasOwn(page, field))
        add(`${pageField}.${field}`, (page as Record<string, unknown>)[field]);
    }
  }
  return result;
}

function messageGroup(messages: BaseMessage[]): ContextSizeReport["history"] {
  const values = fromLangChainMessages(messages);
  const names = new Map<string, string>();
  for (const value of values)
    for (const call of value.tool_calls ?? []) names.set(call.id, call.function.name);
  const largest = values
    .map((message, index) => ({ index, ...valueSize(message) }))
    .sort((a, b) => b.bytes - a.bytes || a.index - b.index)
    .slice(0, contextLargestLimit)
    .map((entry) => {
      const message = values[entry.index];
      const tool =
        message.role === "tool"
          ? contextToolSchema.safeParse(names.get(message.tool_call_id ?? ""))
          : undefined;
      return {
        ...entry,
        estimatedTokens: entry.estimatedTokens + 16,
        role: message.role,
        ...(message.role === "tool"
          ? { tool: tool?.success ? tool.data : ("other" as const) }
          : {}),
        contentBytes:
          valueSize(message.content).bytes +
          (message.content_blocks ? valueSize(message.content_blocks).bytes : 0),
        toolCallsBytes: message.tool_calls ? valueSize(message.tool_calls).bytes : 0,
        // 子字段测量解码后的 JSON 值；包含父子重叠，不与消息总量直接求和。
        sections: sections(message.content),
      };
    });
  const byRole: ContextSizeReport["history"]["byRole"] = {};
  for (const role of ["system", "user", "assistant", "tool"] as const) {
    const group = messages.filter((_, index) => values[index].role === role);
    if (group.length) byRole[role] = messageTotal(group);
  }
  return { ...messageTotal(messages), byRole, largest };
}

/** 所有输入只在本次同步测量中使用，返回值不持有消息或 JSON 对象引用。 */
export function contextSizeReport(input: {
  phase: ContextSizeReport["phase"];
  failure?: ContextSizeReport["failure"];
  budget: { contextTokens: number; outputTokens: number };
  remaining: number;
  protectedMessages: BaseMessage[];
  tools: unknown[];
  history: BaseMessage[];
  summaryInput?: ReturnType<typeof valueSize>;
  replacement?: BaseMessage[];
}): ContextSizeReport {
  const preserved = input.replacement?.slice(1);
  return {
    version: 1,
    phase: input.phase,
    ...(input.failure ? { failure: input.failure } : {}),
    budget: {
      ...input.budget,
      safetyTokens: 1024,
      historyAllowanceTokens: input.remaining,
      triggerTokens: Math.floor(input.remaining * 0.8),
      keepTargetTokens: Math.floor(input.remaining * 0.3),
    },
    protectedMessages: messageGroup(input.protectedMessages),
    tools: { ...valueSize(input.tools), count: input.tools.length },
    history: messageGroup(input.history),
    ...(input.summaryInput ? { summaryInput: { ...input.summaryInput } } : {}),
    ...(input.replacement && preserved
      ? {
          summaryMessage: messageTotal(input.replacement.slice(0, 1)),
          summarized: messageTotal(input.history.slice(0, input.history.length - preserved.length)),
          preserved: messageGroup(preserved),
          replacement: messageTotal(input.replacement),
        }
      : {}),
  };
}
