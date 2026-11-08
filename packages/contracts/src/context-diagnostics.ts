/** 本机上下文体积诊断的白名单格式：只允许数值、固定分类和位置索引。
 * 不接收原文、URL、调用 ID、任意字段名或错误正文；不参与模型预算决策。 */
import { z } from "zod";

const count = z.number().int().nonnegative();
export const contextSizeLimit = 8;
export const contextLargestLimit = 5;
export const contextSizeSchema = z.strictObject({ bytes: count, estimatedTokens: count });
export const contextToolSchema = z.enum([
  "act",
  "observe",
  "extract",
  "navigate",
  "switchPage",
  "wait",
  "screenshot",
  "ask",
  "offerAccountSave",
  "requestAccountUpdate",
  "confirmAccountLogin",
  "structured_response",
  "other",
]);
export const contextSectionSchema = z.enum([
  "goal",
  "executionOutline",
  "userMessages",
  "accounts",
  "accountContext",
  "accountName",
  "initialNavigationError",
  "untrustedPage",
  "data",
  "feedback",
  "metadata",
  "error",
  "observation",
  "readFeedback",
  "untrustedPage.url",
  "untrustedPage.title",
  "untrustedPage.tabs",
  "untrustedPage.loading",
  "untrustedPage.network",
  "observation.url",
  "observation.title",
  "observation.tabs",
  "observation.loading",
  "observation.network",
]);
const sectionSizeSchema = contextSizeSchema.extend({
  section: contextSectionSchema,
  items: count.optional(),
  largestItemIndex: count.optional(),
  largestItemBytes: count.optional(),
});
const messageSizeSchema = contextSizeSchema.extend({
  index: count,
  role: z.enum(["system", "user", "assistant", "tool"]),
  tool: contextToolSchema.optional(),
  contentBytes: count,
  toolCallsBytes: count,
  sections: z.array(sectionSizeSchema).max(24),
});
const messageTotalSchema = contextSizeSchema.extend({ messages: count });
const messageGroupSchema = messageTotalSchema.extend({
  byRole: z.partialRecord(z.enum(["system", "user", "assistant", "tool"]), messageTotalSchema),
  // 最大项按序列化体积降序，索引指向该组的原消息位置；不是截断或重排执行消息。
  largest: z.array(messageSizeSchema).max(contextLargestLimit),
});
export const contextSizeReportSchema = z.strictObject({
  version: z.literal(1),
  phase: z.enum(["before-summary", "after-summary", "unchanged", "error"]),
  failure: z
    .enum([
      "MODEL_CONTEXT_CONFIGURATION_TOO_SMALL",
      "SUMMARY_INPUT_TOO_LARGE",
      "MODEL_EMPTY_SUMMARY",
      "SUMMARY_INPUT_TRUNCATED",
      "SUMMARY_TOOL_PAIR_INVALID",
      "CONTEXT_SUMMARY_NOT_REDUCED",
      "MODEL_CONTEXT_TOO_LARGE",
      "other",
    ])
    .optional(),
  budget: z.strictObject({
    contextTokens: count,
    outputTokens: count,
    safetyTokens: count,
    // 配置不足时允许为负，便于解释原有拒绝条件；统计不修正这些数值。
    historyAllowanceTokens: z.number().int(),
    triggerTokens: z.number().int(),
    keepTargetTokens: z.number().int(),
  }),
  protectedMessages: messageGroupSchema,
  tools: contextSizeSchema.extend({ count }),
  history: messageGroupSchema,
  summaryInput: contextSizeSchema.optional(),
  summaryMessage: messageTotalSchema.optional(),
  summarized: messageTotalSchema.optional(),
  preserved: messageGroupSchema.optional(),
  replacement: messageTotalSchema.optional(),
});
export type ContextSizeReport = z.infer<typeof contextSizeReportSchema>;
