import test from "node:test";
import assert from "node:assert/strict";
import { app } from "../apps/cloud/src/index";
import { testDb } from "./helpers";
import { PROTOCOL_VERSION } from "../packages/contracts/src/index";
import type { AppEnv } from "../apps/cloud/src/env";

test("匿名来源不能占满配对容量；限流原子生效且不阻止其他来源", async (t) => {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  const env = {
    DB: db,
    MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
    DEV_MODE: "0",
  } as AppEnv;
  const start = (ip: string) =>
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
