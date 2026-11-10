import test from "node:test";
import assert from "node:assert/strict";
import { UpdateBroadcast } from "../apps/cloud/src/update-broadcast";
import { testDb } from "./helpers";
import { fakeStorage } from "./egress-helpers";
import type { AppEnv } from "../apps/cloud/src/env";

const release = {
  version: "0.22.0",
  sha256: "a".repeat(64),
  sha1: "b".repeat(40),
  bytes: 1,
  notes: "",
  publishedAt: "2026-11-10T00:00:00.000Z",
};
test("版本广播跨 20 台分页、失败保留游标、恢复投递、重复读取不重复建任务", async (t) => {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  for (let i = 0; i < 45; i++) {
    const id = `device-${String(i).padStart(2, "0")}`;
    sql
      .prepare(
        "INSERT INTO devices(id,name,token_hash,last_seen,protocol_version,revoked) VALUES(?,?,?,0,19,?)",
      )
      .run(id, id, id, i === 44 ? 1 : 0);
  }
  const fake = fakeStorage();
  fake.storage.transaction = async (fn) => fn(fake.storage as unknown as DurableObjectTransaction);
  let fail = true;
  const sent = new Set<string>();
  const env = {
    DB: db,
    NOTIFICATIONS: {
      getByName: (id: string) => ({
        publish: async (event: unknown) => {
          assert.deepEqual(event, { type: "update.available", version: 1 });
          if (fail && id === "device:device-05") throw Error("interrupted");
          sent.add(id);
        },
      }),
    },
  } as unknown as AppEnv;
  let broadcast = new UpdateBroadcast(fake.storage, env);
  await broadcast.observe(null);
  assert.equal(fake.values.has("updatePending"), false);
  await broadcast.observe(release);
  await assert.rejects(broadcast.alarm(), /interrupted/);
  assert.deepEqual(fake.values.get("updatePending"), {
    revision: `${release.version}:${release.sha256}`,
    cursor: "",
  });
  assert.ok(fake.getAlarm() > Date.now());
  fail = false;
  // 重新创建对象模拟唤醒；持久游标而非内存保证继续投递。
  broadcast = new UpdateBroadcast(fake.storage, env);
  for (let i = 0; i < 3; i++) await broadcast.alarm();
  assert.equal(sent.size, 44);
  assert.equal(sent.has("device:device-44"), false);
  assert.equal(fake.values.has("updatePending"), false);
  await broadcast.observe(release);
  assert.equal(fake.values.has("updatePending"), false);
  await broadcast.observe({ ...release, version: "0.22.1" });
  assert.equal(fake.values.has("updatePending"), true);
  await broadcast.observe(null);
  assert.equal(fake.values.has("updatePending"), false);
});
