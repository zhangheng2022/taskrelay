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
