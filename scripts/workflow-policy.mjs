/** CI 与发布共用路径事实；检查范围与产品发布范围分别输出，未知路径保守全量。
 * 删除/重命名用 --no-renames 保留前后路径，PR 比较合并基点，push 比较实际前后提交。 */
import { execFileSync } from "node:child_process";

export const ciGateName = "CI Gate · 合并检查";
export function changedPaths(base, head = "HEAD", pullRequest = false) {
  return execFileSync(
    "git",
    [
      "--no-pager",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-only",
      "-z",
      `${base}${pullRequest ? "..." : ".."}${head}`,
    ],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
}
export function impact(files) {
  let code = false,
    desktop = false,
    cloud = false,
    desktopRelease = false;
  for (const file of files ?? ["unknown"]) {
    if (
      /^(README\.md|AGENTS\.md|PRODUCT\.md|CHANGELOG\.md|LICENSE|docs\/(?!RELEASE-NOTES\.md$).+\.md)$/.test(
        file,
      )
    )
      continue;
    code = true;
    if (/^apps\/(cloud|web)\//.test(file)) {
      cloud = true;
      continue;
    }
    if (/^(apps\/desktop\/|resources\/|docs\/RELEASE-NOTES\.md$)/.test(file)) {
      desktop = desktopRelease = true;
      continue;
    }
    if (/^tests\//.test(file)) {
      desktop ||=
        /tests\/(executor-|browser-state-|local-cdp\.|stagehand-|updater\.|ui-executor-)/.test(
          file,
        );
      continue;
    }
    // CI 编排本身要验收桌面，但不会要求用户为了改检查名称发布新应用版本。
    if (
      /^\.github\//.test(file) ||
      /^scripts\/(workflow-(?:policy|validation)|change-scope|quality-|check-|coverage|format|audit-runtime|release-(?:api|artifacts|preflight|production|recovery|core))/.test(
        file,
      )
    ) {
      desktop = true;
      continue;
    }
    if (
      /^scripts\/(signing-|windows-sign|prepare-browser|browser-download|verify-browser|stage-runtime|cdp-policy|smoke|install-smoke|release-manifest|prepare-update|icon|runtime-package-lock)/.test(
        file,
      )
    ) {
      desktop = desktopRelease = true;
      continue;
    }
    desktop = desktopRelease = cloud = true;
  }
  return { code, desktop, cloud, desktopRelease };
}
export function checkPlan(files) {
  const { code, desktop } = impact(files);
  return { code, desktop };
}
export function releaseImpact(files, requested = "auto") {
  if (!["auto", "cloud", "desktop", "all"].includes(requested))
    throw Error("RELEASE_SCOPE_INVALID");
  const { cloud, desktopRelease: desktop } = impact(files);
  if ((requested === "cloud" && desktop) || (requested === "desktop" && cloud))
    throw Error("RELEASE_SCOPE_OMITS_REQUIRED_CHANGES");
  return {
    cloud: cloud || ["all", "cloud"].includes(requested),
    desktop: desktop || ["all", "desktop"].includes(requested),
  };
}
