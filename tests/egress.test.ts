import test from "node:test";
import assert from "node:assert/strict";
import { EgressState } from "../apps/cloud/src/egress-state";
import { seal, unseal } from "../apps/cloud/src/crypto";
import { fakeStorage } from "./egress-helpers";
import { egress } from "../apps/cloud/src/egress";
import type { AppEnv } from "../apps/cloud/src/env";

const key = Buffer.alloc(32, 4).toString("base64");
test("本地模拟器不支持地区时明确失败，不能回退直连", async () => {
  const env = {
    MODEL_EGRESS: {
      jurisdiction() {
        throw new Error(
          "Jurisdiction restrictions are not implemented in workerd.",
        );
      },
    },
  } as unknown as AppEnv;
  await assert.rejects(() => egress(env, { kind: "trace" }), {
    message: "MODEL_REGION_REQUIRES_DEPLOYMENT",
  });
});
test("模型出站仅由 alarm 执行，跨块加密和确认清理，重复 alarm 不重放", async () => {
  const { storage, values, getAlarm } = fakeStorage();
  let calls = 0;
  const input = { private: "sensitive-".repeat(40_000) };
  const state = new EgressState(storage, key, async (job) => {
    calls++;
    assert.deepEqual(job, input);
    return { ok: true };
  });
  const id = crypto.randomUUID();
  await state.submit(id, await seal(input, key, `egress:${id}:request`));
  assert.equal(calls, 0);
  assert.equal(
    JSON.stringify([...values.values()]).includes("sensitive-"),
    false,
  );
  assert.ok(getAlarm());
  await state.alarm();
  await state.alarm();
  assert.equal(calls, 1);
  const result = await state.read();
  assert.deepEqual(await unseal(result.cipher!, key, `egress:${id}:response`), {
    ok: true,
  });
  await state.ack();
  assert.equal((await state.read()).status, "consumed");
  assert.equal(values.size, 1);
});
test("模型调用中断后的 alarm 不重复请求，过期记录被清理", async () => {
  const { storage, values } = fakeStorage();
  let calls = 0;
  const state = new EgressState(storage, key, async () => {
    calls++;
    return {};
  });
  const id = crypto.randomUUID();
  await state.submit(id, await seal({}, key, `egress:${id}:request`));
  const meta = await storage.get<any>("meta");
  await storage.put("meta", { ...meta, status: "running" });
  await state.alarm();
  assert.equal(calls, 0);
  assert.equal((await state.read()).error, "MODEL_CALL_OUTCOME_UNKNOWN");
  await storage.put("meta", { ...meta, expires: Date.now() - 1 });
  await state.alarm();
  assert.equal(values.size, 0);
});
