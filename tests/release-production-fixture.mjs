// 仅供发布脚本子进程测试：内存 SQLite 承接真实 SQL，外部网络和 Wrangler 完全封闭。
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { dbPath } from "../scripts/release-api.mjs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { requestUrl } from "./http-fixture.ts";
import { signedFixture } from "./signing-fixture.mjs";
const mode = process.env.RELEASE_FIXTURE;
if (
  ![
    "success",
    "deploy-fails",
    "desktop",
    "bad-download",
    "no-device",
    "original-paused",
    "resume-published",
    "resume-bundle-published",
    "resume-bundle-changed",
    "resume-bundle-ready",
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
  "resume-bundle-published",
  "resume-bundle-changed",
  "resume-bundle-ready",
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
    if (sql.prepare("SELECT name FROM d1_migrations WHERE name=?").get(name)) continue;
    sql.exec(readFileSync(`apps/cloud/migrations/${name}`, "utf8"));
    sql.prepare("INSERT INTO d1_migrations VALUES(?)").run(name);
  }
};
migrate(migrations);
sql.exec(
  "INSERT OR REPLACE INTO settings(key,value) VALUES('claimsEnabled','1'),('maintenance','0')",
);
sql
  .prepare(
    "INSERT INTO devices(id,name,token_hash,last_seen,protocol_version) VALUES('fixture','fixture','fixture',?,19)",
  )
  .run(Date.now());
if (["no-device", "resume-ready", "resume-bundle-ready"].includes(mode))
  sql.exec("DELETE FROM devices");
if (mode === "original-paused")
  sql.exec(
    "UPDATE settings SET value='0' WHERE key='claimsEnabled'; UPDATE settings SET value='1' WHERE key='maintenance'",
  );
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
const installerName = "TaskRelay Setup.exe";
const publishedInstallerName = "TaskRelay.Setup.exe";
const artifactNames = [packageName, installerName];
const packageRoot = "artifacts/windows/apps/desktop/out/make/squirrel.windows/x64";
const manifest = {
  ...signedFixture(candidate.version, candidate.sha256),
  sourceCommit: process.env.RELEASE_SHA,
  sourceDirty: false,
  version: candidate.version,
  installedAsarMatches: true,
  systemEntry: { runner: "github-hosted" },
  actionsRunId: "11",
  actionsRunAttempt: "1",
  reports: Object.fromEntries(
    ["packaged-smoke", "installed-smoke"].map((key) => [
      key,
      { passed: true, version: candidate.version },
    ]),
  ),
  artifacts: artifactNames.map((name) => ({
    file: "apps/desktop/out/make/squirrel.windows/x64/" + name,
    bytes: bytes.length,
    sha256: candidate.sha256,
  })),
};
manifest.artifacts.push({
  file: "apps/desktop/out/TaskRelay-win32-x64/TaskRelay.exe",
  bytes: bytes.length,
  sha256: candidate.sha256,
});
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
    "resume-bundle-published": "publishing",
    "resume-bundle-changed": "publishing",
    "resume-bundle-ready": "awaiting-device",
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
// Artifact 文件树只存在于夹具内存，发布入口仍执行真实清单与来源验证。
process.env.RELEASE_BUNDLE_ID = "90";
process.env.GITHUB_RUN_ATTEMPT = "1";
const virtual = new Map();
const add = (name, value) =>
  virtual.set(name, Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)));
add("artifacts/web/index.html", Buffer.from("fixture web"));
if (desktop) {
  add("artifacts/windows/out/release-manifest.json", manifest);
  add("artifacts/windows/out/desktop-release.json", candidate);
  for (const [name, report] of Object.entries(manifest.reports))
    add(`artifacts/windows/out/${name}.json`, report);
  for (const name of artifactNames) add(`${packageRoot}/${name}`, bytes);
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sources = {};
for (const kind of ["web", ...(desktop ? ["windows"] : [])]) {
  const prefix = `artifacts/${kind}/`;
  const files = Object.fromEntries(
    [...virtual.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, data]) => [
        name.slice(prefix.length),
        { bytes: data.length, sha256: hash(data) },
      ]),
  );
  const built = {
    schema: 1,
    kind,
    sourceCommit: process.env.RELEASE_SHA,
    version: candidate.version,
    repository: "zhangheng2022/taskrelay",
    runId: "11",
    runAttempt: "1",
    files,
  };
  add(`${prefix}artifact-manifest.json`, built);
  sources[kind] = {
    artifactId: kind === "web" ? "91" : "92",
    runId: "11",
    runAttempt: "1",
    manifestHash: hash(JSON.stringify(built)),
  };
}
add("artifacts/release-plan.json", {
  schema: 1,
  sha: process.env.RELEASE_SHA,
  qualityRunId: 1,
  releaseRunId: "11",
  sources,
});
if (mode.startsWith("resume-bundle-")) {
  const record = JSON.parse(state().productionRelease);
  record.bundleId = "90";
  record.planHash =
    mode === "resume-bundle-changed"
      ? "b".repeat(64)
      : hash(virtual.get("artifacts/release-plan.json"));
  sql
    .prepare("UPDATE settings SET value=? WHERE key='productionRelease'")
    .run(JSON.stringify(record));
}
const normalize = (file) => String(file).replaceAll("\\", "/");
const originalPromises = {
  readFile: fsp.readFile,
  readdir: fsp.readdir,
  lstat: fsp.lstat,
  cp: fsp.cp,
  rm: fsp.rm,
};
fsp.readFile = async (file, options) =>
  virtual.has(normalize(file))
    ? typeof options === "string"
      ? virtual.get(normalize(file)).toString(options)
      : virtual.get(normalize(file))
    : originalPromises.readFile(file, options);
fsp.readdir = async (file, ...args) => {
  const prefix = normalize(file) + "/";
  if (!prefix.startsWith("artifacts/")) return originalPromises.readdir(file, ...args);
  return [
    ...new Set(
      [...virtual.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => name.slice(prefix.length).split("/")[0]),
    ),
  ];
};
fsp.lstat = async (file, ...args) => {
  const name = normalize(file);
  if (!name.startsWith("artifacts/")) return originalPromises.lstat(file, ...args);
  return {
    isSymbolicLink: () => false,
    isDirectory: () => !virtual.has(name),
    isFile: () => virtual.has(name),
    size: virtual.get(name)?.length,
  };
};
fsp.cp = async (from, to, ...args) =>
  normalize(from) === "artifacts/web" ? undefined : originalPromises.cp(from, to, ...args);
fsp.rm = async (file, ...args) =>
  normalize(file) === "apps/web/dist/artifact-manifest.json"
    ? undefined
    : originalPromises.rm(file, ...args);
const readOriginal = fs.readFileSync;
fs.readFileSync = (file, ...args) => {
  const normalized = String(file).replaceAll("\\", "/");
  if (virtual.has(normalized))
    return normalized.endsWith(".json")
      ? virtual.get(normalized).toString()
      : virtual.get(normalized);
  if (normalized === "artifacts/windows/out/release-manifest.json") return JSON.stringify(manifest);
  if (normalized === "artifacts/windows/out/desktop-release.json") return JSON.stringify(candidate);
  if (artifactNames.some((name) => normalized === packageRoot + "/" + name)) return bytes;
  return readOriginal(file, ...args);
};
fs.createReadStream = (file) => {
  assert.ok(
    artifactNames.some((name) => String(file).replaceAll("\\", "/") === packageRoot + "/" + name),
  );
  return Readable.from([bytes]);
};
let release;
if (["resume-published", "resume-bundle-published"].includes(mode))
  release = {
    id: 2,
    draft: false,
    target_commitish: process.env.RELEASE_SHA,
    assets: [packageName, publishedInstallerName].map((name) => ({
      name,
      size: bytes.length,
      digest: "sha256:" + candidate.sha256,
    })),
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
      jobs: [
        {
          name:
            resume && !mode.startsWith("resume-bundle-") ? "quality-gate" : "CI Gate · 合并检查",
          conclusion: "success",
        },
      ],
    });
  if (url.includes("/actions/runs/11/artifacts?"))
    return Response.json({
      total_count: 2,
      artifacts: [
        { id: 91, name: "production-web", expired: false },
        { id: 92, name: "windows-release", expired: false },
      ],
    });
  const artifactMatch = url.match(/\/actions\/artifacts\/(90|91|92)$/);
  if (artifactMatch)
    return Response.json({
      id: Number(artifactMatch[1]),
      expired: false,
      name:
        artifactMatch[1] === "90"
          ? "release-bundle-1"
          : artifactMatch[1] === "91"
            ? "build-web-1"
            : "build-windows-1",
      workflow_run: { id: 11 },
    });
  if (url === "https://api.github.com/repos/zhangheng2022/taskrelay/actions/runs/11")
    return Response.json({
      head_branch: "master",
      repository: { full_name: "zhangheng2022/taskrelay" },
      run_attempt: 1,
      path: ".github/workflows/release.yml",
      event: "workflow_dispatch",
    });
  if (url === "https://taskrelay.zhangheng.workers.dev/api/health") {
    assert.equal(deployed, true);
    return Response.json({
      service: "TaskRelay",
      protocolVersion: 19,
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
  const uploadPrefix =
    "https://uploads.github.com/repos/zhangheng2022/taskrelay/releases/2/assets?name=";
  if (url.startsWith(uploadPrefix)) {
    const requestedName = decodeURIComponent(url.slice(uploadPrefix.length));
    assert.ok([...artifactNames, publishedInstallerName].includes(requestedName));
    assert.deepEqual(options.body, bytes);
    assert.equal(release.draft, true);
    // GitHub 真实 API 会把 Squirrel 安装器名称的空格转成点；恢复必须匹配返回的资产名。
    const name = requestedName === installerName ? publishedInstallerName : requestedName;
    const asset = { name, size: bytes.length, digest: "sha256:" + candidate.sha256 };
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
  // 与生产入口读取同一绑定身份；网络仍全部截获到隔离 SQLite，不访问实际 D1。
  const db = `https://api.cloudflare.com/client/v4${dbPath}`;
  if (url === db + "/time_travel/bookmark")
    return Response.json({ success: true, result: { bookmark: "fixture-bookmark" } });
  if (url === db + "/query") {
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body);
    assert.doesNotMatch(body.sql, /\bFROM\s+devices\b/i, "发布入口不再查询设备状态");
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
