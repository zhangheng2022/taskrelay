import test from "node:test";
import assert from "node:assert/strict";
import { loadReleaseCatalog, serveUpdate } from "../apps/cloud/src/updates";
import { testDb } from "./helpers";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { app } from "../apps/cloud/src/index";
import type { AppEnv } from "../apps/cloud/src/env";

test("管理员不能在发布未完成时覆盖领取开关，完成后恢复原设置入口", async (t) => {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  sql
    .prepare("INSERT INTO settings(key,value) VALUES('productionRelease',?)")
    .run(JSON.stringify({ phase: "migrating" }));
  const env = { DB: db, DEV_MODE: "1" } as AppEnv;
  const update = () =>
    app.request(
      "http://localhost/api/admin/pool",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claimsEnabled: false }),
      },
      env,
    );
  assert.equal((await update()).status, 409);
  sql
    .prepare("UPDATE settings SET value=? WHERE key='productionRelease'")
    .run(JSON.stringify({ phase: "complete" }));
  assert.equal((await update()).status, 200);
  assert.equal(
    sql.prepare("SELECT value FROM settings WHERE key='claimsEnabled'").get()!.value,
    "0",
  );
});

test("生产更新目录读取 D1；空目录覆盖初始化值，损坏时不回退", async (t) => {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  assert.ok((await loadReleaseCatalog(db)).releases.length > 0);
  sql
    .prepare("INSERT INTO settings(key,value) VALUES('desktopReleaseCatalog',?)")
    .run(JSON.stringify({ latest: null, releases: [] }));
  const request = new Request("https://tr.zhangheng.eu.org/api/updates/windows-x64/latest.json");
  assert.deepEqual(await (await serveUpdate(request, await loadReleaseCatalog(db))).json(), {
    release: null,
  });
  sql.prepare("UPDATE settings SET value='bad-json' WHERE key='desktopReleaseCatalog'").run();
  await assert.rejects(loadReleaseCatalog(db));
  assert.equal((await serveUpdate(new Request(request.url, { method: "POST" }))).status, 405);
});

test(
  "实际 Worker 经 RequestCoordinator 读取目录，损坏配置返回不可用",
  { timeout: 60_000 },
  async (t) => {
    const bundle = await build({
      entryPoints: ["apps/cloud/src/worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      target: "es2023",
      alias: { fs: "node:fs", "fs/promises": "node:fs/promises" },
      external: ["cloudflare:workers", "node:*"],
      banner: {
        js: "import * as fs from 'node:fs'; import * as fsp from 'node:fs/promises'; const require=n=>{if(n==='node:fs')return fs;if(n==='node:fs/promises')return fsp;throw Error('Unexpected require');};",
      },
    });
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        telemetry: { enabled: false },
        workers: [
          {
            name: "release-test",
            modules: true,
            script: bundle.outputFiles[0].text,
            compatibilityDate: "2026-11-03",
            compatibilityFlags: ["nodejs_compat"],
            durableObjects: {
              REQUESTS: { className: "RequestCoordinator", useSQLite: true },
              NOTIFICATIONS: { className: "NotificationHub", useSQLite: true },
            },
            d1Databases: ["DB"],
          },
        ],
      }),
    );
    t.after(() => mf.dispose());
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    await db
      .prepare("INSERT INTO settings VALUES('desktopReleaseCatalog',?)")
      .bind(JSON.stringify({ latest: null, releases: [] }))
      .run();
    const url = "https://fixture.test/api/updates/windows-x64/latest.json";
    assert.deepEqual(await (await mf.dispatchFetch(url)).json(), { release: null });
    await db.exec("CREATE TABLE devices(id TEXT PRIMARY KEY,revoked INTEGER)");
    await db.exec("INSERT INTO devices VALUES('device',0)");
    const hubs = await mf.getDurableObjectNamespace("NOTIFICATIONS");
    const hub = hubs.get(hubs.idFromName("device:device"));
    const response = await hub.fetch("https://notification.internal/", {
      headers: {
        Upgrade: "websocket",
        "x-subscriber": JSON.stringify({ device: "device", expires: Date.now() + 60_000 }),
      },
    });
    const ws = response.webSocket!;
    ws.accept();
    t.after(() => ws.close());
    const messages: string[] = [];
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") messages.push(event.data);
    });
    const release = {
      version: "0.22.0",
      sha256: "a".repeat(64),
      sha1: "b".repeat(40),
      bytes: 1,
      notes: "",
      publishedAt: "2026-11-10T00:00:00.000Z",
    };
    await db
      .prepare("UPDATE settings SET value=?")
      .bind(JSON.stringify({ latest: null, releases: [release] }))
      .run();
    await mf.dispatchFetch(url);
    assert.deepEqual(messages, []);
    await db
      .prepare("UPDATE settings SET value=?")
      .bind(JSON.stringify({ latest: release.version, releases: [release] }))
      .run();
    assert.deepEqual(await (await mf.dispatchFetch(url)).json(), { release });
    for (let i = 0; i < 100 && !messages.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(
      messages.map((message) => JSON.parse(message)),
      [{ type: "update.available", version: 1 }],
    );
    await mf.dispatchFetch(url);
    assert.equal(messages.length, 1);
    await db.exec("UPDATE settings SET value='invalid'");
    assert.equal((await mf.dispatchFetch(url)).status, 503);
  },
);
