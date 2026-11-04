import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "./env";
import { EgressState } from "./egress-state";
import type { EgressJob } from "./egress";
import { performInference } from "./models";

export class ModelEgress extends DurableObject<AppEnv> {
  private jobs: EgressState;
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.jobs = new EgressState(ctx.storage, env.MASTER_KEY, async (value) => {
      const job = value as EgressJob;
      if (job.kind === "trace") {
        const response = await fetch("https://api.openai.com/cdn-cgi/trace", {
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        const result: Record<string, string> = {
          status: String(response.status),
          jurisdiction: ctx.id.jurisdiction ?? "default",
        };
        if (response.ok) {
          const trace = await response.text();
          for (const field of ["loc", "colo"] as const) {
            const entry = new RegExp(`^${field}=([A-Z0-9-]{2,10})$`, "m").exec(
              trace,
            )?.[1];
            if (entry) result[field] = entry;
          }
        }
        return result;
      }
      if (job.kind !== "inference")
        throw new Error("MODEL_EGRESS_INPUT_INVALID");
      return performInference(
        env,
        job.modelId,
        job.version,
        job.request,
        job.runId,job.userId,job.reservationId,
      );
    });
  }
  submitAndWait(id: string, cipher: string) {
    return this.jobs.submitAndWait(id, cipher);
  }
  ack() {
    return this.jobs.ack();
  }
  // Only an alarm calls the provider. No browser request/headers enter this context.
  alarm() {
    return this.jobs.alarm();
  }
}
