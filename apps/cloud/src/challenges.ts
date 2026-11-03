import type { HumanChallenge } from "../../../packages/contracts/src/index";
import type { Row } from "./store";
export function challengeFrom(row: Row): HumanChallenge {
  return {
    id: row.id,
    runId: row.run_id,
    leaseEpoch: row.lease_epoch,
    version: row.version,
    stepId: row.step_id,
    kind: row.kind,
    instruction: row.instruction,
    target: row.target ?? undefined,
    actionDigest: row.action_digest ?? undefined,
    status: row.status,
    expiresAt: row.expires_at,
    imageId: row.image_id ?? undefined,
  };
}
// The model selects a span, never manufactures/reformats secret characters.
export function exactReply(
  raw: string,
  parsed: { start: number; end: number },
) {
  if (
    !Number.isInteger(parsed.start) ||
    !Number.isInteger(parsed.end) ||
    parsed.start < 0 ||
    parsed.end > raw.length ||
    parsed.end <= parsed.start
  )
    throw new Error("REPLY_SPAN_INVALID");
  const value = raw.slice(parsed.start, parsed.end);
  if (value.length > 2000 || /[\r\n\0]/.test(value))
    throw new Error("REPLY_INVALID");
  return value;
}
