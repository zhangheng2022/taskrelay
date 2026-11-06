// 仅供发布脚本子进程测试：内存 SQLite 承接真实 SQL，外部网络和 Wrangler 完全封闭。
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { requestUrl } from "./http-fixture.ts";
if (!["success", "deploy-fails"].includes(process.env.RELEASE_FIXTURE)) throw Error("FIXTURE_ONLY");
const sql = new DatabaseSync(":memory:");
const migrations = readdirSync("apps/cloud/migrations")
  .filter((name) => name.endsWith(".sql"))
  .sort();
sql.exec("CREATE TABLE d1_migrations(name TEXT PRIMARY KEY)");
const migrate = (names) => {
  for (const name of names) {
    sql.exec(readFileSync(`apps/cloud/migrations/${name}`, "utf8"));
    sql.prepare("INSERT INTO d1_migrations VALUES(?)").run(name);
  }
};
migrate(migrations.slice(0, -1));
sql.exec(
  "INSERT OR REPLACE INTO settings(key,value) VALUES('claimsEnabled','1'),('maintenance','0')",
);
sql
  .prepare(
    "INSERT INTO devices(id,name,token_hash,last_seen,protocol_version) VALUES('fixture','fixture','fixture',?,17)",
  )
  .run(new Date().toISOString());
const state = () =>
  Object.fromEntries(
    sql
      .prepare(
        "SELECT key,value FROM settings WHERE key IN ('claimsEnabled','maintenance','productionRelease')",
      )
      .all()
      .map((row) => [row.key, row.value]),
  );
const commands = [];
let deployed = false;
const originalExec = childProcess.execFileSync;
childProcess.execFileSync = (file, args) => {
  if (file === "git" && args.join(" ") === "rev-parse HEAD") return process.env.RELEASE_SHA + "\n";
  assert.equal(file, process.execPath);
  assert.equal(args[0], "node_modules/wrangler/bin/wrangler.js");
  const current = state();
  assert.equal(current.claimsEnabled, "0");
  assert.equal(current.maintenance, "1");
  const record = JSON.parse(current.productionRelease);
  assert.equal(record.bookmark, "fixture-bookmark");
  if (args[1] === "d1") {
    assert.equal(record.phase, "migrating");
    commands.push("migrate");
    migrate(migrations.slice(-1));
  } else if (args[1] === "deploy") {
    assert.equal(record.phase, "deploying");
    commands.push("deploy");
    if (process.env.RELEASE_FIXTURE === "deploy-fails") throw Error("FIXTURE_DEPLOY_FAILED");
    deployed = true;
  } else throw Error("UNEXPECTED_PROCESS");
  return Buffer.alloc(0);
};
syncBuiltinESMExports();
globalThis.fetch = async (input, options) => {
  const url = requestUrl(input);
  if (
    url.startsWith(
      "https://api.github.com/repos/zhangheng2022/taskrelay/actions/workflows/ci.yml/runs?",
    )
  )
    return Response.json({
      workflow_runs: [
        {
          id: 1,
          head_sha: process.env.RELEASE_SHA,
          head_branch: "master",
          event: "push",
          status: "completed",
          conclusion: "success",
        },
      ],
    });
  if (
    url ===
    "https://api.github.com/repos/zhangheng2022/taskrelay/actions/runs/1/jobs?filter=latest&per_page=100"
  )
    return Response.json({
      total_count: 1,
      jobs: [{ name: "quality-gate", conclusion: "success" }],
    });
  if (url === "https://taskrelay.zhangheng.workers.dev/api/health") {
    assert.equal(deployed, true);
    return Response.json({
      service: "TaskRelay",
      protocolVersion: 17,
      sourceCommit: process.env.RELEASE_SHA,
    });
  }
  const db =
    "https://api.cloudflare.com/client/v4/accounts/b3a410496c5e49e582b4af19d2f2eec6/d1/database/9d387f48-6e34-4af4-a2a0-10f958d65a16";
  if (url === db + "/time_travel/bookmark")
    return Response.json({ success: true, result: { bookmark: "fixture-bookmark" } });
  if (url === db + "/query") {
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body);
    const statement = sql.prepare(body.sql);
    const read = /^SELECT/.test(body.sql);
    const results = read ? statement.all(...body.params) : [];
    const changes = read ? 0 : Number(statement.run(...body.params).changes);
    return Response.json({
      success: true,
      result: [{ success: true, results, meta: { changes } }],
    });
  }
  throw Error("UNEXPECTED_NETWORK");
};
process.on("exit", () => {
  console.log(
    "RELEASE_FIXTURE_RESULT=" +
      JSON.stringify({
        state: state(),
        commands,
        migrations: sql.prepare("SELECT COUNT(*) n FROM d1_migrations").get().n,
      }),
  );
  sql.close();
  childProcess.execFileSync = originalExec;
});
