// 仅供发布脚本子进程测试：内存 SQLite 承接真实 SQL，外部网络和 Wrangler 完全封闭。
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import fs from "node:fs";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { requestUrl } from "./http-fixture.ts";
const mode = process.env.RELEASE_FIXTURE;
if (
  ![
    "success",
    "deploy-fails",
    "desktop",
    "bad-download",
    "no-device",
    "resume-published",
    "resume-unknown",
    "resume-ready",
    "wrong-manifest",
    "duplicate",
    "bad-artifact",
    "bad-smoke",
    "resume-active",
    "resume-artifact-changed",
  ].includes(mode)
)
  throw Error("FIXTURE_ONLY");
const desktop = [
  "desktop",
  "bad-download",
  "no-device",
  "resume-published",
  "resume-ready",
  "wrong-manifest",
  "bad-artifact",
  "bad-smoke",
  "resume-artifact-changed",
].includes(mode);
const resume = mode.startsWith("resume-");
if (resume) process.env.RELEASE_MODE = "resume";
process.env.RELEASE_DESKTOP = String(desktop);
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
if (mode === "no-device") sql.exec("UPDATE devices SET claim_ready=0");
const state = () =>
  Object.fromEntries(
    sql
      .prepare(
        "SELECT key,value FROM settings WHERE key IN ('claimsEnabled','maintenance','productionRelease','desktopReleaseCatalog')",
      )
      .all()
      .map((row) => [row.key, row.value]),
  );
const commands = [];
let deployed = resume;
const bytes = Buffer.from("fixture immutable package");
const candidate = {
  version: "0.17.1",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  sha1: createHash("sha1").update(bytes).digest("hex"),
  bytes: bytes.length,
  notes: "fixture",
  publishedAt: "2026-11-06T00:00:00Z",
};
const packageName = "TaskRelay-0.17.1-full.nupkg";
const packageRoot = "artifacts/windows/apps/desktop/out/make/squirrel.windows/x64";
const manifest = {
  sourceCommit: process.env.RELEASE_SHA,
  sourceDirty: false,
  version: candidate.version,
  installedAsarMatches: true,
  systemEntry: { runner: "github-hosted" },
  actionsRunId: "11",
  reports: Object.fromEntries(
    ["packaged-smoke", "installed-smoke"].map((key) => [
      key,
      { passed: true, version: candidate.version },
    ]),
  ),
  artifacts: [
    {
      file: "apps/desktop/out/make/squirrel.windows/x64/" + packageName,
      bytes: bytes.length,
      sha256: candidate.sha256,
    },
  ],
};
if (mode === "wrong-manifest") manifest.sourceCommit = "b".repeat(40);
if (mode === "bad-artifact") manifest.artifacts[0].sha256 = "b".repeat(64);
if (mode === "bad-smoke") manifest.reports["installed-smoke"].passed = false;
if (resume || mode === "duplicate") {
  migrate(migrations.slice(-1));
  sql.exec(
    "UPDATE settings SET value='0' WHERE key='claimsEnabled'; UPDATE settings SET value='1' WHERE key='maintenance'",
  );
  const phase = {
    "resume-published": "publishing",
    "resume-unknown": "deploying",
    "resume-ready": "awaiting-device",
    duplicate: "deploying",
    "resume-active": "deploying",
    "resume-artifact-changed": "publishing",
  }[mode];
  sql.prepare("INSERT INTO settings(key,value) VALUES('productionRelease',?)").run(
    JSON.stringify({
      sha: process.env.RELEASE_SHA,
      cloud: true,
      desktop,
      phase,
      runId: "10",
      artifactRunId: "11",
      oldClaims: "1",
      oldMaintenance: "0",
      bookmark: "fixture-bookmark",
      packageSha256: mode === "resume-artifact-changed" ? "b".repeat(64) : candidate.sha256,
    }),
  );
}
const readOriginal = fs.readFileSync;
fs.readFileSync = (file, ...args) => {
  const normalized = String(file).replaceAll("\\", "/");
  if (normalized === "artifacts/windows/out/release-manifest.json") return JSON.stringify(manifest);
  if (normalized === "artifacts/windows/out/desktop-release.json") return JSON.stringify(candidate);
  if (normalized === packageRoot + "/" + packageName) return bytes;
  return readOriginal(file, ...args);
};
fs.createReadStream = (file) => {
  assert.equal(String(file).replaceAll("\\", "/"), packageRoot + "/" + packageName);
  return Readable.from([bytes]);
};
let release;
if (mode === "resume-published")
  release = {
    id: 2,
    draft: false,
    target_commitish: process.env.RELEASE_SHA,
    assets: [{ name: packageName, size: bytes.length, digest: "sha256:" + candidate.sha256 }],
  };
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
  if (url === "https://api.github.com/repos/zhangheng2022/taskrelay/actions/runs/10")
    return Response.json({ status: mode === "resume-active" ? "in_progress" : "completed" });
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
      sourceCommit: mode === "resume-unknown" ? "b".repeat(40) : process.env.RELEASE_SHA,
    });
  }
  if (url === "https://api.github.com/repos/zhangheng2022/taskrelay/releases/tags/v0.17.1")
    return release ? Response.json(release) : new Response(null, { status: 404 });
  if (
    url === "https://api.github.com/repos/zhangheng2022/taskrelay/releases" &&
    options.method === "POST"
  ) {
    release = { ...JSON.parse(options.body), id: 2, assets: [] };
    return Response.json(release);
  }
  if (
    url ===
    "https://uploads.github.com/repos/zhangheng2022/taskrelay/releases/2/assets?name=" + packageName
  ) {
    assert.deepEqual(options.body, bytes);
    assert.equal(release.draft, true);
    const asset = { name: packageName, size: bytes.length, digest: "sha256:" + candidate.sha256 };
    release.assets.push(asset);
    return Response.json(asset);
  }
  if (
    url === "https://api.github.com/repos/zhangheng2022/taskrelay/releases/2" &&
    options.method === "PATCH"
  ) {
    release.draft = JSON.parse(options.body).draft;
    return Response.json(release);
  }
  if (
    url ===
    `https://taskrelay.zhangheng.workers.dev/api/updates/windows-x64/0.17.1/${candidate.sha256}/${packageName}`
  ) {
    const catalog = JSON.parse(state().desktopReleaseCatalog);
    assert.equal(release.draft, false);
    assert.notEqual(catalog.latest, candidate.version);
    assert.equal(catalog.releases.at(-1).sha256, candidate.sha256);
    return new Response(mode === "bad-download" ? Buffer.alloc(bytes.length) : bytes);
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
