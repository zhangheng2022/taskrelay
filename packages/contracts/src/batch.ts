import { z } from "zod";
// Historical data display only. No batch planning, identity or completion rules.

export const batchVerificationSchema = z
  .object({
    kind: z.literal("batch"),
    value: z.string().trim().min(1).max(2000),
    scope: z.string().trim().min(1).max(1000),
    eligibility: z.string().trim().min(1).max(1000),
    exclusions: z.array(z.string().trim().min(1).max(300)).max(10),
  })
  .strict();
const evidenceSchema = z.object({
  url: z.url(),
  quote: z.string().max(500),
  capturedAt: z.iso.datetime(),
});
export const batchReportSchema = z.object({
  coverage: z.enum(["incomplete", "complete"]),
  expected: z.number().int().min(0).max(100).nullable(),
  reason: z.string().max(1000),
  items: z
    .array(
      z.object({
        id: z.string().max(500),
        label: z.string().max(200),
        status: z.enum(["pending", "completed", "already_done", "excluded", "unknown"]),
        reason: z.string().max(300),
        evidence: evidenceSchema,
      }),
    )
    .max(100),
});
export type BatchReport = z.infer<typeof batchReportSchema>;
