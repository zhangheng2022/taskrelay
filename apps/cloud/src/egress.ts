import type { EgressRegion } from "../../../packages/contracts/src/index";
import type { AppEnv } from "./env";
import type { Inference } from "../../../packages/model/src/index";
import { seal, unseal } from "./crypto";

export type EgressJob =
  | { kind: "trace"; region?: EgressRegion }
  | {
      kind: "inference";
      region: EgressRegion;
      modelId: string;
      version: number;
      request: Inference;
      runId: string | null;
      userId: string;
      reservationId: string;
      callId?: string;
      preview?: import("./chat-drafts").DraftTarget;
    };
export async function egress<T>(
  env: AppEnv,
  job: EgressJob,
  persist?: (result: T) => Promise<void>,
): Promise<T> {
  if (!env.MODEL_EGRESS) throw new Error("MODEL_EGRESS_NOT_CONFIGURED");
  const id = crypto.randomUUID();
  // This jurisdiction constrains the execution itself, unlike a placement hint.
  let region: AppEnv["MODEL_EGRESS"];
  try {
    const target = job.region ?? "us";
    region = target === "auto" ? env.MODEL_EGRESS : env.MODEL_EGRESS.jurisdiction(target);
  } catch (error) {
    if ((error as Error).message === "Jurisdiction restrictions are not implemented in workerd.")
      throw new Error("MODEL_REGION_REQUIRES_DEPLOYMENT");
    throw error;
  }
  const stub = region.getByName(id);
  // A single RPC begins before the alarm; do not poll the object with new RPCs.
  const result = await stub.submitAndWait(
    id,
    await seal(job, env.MASTER_KEY, `egress:${id}:request`),
  );
  let persisted = false,
    discarded = false;
  try {
    if (result.status !== "done" || !result.cipher)
      throw new Error(result.error ?? "MODEL_EGRESS_FAILED");
    const value = await unseal<T>(result.cipher, env.MASTER_KEY, `egress:${id}:response`);
    if (persist) await persist(value);
    persisted = true;
    return value;
  } catch (error) {
    // 删除/撤回使持久化 fence 拒收结果时，终态响应也应立即清掉，不能再作为恢复缓存。
    discarded = (error as Error).message === "MODEL_CALL_DISCARDED";
    throw error;
  } finally {
    // Only acknowledge terminal results; never re-enter an executing alarm.
    // A failed acknowledgement must not discard an already received model result.
    if (
      (result.status !== "done" || persisted || discarded) &&
      result.status !== "pending" &&
      result.status !== "running"
    )
      await stub.ack().catch(() => {});
  }
}
