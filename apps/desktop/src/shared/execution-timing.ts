import { z } from "zod";

/** 诊断导出仅接受固定阶段、数值、布尔值和模型请求 UUID。旧检查点可以没有计时字段。 */
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
});
export type ExecutionTiming = z.infer<typeof executionTimingSchema>;
