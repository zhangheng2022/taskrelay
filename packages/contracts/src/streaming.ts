/** 正文预览协议：临时草稿不进入历史或工具执行；正式消息以 source_call_id 接替草稿。 */
import { z } from "zod";
export const chatDraftSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  callId: z.string(),
  version: z.number().int().nonnegative(),
  seq: z.number().int().positive(),
  content: z.string().max(2_000_000),
  at: z.string(),
  source: z.enum(["cloud", "executor"]),
  status: z.enum(["streaming", "pending", "interrupted"]),
});
export type ChatDraft = z.infer<typeof chatDraftSchema>;
export const draftEventSchema = z.object({
  protocol: z.literal(2),
  type: z.enum(["draft.start", "draft.update", "draft.end"]),
  draft: chatDraftSchema,
  reason: z.enum(["committed", "discarded"]).optional(),
});
export type DraftEvent = z.infer<typeof draftEventSchema>;
