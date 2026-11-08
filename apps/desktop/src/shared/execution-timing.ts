import { z } from "zod";
import {
  contextSizeLimit,
  contextSizeReportSchema,
} from "../../../../packages/contracts/src/context-diagnostics";

/** 诊断导出仅接受固定分类、计数、模型请求 UUID 和脱敏后的账号保存 origin；上下文统计不含原文。
 * 旧检查点可以没有计时或体积字段；这些统计不参与执行决策。 */
export const timingPhase = z.enum([
  "context",
  "decision",
  "summary",
  "stagehandModel",
  "message",
  "actionJournal",
  "pageSnapshot",
  "act",
  "observe",
  "extract",
  "navigate",
  "screenshot",
  "upload",
  "helpWait",
  "finish",
]);
export type TimingPhase = z.infer<typeof timingPhase>;
const count = z.number().int().nonnegative();
export const recentSpanLimit = 64;
export const accountSaveFailureSchema = z.strictObject({
  code: z.enum([
    "ACCOUNT_ORIGIN_MISMATCH",
    "ACCOUNT_CONTEXT_MISMATCH",
    "ACCOUNT_VERSION_CONFLICT",
    "LEASE_EXPIRED",
    "OTHER",
  ]),
  entryOrigin: z.string().max(2000),
  observedOrigin: z.string().max(2000).nullable(),
});
export type AccountSaveFailure = z.infer<typeof accountSaveFailureSchema>;
export const executionTimingSchema = z.strictObject({
  version: z.literal(1),
  elapsedMs: count,
  rounds: count,
  emptyExtractions: count,
  firstNarrativeMs: count.nullable(),
  spanCount: count,
  phases: z.partialRecord(
    timingPhase,
    z.strictObject({ calls: count, failures: count, totalMs: count }),
  ),
  recent: z
    .array(
      z.strictObject({
        id: count,
        parent: count.nullable(),
        round: count,
        phase: timingPhase,
        requestId: z.uuid().optional(),
        startMs: count,
        durationMs: count,
        failed: z.boolean(),
      }),
    )
    .max(recentSpanLimit),
  // 可选以读取旧诊断。仅本机导出使用，不发送给模型或新增云端请求。
  contextSizes: z
    .array(z.strictObject({ round: count, elapsedMs: count, report: contextSizeReportSchema }))
    .max(contextSizeLimit)
    .optional(),
  // 只记录失败分类与去掉路径、查询和秘密后的地址，不记录卡片草稿或上游错误正文。
  accountSaveFailures: z.array(accountSaveFailureSchema).max(8).optional(),
});
export type ExecutionTiming = z.infer<typeof executionTimingSchema>;
