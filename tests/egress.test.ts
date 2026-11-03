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

for (const failure of [false, true]) {
  test(`单次 RPC 等待 alarm ${failure ? "失败" : "成功"}，模型准备期间不重入对象`, async () => {
    const rpc: string[] = [];
    let calls = 0;
    const state = new EgressState(
      fakeStorage(() => {
        void state.alarm();
      }).storage,
      key,
      async (job) => {
        assert.deepEqual(job, { kind: "trace" });
        // In production these awaits include D1, decryption and endpoint DNS.
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.deepEqual(rpc, ["submitAndWait"]);
        calls++;
        if (failure) throw new Error("MODEL_HTTP_403_UNSUPPORTED_REGION");
        return { ok: true };
      },
    );
    const env = {
      MASTER_KEY: key,
      MODEL_EGRESS: {
        jurisdiction(region: string) {
          assert.equal(region, "us");
          return {
            getByName() {
              return {
                submitAndWait(id: string, cipher: string) {
                  rpc.push("submitAndWait");
                  return state.submitAndWait(id, cipher);
                },
                async ack() {
                  rpc.push("ack");
                  assert.equal(
                    (await state.read()).status,
                    failure ? "failed" : "done",
                  );
                  await state.ack();
                  // A cleanup transport failure cannot lose the received result.
                  throw new Error("ACK_CONNECTION_LOST");
                },
              };
            },
          };
        },
      },
    } as unknown as AppEnv;
    if (failure)
      await assert.rejects(() => egress(env, { kind: "trace" }), {
        message: "MODEL_HTTP_403_UNSUPPORTED_REGION",
      });
    else assert.deepEqual(await egress(env, { kind: "trace" }), { ok: true });
    assert.deepEqual(rpc, ["submitAndWait", "ack"]);
    assert.equal(calls, 1);
    assert.equal((await state.read()).status, "consumed");
  });
}

test("对象内等待超过 90 秒明确超时，不执行或重放作业", async (t) => {
  let clock = Date.now(),
    calls = 0;
  t.mock.method(Date, "now", () => clock);
  const state = new EgressState(fakeStorage().storage, key, async () => {
    calls++;
  });
  t.mock.method(state, "wait", async () => {
    clock += 15_000;
    return { status: "pending" as const };
  });
  const id = crypto.randomUUID();
  const cipher = await seal({ kind: "trace" }, key, `egress:${id}:request`);
  await assert.rejects(() => state.submitAndWait(id, cipher), {
    message: "MODEL_EGRESS_TIMEOUT",
  });
  assert.equal(calls, 0);
  assert.equal((await state.read()).status, "pending");
});
