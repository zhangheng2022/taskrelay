/** 发布固定 master 提交且重新核验该 SHA 的主分支质量报告；范围遗漏和同版本桌面改动在构建前阻止。 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { github, verifyQuality } from "./release-api.mjs";
import { releaseScope, assertNewDesktopVersion } from "./release-core.mjs";
const sha = process.env.RELEASE_SHA || process.env.GITHUB_SHA;
if (process.env.GITHUB_REF !== "refs/heads/master") throw Error("RELEASE_REQUIRES_MASTER");
await verifyQuality(sha);
execFileSync("git", ["merge-base", "--is-ancestor", sha, "origin/master"]);
const mode = process.env.RELEASE_MODE ?? "publish";
if (!["publish", "resume"].includes(mode)) throw Error("RELEASE_MODE_INVALID");
let base;
const health = await fetch("https://tr.zhangheng.eu.org/api/health", {
  redirect: "error",
  signal: AbortSignal.timeout(15_000),
});
if (!health.ok) throw Error("PRODUCTION_HEALTH_UNAVAILABLE");
const data = await health.json();
if (/^[a-f0-9]{40}$/.test(data.sourceCommit ?? "")) base = data.sourceCommit;
// 首次迁移到 Actions 时旧服务没有 SHA 元数据，保守发布云端和执行器。
const files = base
  ? execFileSync("git", ["diff", "--name-only", `${base}..${sha}`], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/)
  : ["package-lock.json"];
let scope = releaseScope(files, process.env.RELEASE_SCOPE ?? "auto");
const current = JSON.parse(
  execFileSync("git", ["show", `${sha}:apps/desktop/package.json`], { encoding: "utf8" }),
);
const latest = await github("/releases/latest");
if (latest) {
  const oldVersion = latest.tag_name.replace(/^v/, "");
  const publishedSha = execFileSync("git", ["rev-parse", `${latest.tag_name}^{commit}`], {
    encoding: "utf8",
  }).trim();
  const desktopFiles = execFileSync("git", ["diff", "--name-only", `${publishedSha}..${sha}`], {
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/);
  const desktopNeeded = releaseScope(desktopFiles).desktop;
  if (desktopNeeded && process.env.RELEASE_SCOPE === "cloud")
    throw Error("UNRELEASED_DESKTOP_CHANGES");
  scope.desktop ||= desktopNeeded;
  if (mode === "publish" && scope.desktop) assertNewDesktopVersion(current.version, oldVersion);
}
let artifactRunId = process.env.GITHUB_RUN_ID;
if (mode === "resume") {
  artifactRunId = process.env.RECOVERY_RUN;
  if (!/^\d+$/.test(artifactRunId ?? "")) throw Error("RECOVERY_RUN_REQUIRED");
  const originalRun = await github(`/actions/runs/${artifactRunId}`);
  if (
    !originalRun ||
    originalRun.head_branch !== "master" ||
    originalRun.event !== "workflow_dispatch" ||
    originalRun.path !== ".github/workflows/release.yml" ||
    originalRun.status !== "completed"
  )
    throw Error("RECOVERY_RUN_INVALID");
  // 只读取首次产物目录，不重新打包；实际恢复范围由 D1 原记录决定。
  const artifacts = await github(`/actions/runs/${artifactRunId}/artifacts?per_page=100`);
  scope = {
    cloud: artifacts.artifacts.some((a) => a.name === "production-web" && !a.expired),
    desktop: artifacts.artifacts.some((a) => a.name === "windows-release" && !a.expired),
  };
}
if (mode === "publish" && !scope.cloud && !scope.desktop) throw Error("NO_RELEASE_CHANGES");
if (mode === "publish" && scope.desktop && (await github(`/releases/tags/v${current.version}`)))
  throw Error("RELEASE_VERSION_EXISTS");
const plan = { sha, mode, ...scope, version: current.version, artifactRunId };
if (process.env.GITHUB_OUTPUT)
  for (const [name, value] of Object.entries(plan))
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `发布提交：${sha}\n\n范围：云端 ${scope.cloud}，执行器 ${scope.desktop}（${current.version}）\n`,
  );
// 读取锁文件确认预检针对完整 checkout，未执行任何生产写入。
JSON.parse(readFileSync("package-lock.json", "utf8"));
console.log(JSON.stringify(plan));
