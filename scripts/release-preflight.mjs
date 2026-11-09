/** 发布固定 master 提交且重新核验该 SHA 的主分支质量报告；范围遗漏和同版本桌面改动在构建前阻止。 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { github, verifyQuality, productionHealth } from "./release-api.mjs";
import { changedPaths } from "./workflow-policy.mjs";
import { releaseScope, assertNewDesktopVersion } from "./release-core.mjs";
const sha = process.env.RELEASE_SHA || process.env.GITHUB_SHA;
if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw Error("RELEASE_SHA_INVALID");
if (process.env.GITHUB_REF !== "refs/heads/master") throw Error("RELEASE_REQUIRES_MASTER");
const mode = process.env.RELEASE_MODE ?? "publish";
if (!["publish", "resume"].includes(mode)) throw Error("RELEASE_MODE_INVALID");
const qualityRunId = mode === "publish" ? await verifyQuality(sha) : "";
execFileSync("git", ["merge-base", "--is-ancestor", sha, "origin/master"]);
let base;
const data = mode === "publish" ? await productionHealth() : {};
if (/^[a-f0-9]{40}$/.test(data.sourceCommit ?? "")) base = data.sourceCommit;
// 首次迁移到 Actions 时旧服务没有 SHA 元数据，保守发布云端和执行器。
const files = base ? changedPaths(base, sha) : ["package-lock.json"];
let scope =
  mode === "publish"
    ? releaseScope(files, process.env.RELEASE_SCOPE ?? "auto")
    : { cloud: false, desktop: false };
const current = JSON.parse(
  execFileSync("git", ["show", `${sha}:apps/desktop/package.json`], { encoding: "utf8" }),
);
const latest = mode === "publish" ? await github("/releases/latest") : null;
if (latest) {
  const oldVersion = latest.tag_name.replace(/^v/, "");
  const publishedSha = execFileSync("git", ["rev-parse", `${latest.tag_name}^{commit}`], {
    encoding: "utf8",
  }).trim();
  const desktopFiles = changedPaths(publishedSha, sha);
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
  // 恢复所需附件由 production 作业读取 D1 阶段决定，不能按附件是否过期推断发布范围。
}
if (mode === "publish" && !scope.cloud && !scope.desktop) throw Error("NO_RELEASE_CHANGES");
if (mode === "publish" && scope.desktop && (await github(`/releases/tags/v${current.version}`)))
  throw Error("RELEASE_VERSION_EXISTS");
let webArtifactId = "",
  windowsArtifactId = "";
if (mode === "publish") {
  const run = await github(`/actions/runs/${qualityRunId}`);
  const artifacts = await github(`/actions/runs/${qualityRunId}/artifacts?per_page=100`);
  if (artifacts?.total_count !== artifacts?.artifacts?.length)
    throw Error("ARTIFACT_LIST_INCOMPLETE");
  const find = (kind) => {
    const found = artifacts.artifacts.filter(
      (a) => a.name === `ci-${kind}-${run.run_attempt}` && !a.expired,
    );
    if (found.length > 1) throw Error("ARTIFACT_SOURCE_AMBIGUOUS");
    return found.length ? String(found[0].id) : "";
  };
  if (scope.cloud) webArtifactId = find("web");
  if (scope.desktop) windowsArtifactId = find("windows");
}
const plan = {
  sha,
  mode,
  ...scope,
  version: current.version,
  artifactRunId,
  qualityRunId,
  webArtifactId,
  windowsArtifactId,
  buildWeb: mode === "publish" && scope.cloud && !webArtifactId,
  buildWindows: mode === "publish" && scope.desktop && !windowsArtifactId,
};
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
