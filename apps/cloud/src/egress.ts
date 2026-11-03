import type { AppEnv } from "./env";
import type { Inference } from "../../../packages/model/src/index";
import { seal, unseal } from "./crypto";

export type EgressJob =
  | { kind: "trace" }
  | {
      kind: "inference";
      modelId: string;
      version: number;
      request: Inference;
      runId: string | null;
    };
export async function egress<T>(env: AppEnv, job: EgressJob): Promise<T> {
  if (!env.MODEL_EGRESS) throw new Error("MODEL_EGRESS_NOT_CONFIGURED");
  const id = crypto.randomUUID();
  // This jurisdiction constrains the execution itself, unlike a placement hint.
  let region: AppEnv["MODEL_EGRESS"];
  try {
    region = env.MODEL_EGRESS.jurisdiction("us");
  } catch (error) {
    if (
      (error as Error).message ===
      "Jurisdiction restrictions are not implemented in workerd."
    )
      throw new Error("MODEL_REGION_REQUIRES_DEPLOYMENT");
    throw error;
  }
  const stub = region.getByName(id);
  // A single RPC begins before the alarm; do not poll the object with new RPCs.
  const result = await stub.submitAndWait(
    id,
    await seal(job, env.MASTER_KEY, `egress:${id}:request`),
  );
  try {
    if (result.status !== "done" || !result.cipher)
      throw new Error(result.error ?? "MODEL_EGRESS_FAILED");
    return await unseal<T>(
      result.cipher,
      env.MASTER_KEY,
      `egress:${id}:response`,
    );
  } finally {
    // Only acknowledge terminal results; never re-enter an executing alarm.
    // A failed acknowledgement must not discard an already received model result.
    if (result.status !== "pending" && result.status !== "running")
      await stub.ack().catch(() => {});
  }
}
