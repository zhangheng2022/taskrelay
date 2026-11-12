import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test(
  "已有 alarm 时每分钟调度仍能恢复原清理作业，并由 alarm 完成剩余目标",
  { timeout: 60000 },
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
            name: "cleanup-test",
            modules: true,
            script: bundle.outputFiles[0].text,
            compatibilityDate: "2026-11-03",
            compatibilityFlags: ["nodejs_compat"],
            durableObjects: {
              SCHEDULER: { className: "Scheduler", useSQLite: true },
              NOTIFICATIONS: { className: "NotificationHub", useSQLite: true },
            },
            d1Databases: ["DB"],
          },
        ],
      }),
    );
    t.after(() => mf.dispose());
    const db = await mf.getD1Database("DB");
    const dir = new URL("../apps/cloud/migrations/", import.meta.url);
    for (const name of (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort()) {
      const migration = await readFile(new URL(name, dir), "utf8");
      await db.exec(migration.replace(/--[^\n]*/g, "").replace(/\r?\n/g, " "));
    }
    await db.prepare("INSERT INTO members(id,role) VALUES('fixture_owner','admin')").run();
    // 冻结期间留下未来的 alarm；解冻后的 Cron 必须能直接推进同一个已接收作业。
    const service = await mf.getWorker("cleanup-test");
    await db.batch([
      db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('storageFrozen','1')"),
      db.prepare(
        "INSERT INTO history_cleanup_jobs(id,user_id,request_id,scope,status,created_at,updated_at) VALUES('cleanup_fixture','fixture_owner','cron_fixture','task','pending',0,0)",
      ),
      db.prepare(
        "INSERT INTO history_cleanup_targets(job_id,kind,resource_id) VALUES('cleanup_fixture','run','run_fixture'),('cleanup_fixture','task','task_fixture')",
      ),
    ]);
    const cleanupProgress = () =>
      db
        .prepare("SELECT sum(done) FROM history_cleanup_targets WHERE job_id='cleanup_fixture'")
        .first("sum(done)");
    const cron = () => service.scheduled({ cron: "* * * * *" });
    assert.equal((await cron()).outcome, "ok");
    assert.equal(await cleanupProgress(), 0);
    await db.prepare("UPDATE settings SET value='0' WHERE key='storageFrozen'").run();
    assert.equal((await cron()).outcome, "ok");
    assert.equal(await cleanupProgress(), 1);
    // 剩余目标由生产 alarm 自动收尾，不再触发 Cron。
    let cleanupStatus;
    for (let i = 0; i < 100; i++) {
      cleanupStatus = await db
        .prepare("SELECT status FROM history_cleanup_jobs WHERE id='cleanup_fixture'")
        .first("status");
      if (cleanupStatus === "done") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(cleanupStatus, "done");
    assert.equal(await cleanupProgress(), 2);
  },
);
