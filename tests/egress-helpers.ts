import type { AppEnv } from "../apps/cloud/src/env";
import { EgressState } from "../apps/cloud/src/egress-state";
import type { EgressJob } from "../apps/cloud/src/egress";
import { performInference } from "../apps/cloud/src/models";

export function fakeStorage(onDueAlarm?: () => void) {
  const values = new Map<string, unknown>();
  let alarm = 0;
  const storage = {
    async get(keys: string | string[]) {
      return Array.isArray(keys)
        ? new Map(keys.map((k) => [k, structuredClone(values.get(k))]))
        : structuredClone(values.get(keys));
    },
    async put(key: string | Record<string, unknown>, value?: unknown) {
      const entries: [string, unknown][] =
        typeof key === "string" ? [[key, value]] : Object.entries(key);
      for (const [k, v] of entries) values.set(k, structuredClone(v));
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) values.delete(k);
    },
    async deleteAll() {
      values.clear();
    },
    async setAlarm(time: number) {
      alarm = time;
      if (time <= Date.now() && onDueAlarm) setTimeout(onDueAlarm, 0);
    },
  } as unknown as DurableObjectStorage;
  return { storage, values, getAlarm: () => alarm };
}
export function attachTestEgress(env: AppEnv) {
  env.MODEL_EGRESS = {
    jurisdiction(region: string) {
      if (region !== "us") throw new Error("UNEXPECTED_TEST_JURISDICTION");
      return {
        getByName() {
          const state = new EgressState(
            fakeStorage(() => {
              void state.alarm().catch((error) => {
                queueMicrotask(() => {
                  throw error;
                });
              });
            }).storage,
            env.MASTER_KEY,
            async (value) => {
              const job = value as EgressJob;
              if (job.kind !== "inference") throw new Error("TEST_INFERENCE_ONLY");
              return performInference(
                env,
                job.modelId,
                job.version,
                job.request,
                job.runId,
                job.userId,
                job.reservationId,
              );
            },
          );
          return {
            submitAndWait: (id: string, cipher: string) => state.submitAndWait(id, cipher),
            ack: () => state.ack(),
          };
        },
      };
    },
  } as unknown as AppEnv["MODEL_EGRESS"];
}
