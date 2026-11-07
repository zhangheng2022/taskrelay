import test from "node:test";
import assert from "node:assert/strict";
import { app } from "../apps/cloud/src/index";
import { testDb } from "./helpers";
import { PROTOCOL_VERSION } from "../packages/contracts/src/index";
import type { AppEnv } from "../apps/cloud/src/env";

test("当前协议新配对在正常服务中即可就绪，重复批准不改写设备或恢复已吊销令牌", async (t) => {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  const env = {
    DB: db,
    MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
    DEV_MODE: "1",
  } as AppEnv;
  const request = (url: string, body?: unknown, token?: string, targetEnv = env) =>
    app.request(
      "http://127.0.0.1" + url,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token
            ? { Authorization: `Bearer ${token}`, "x-taskrelay-protocol": String(PROTOCOL_VERSION) }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      targetEnv,
    );
  assert.equal(
    (await request("/api/pair/start", { name: "fixture", protocolVersion: 2 })).status,
    400,
  );
  const started = await request("/api/pair/start", {
    name: "fixture",
    protocolVersion: PROTOCOL_VERSION,
  });
  assert.equal(started.status, 200);
  const pair = (await started.json()) as { id: string; code: string; pollToken: string };
  const approval = `/api/admin/pairings/${pair.code}/approve`;
  assert.equal((await request(approval, {}, undefined, { ...env, DEV_MODE: "0" })).status, 401);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM devices").get()!.n, 0);
  assert.equal((await request(approval, {})).status, 200);
  assert.equal(
    sql.prepare("SELECT protocol_version FROM devices").get()!.protocol_version,
    PROTOCOL_VERSION,
  );
  const polled = await request("/api/pair/poll", { id: pair.id, pollToken: pair.pollToken });
  const approved = (await polled.json()) as { approved: boolean; deviceId: string; token: string };
  assert.equal(approved.approved, true);
  const status = await request("/api/device/status", undefined, approved.token);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    deviceId: approved.deviceId,
    protocolVersion: PROTOCOL_VERSION,
    maintenance: false,
  });
  assert.equal(
    (await request("/api/device/readiness", { ready: true }, approved.token)).status,
    200,
  );
  assert.equal((await request(approval, {}, approved.token)).status, 403);
  assert.equal((await request(approval, {})).status, 200);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM devices").get()!.n, 1);
  sql.exec("UPDATE devices SET revoked=1");
  assert.equal((await request(approval, {})).status, 200);
  assert.equal((await request("/api/device/status", undefined, approved.token)).status, 401);
});

test("匿名来源不能占满配对容量；限流原子生效且不阻止其他来源", async (t) => {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  const env = {
    DB: db,
    MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
    DEV_MODE: "0",
  } as AppEnv;
  const start = async (ip: string) =>
    app.request(
      "https://example.com/api/pair/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify({ name: "Synthetic device", protocolVersion: PROTOCOL_VERSION }),
      },
      env,
    );
  const responses = await Promise.all(Array.from({ length: 20 }, () => start("198.51.100.8")));
  assert.equal(responses.filter((r) => r.status === 200).length, 5);
  for (const response of responses.filter((r) => r.status !== 200)) {
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: "RATE_LIMITED" });
  }
  const other = await start("203.0.113.9");
  assert.equal(other.status, 200);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM pairings").get()!.n, 6);
  assert.doesNotMatch(
    JSON.stringify(sql.prepare("SELECT key FROM request_limits").all()),
    /198\.51|203\.0/,
  );
  const pair = (await other.json()) as { id: string; pollToken: string };
  const poll = await app.request(
    "https://example.com/api/pair/poll",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pair) },
    env,
  );
  assert.equal(poll.status, 200);
  assert.deepEqual(await poll.json(), { approved: false });
  sql.prepare("UPDATE request_limits SET expires_at=0").run();
  assert.equal((await start("198.51.100.8")).status, 200);
});
