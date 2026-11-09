/** GitHub production 作业唯一发布入口。D1 保存 CAS 日志与原开关；任何异常都留在可核验阶段，不自动恢复领取。 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, createReadStream, appendFileSync } from "node:fs";
import path from "node:path";
import { cp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { verifyBundle, sourceArtifact } from "./release-artifacts.mjs";
import { validateSigning } from "./signing-policy.mjs";
import { createHash } from "node:crypto";
import { runRelease, phases } from "./release-core.mjs";
import {
  query,
  cloudflare,
  dbPath,
  github,
  repository,
  verifyQuality,
  productionOrigin,
  productionHealth,
} from "./release-api.mjs";

const sha = process.env.RELEASE_SHA;
if (process.env.GITHUB_REF !== "refs/heads/master" || process.env.GITHUB_ACTIONS !== "true")
  throw Error("PRODUCTION_ACTIONS_ONLY");
if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== sha)
  throw Error("CHECKOUT_SHA_MISMATCH");
const runId = process.env.GITHUB_RUN_ID;
const artifactRunId = process.env.ARTIFACT_RUN_ID ?? runId;
const mode = process.env.RELEASE_MODE ?? "publish";
const key = "productionRelease";
// 新基线只能导入独立库；常规发布绝不能在旧迁移链或冻结转换库上自动 apply。
const marker = await query(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='storage_meta'",
);
if (!marker[0].results.length) throw Error("OFFLINE_STORAGE_CUTOVER_REQUIRED");
if (
  (await query("SELECT version FROM storage_meta"))[0].results[0]?.version !== 2 ||
  (await query("SELECT value FROM settings WHERE key='storageFrozen'"))[0].results[0]?.value === "1"
)
  throw Error("OFFLINE_STORAGE_CUTOVER_REQUIRED");
const readState = async () =>
  (await query("SELECT value FROM settings WHERE key=?", [key]))[0].results[0]?.value;
const digest = async (file) => {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const command = (args) =>
  execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", ...args], {
    stdio: "inherit",
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    timeout: 600_000,
  });
const original = await readState();
let record;
let manifest, candidate, releasePlan, planHash;
const packageRoot = "artifacts/windows/apps/desktop/out/make/squirrel.windows/x64";
const loadDesktop = async () => {
  manifest = JSON.parse(readFileSync("artifacts/windows/out/release-manifest.json", "utf8"));
  if (mode !== "resume") validateSigning(manifest);
  candidate = JSON.parse(readFileSync("artifacts/windows/out/desktop-release.json", "utf8"));
  if (
    manifest.sourceCommit !== sha ||
    manifest.sourceDirty ||
    manifest.version !== candidate.version ||
    !manifest.installedAsarMatches ||
    manifest.systemEntry?.runner !== "github-hosted" ||
    manifest.actionsRunId !== (releasePlan?.sources.windows?.runId ?? artifactRunId)
  )
    throw Error("RELEASE_ACCEPTANCE_INVALID");
  for (const kind of ["packaged-smoke", "installed-smoke"])
    if (
      manifest.reports?.[kind]?.passed !== true ||
      manifest.reports[kind].version !== candidate.version
    )
      throw Error("SMOKE_REPORT_INVALID");
  for (const item of manifest.artifacts.filter((entry) => entry.file.includes("/make/")))
    if ((await digest(path.join(packageRoot, path.basename(item.file)))) !== item.sha256)
      throw Error("ARTIFACT_HASH_MISMATCH");
};
const requiredArtifacts = (state) => [
  ...(state.cloud &&
  phases.indexOf(state.phase) < phases.indexOf("deployed") &&
  state.phase !== "deploying"
    ? ["web"]
    : []),
  ...(state.desktop && phases.indexOf(state.phase) < phases.indexOf("activated")
    ? ["windows"]
    : []),
];
const loadBundle = async (state, expectedHash) => {
  const required = requiredArtifacts(state);
  if (!required.length) return;
  const verified = await verifyBundle("artifacts", sha, expectedHash, required);
  releasePlan = verified.plan;
  planHash = verified.hash;
  if (releasePlan.releaseRunId !== artifactRunId) throw Error("RELEASE_PLAN_RUN_MISMATCH");
  if (required.includes("web")) {
    await cp("artifacts/web", "apps/web/dist", { recursive: true });
    await rm("apps/web/dist/artifact-manifest.json");
  }
};
if (mode === "resume") {
  if (!original) throw Error("RELEASE_STATE_MISSING");
  record = JSON.parse(original);
  if (record.sha !== sha || !phases.includes(record.phase) || record.phase === "complete")
    throw Error("RELEASE_RESUME_MISMATCH");
  if (record.artifactRunId !== artifactRunId) throw Error("RESUME_ARTIFACT_RUN_MISMATCH");
  const prior = await github(`/actions/runs/${record.runId}`);
  if (record.runId !== runId && prior?.status !== "completed")
    throw Error("PREVIOUS_RELEASE_STILL_RUNNING");
  await verifyQuality(sha, !record.bundleId);
  if (record.bundleId) {
    if (!/^[a-f0-9]{64}$/.test(record.planHash ?? "")) throw Error("RELEASE_PLAN_HASH_MISSING");
    await loadBundle(record, record.planHash);
  }
  // 恢复不重新构建并替换公开候选；使用首次验收 run 的不可变附件。
  if (record.desktop && phases.indexOf(record.phase) < phases.indexOf("activated")) {
    await loadDesktop();
    if (candidate.sha256 !== record.packageSha256) throw Error("RESUME_ARTIFACT_CHANGED");
  }
  record = { ...record, runId };
} else {
  if (mode !== "publish") throw Error("RELEASE_MODE_INVALID");
  if (original && JSON.parse(original).phase !== "complete")
    throw Error("RELEASE_RECOVERY_REQUIRED");
  const settings = Object.fromEntries(
    (
      await query("SELECT key,value FROM settings WHERE key IN ('claimsEnabled','maintenance')")
    )[0].results.map((row) => [row.key, row.value]),
  );
  const cloud = process.env.RELEASE_CLOUD === "true",
    desktop = process.env.RELEASE_DESKTOP === "true";
  if (!cloud && !desktop) throw Error("RELEASE_SCOPE_EMPTY");
  const qualityRunId = await verifyQuality(sha);
  if (!/^\d+$/.test(process.env.RELEASE_BUNDLE_ID ?? "")) throw Error("RELEASE_BUNDLE_REQUIRED");
  const archive = await github(`/actions/artifacts/${process.env.RELEASE_BUNDLE_ID}`);
  if (
    !archive ||
    archive.expired ||
    String(archive.workflow_run?.id) !== runId ||
    archive.name !== `release-bundle-${process.env.GITHUB_RUN_ATTEMPT}`
  )
    throw Error("RELEASE_BUNDLE_INVALID");
  await loadBundle({ cloud, desktop, phase: "prepared" });
  if (String(releasePlan.qualityRunId) !== String(qualityRunId))
    throw Error("RELEASE_QUALITY_CHANGED");
  for (const kind of requiredArtifacts({ cloud, desktop, phase: "prepared" })) {
    const built = JSON.parse(readFileSync(`artifacts/${kind}/artifact-manifest.json`, "utf8"));
    await sourceArtifact(releasePlan.sources[kind].artifactId, built, qualityRunId, runId);
  }
  if (desktop) await loadDesktop();
  record = {
    sha,
    cloud,
    desktop,
    phase: "prepared",
    runId,
    artifactRunId: runId,
    bundleId: process.env.RELEASE_BUNDLE_ID,
    planHash,
    oldClaims: settings.claimsEnabled ?? "0",
    oldMaintenance: settings.maintenance ?? "0",
    createdAt: new Date().toISOString(),
    version: candidate?.version ?? null,
    packageSha256: candidate?.sha256 ?? null,
  };
}
const encoded = JSON.stringify(record);
if (original)
  await query("UPDATE settings SET value=? WHERE key=? AND value=?", [encoded, key, original]);
else await query("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", [key, encoded]);
if ((await readState()) !== encoded) throw Error("RELEASE_OWNERSHIP_CONFLICT");
let stored = encoded;
const assertOwnership = async () => {
  if ((await readState()) !== stored) throw Error("RELEASE_OWNERSHIP_LOST");
};
const settings = async (name, value) => {
  await assertOwnership();
  const saved = await query(
    "UPDATE settings SET value=? WHERE key=? AND EXISTS(SELECT 1 FROM settings WHERE key=? AND value=?)",
    [value, name, key, stored],
  );
  if (saved[0].meta?.changes !== 1) throw Error("RELEASE_SETTING_WRITE_UNCONFIRMED");
};
const busy = async () =>
  (
    await query(
      "SELECT (SELECT COUNT(*) FROM runs WHERE status IN ('running','waiting_user','verifying','unknown') OR cleanup_pending=1) + (SELECT COUNT(*) FROM ai_turns WHERE status='running') + (SELECT COUNT(*) FROM ai_calls WHERE status IN ('reserved','running')) + (SELECT COUNT(*) FROM ai_dispatch WHERE state IN ('pending','running')) n",
    )
  )[0].results[0].n;
const assertQuiescent = async () => {
  await assertOwnership();
  if (await busy()) throw Error("EXECUTION_NOT_QUIESCENT");
  const { PROTOCOL_VERSION } = await import(
    pathToFileURL(path.resolve("packages/contracts/src/index.ts")).href
  );
  if (
    (
      await query("SELECT COUNT(*) n FROM runs WHERE status='queued' AND execution_protocol<>?", [
        PROTOCOL_VERSION,
      ])
    )[0].results[0].n
  )
    throw Error("INCOMPATIBLE_QUEUED_EXECUTIONS");
};
const catalogValue = async () =>
  (await query("SELECT value FROM settings WHERE key='desktopReleaseCatalog'"))[0].results[0]
    ?.value;
const updateCatalog = async (activate) => {
  await assertOwnership();
  const { releaseCatalogSchema, releaseSchema } = await import(
    pathToFileURL(path.resolve("packages/contracts/src/updates.ts")).href
  );
  releaseSchema.parse(candidate);
  const current = await catalogValue();
  const catalog = releaseCatalogSchema.parse(
    current
      ? JSON.parse(current)
      : JSON.parse(readFileSync("apps/cloud/src/desktop-releases.json", "utf8")),
  );
  const existing = catalog.releases.find((release) => release.version === candidate.version);
  if (
    existing &&
    (existing.sha256 !== candidate.sha256 ||
      existing.sha1 !== candidate.sha1 ||
      existing.bytes !== candidate.bytes)
  )
    throw Error("IMMUTABLE_RELEASE_CHANGED");
  if (!existing) catalog.releases.push(candidate);
  if (activate) catalog.latest = candidate.version;
  releaseCatalogSchema.parse(catalog);
  const next = JSON.stringify(catalog);
  if (current)
    await query("UPDATE settings SET value=? WHERE key='desktopReleaseCatalog' AND value=?", [
      next,
      current,
    ]);
  else
    await query("INSERT OR IGNORE INTO settings(key,value) VALUES('desktopReleaseCatalog',?)", [
      next,
    ]);
  if ((await catalogValue()) !== next) throw Error("CATALOG_CONFLICT");
};
const io = {
  assertOwnership,
  save: async (_before, next) => {
    const value = JSON.stringify({ ...next, updatedAt: new Date().toISOString() });
    await query("UPDATE settings SET value=? WHERE key=? AND value=?", [value, key, stored]);
    if ((await readState()) !== value) throw Error("RELEASE_STATE_CONFLICT");
    stored = value;
    console.log(`发布阶段：${next.phase}`);
    return JSON.parse(value);
  },
  pause: async () => {
    await settings("claimsEnabled", "0");
  },
  drain: async () => {
    const deadline = Date.now() + 600_000;
    while (await busy()) {
      if (Date.now() > deadline) throw Error("RELEASE_DRAIN_TIMEOUT");
      console.log("等待旧执行清理确认…");
      await sleep(10_000);
      await assertOwnership();
    }
    await settings("maintenance", "1");
    await assertQuiescent();
  },
  bookmark: async () => {
    const result = await cloudflare(`${dbPath}/time_travel/bookmark`);
    if (!result.bookmark) throw Error("D1_BOOKMARK_MISSING");
    return result.bookmark;
  },
  migrate: async () => {
    await assertQuiescent();
    command(["d1", "migrations", "apply", "DB", "--remote", "--config", "apps/web/wrangler.jsonc"]);
    const applied = new Set(
      (await query("SELECT name FROM d1_migrations"))[0].results.map((row) => row.name),
    );
    if (
      readdirSync("apps/cloud/migrations")
        .filter((file) => file.endsWith(".sql"))
        .some((file) => !applied.has(file))
    )
      throw Error("D1_MIGRATIONS_INCOMPLETE");
  },
  assertQuiescent,
  deploy: async () => {
    await assertQuiescent();
    command([
      "deploy",
      "--config",
      "apps/web/dist/taskrelay/wrangler.json",
      "--var",
      `RELEASE_SHA:${sha}`,
      "--message",
      `GitHub Actions ${sha}`,
      "--keep-vars",
    ]);
  },
  deployed: async () => {
    return (await productionHealth()).sourceCommit === sha;
  },
  publish: async () => {
    await assertOwnership();
    const tag = `v${candidate.version}`;
    let release = await github(`/releases/tags/${tag}`);
    if (!release)
      release = await github("/releases", "POST", {
        tag_name: tag,
        target_commitish: sha,
        name: `TaskRelay ${candidate.version}`,
        body: candidate.notes,
        draft: true,
        prerelease: false,
      });
    if (release.target_commitish !== sha) throw Error("RELEASE_TAG_SHA_MISMATCH");
    for (const item of manifest.artifacts.filter((entry) => entry.file.includes("/make/"))) {
      const name = path.basename(item.file);
      // GitHub 上传 API 会改写空格。固定 Squirrel 安装器的公开名称，
      // 恢复时按同一名称核对哈希；磁盘仍读取原始验收文件，不覆盖已公开资产。
      const assetName = name === "TaskRelay Setup.exe" ? "TaskRelay.Setup.exe" : name;
      const existing = release.assets.find((asset) => asset.name === assetName);
      if (existing) {
        if (existing.size !== item.bytes || existing.digest !== `sha256:${item.sha256}`)
          throw Error("EXISTING_RELEASE_ASSET_MISMATCH");
      } else {
        if (!release.draft) throw Error("PUBLISHED_RELEASE_ASSET_MISSING");
        const response = await fetch(
          `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`,
          {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(600_000),
            headers: {
              Authorization: `Bearer ${process.env.GH_TOKEN}`,
              "Content-Type": "application/octet-stream",
            },
            body: readFileSync(path.join(packageRoot, name)),
          },
        );
        if (!response.ok) throw Error(`RELEASE_UPLOAD_FAILED:${response.status}`);
        const uploaded = await response.json();
        if (uploaded.name !== assetName || uploaded.digest !== `sha256:${item.sha256}`)
          throw Error("UPLOADED_ASSET_HASH_MISMATCH");
      }
    }
    if (release.draft) await github(`/releases/${release.id}`, "PATCH", { draft: false });
  },
  register: async () => updateCatalog(false),
  verifyDownload: async () => {
    const { packagePath } = await import(
      pathToFileURL(path.resolve("packages/contracts/src/updates.ts")).href
    );
    const response = await fetch(productionOrigin + packagePath(candidate), {
      redirect: "error",
      signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok || !response.body)
      throw Error(`CLOUDFLARE_DOWNLOAD_FAILED:${response.status}`);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > candidate.bytes) throw Error("DOWNLOAD_SIZE_MISMATCH");
      hash.update(chunk);
    }
    if (size !== candidate.bytes || hash.digest("hex") !== candidate.sha256)
      throw Error("CLOUDFLARE_DOWNLOAD_HASH_MISMATCH");
  },
  activate: async () => updateCatalog(true),
  restore: async (state) => {
    await settings("maintenance", state.oldMaintenance);
    await settings("claimsEnabled", state.oldClaims);
  },
};
let result;
try {
  result = await runRelease(io, record);
} finally {
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `恢复参数：mode=resume，source-sha=${sha}，recovery-run=${artifactRunId}。\n`,
    );
}
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `生产发布：已完成（${result.phase}）\n\n提交：${sha}\n\nD1 恢复点已保存在 productionRelease 配置中。\n`,
  );
