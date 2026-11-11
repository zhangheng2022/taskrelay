/** 本机按运行导出的网络事实。错误和字段采用白名单，只诊断任务入口主机。 */
import { z } from "zod";
export const networkEventLimit = 64;
const reasons = z.enum([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "TimeoutError",
  "OTHER",
]);
export function networkReason(error: unknown): z.infer<typeof reasons> {
  const e = error as { cause?: { code?: unknown }; code?: unknown; name?: unknown } | null;
  return reasons.safeParse(e?.cause?.code ?? e?.code ?? e?.name).data ?? "OTHER";
}
export const networkEventSchema = z
  .object({
    at: z.iso.datetime(),
    connection: z.number().int().positive(),
    phase: z.enum(["dns", "address", "connect", "tunnel"]),
    result: z.enum(["ok", "error", "timeout", "closed", "blocked"]),
    elapsedMs: z.number().int().nonnegative(),
    query: z.enum(["A", "AAAA"]).optional(),
    attempt: z.union([z.literal(1), z.literal(2)]).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    dnsStatus: z.number().int().min(0).max(4095).optional(),
    answers: z.number().int().nonnegative().optional(),
    family: z.union([z.literal(4), z.literal(6)]).optional(),
    reason: reasons.optional(),
  })
  .strict();
export type NetworkEvent = z.infer<typeof networkEventSchema>;
export const networkLogSchema = z
  .object({
    host: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[a-z0-9.:[\]-]+$/i),
    events: z.array(networkEventSchema).max(networkEventLimit),
    truncated: z.boolean(),
  })
  .strict();
