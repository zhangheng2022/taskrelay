/** 只读 D1 恢复计划：先核对原发布身份与阶段，再决定需要下载哪些原始附件。
 * 无附件不等于没有发布范围；已激活后的设备核验不再依赖过期的构建文件。 */
import { appendFileSync } from "node:fs";
import { query, github } from "./release-api.mjs";
import { phases } from "./release-core.mjs";
const raw = (await query("SELECT value FROM settings WHERE key=?", ["productionRelease"]))[0]
  .results[0]?.value;
if (!raw) throw Error("RELEASE_STATE_MISSING");
const record = JSON.parse(raw);
if (
  record.sha !== process.env.RELEASE_SHA ||
  record.artifactRunId !== process.env.ARTIFACT_RUN_ID ||
  !phases.includes(record.phase) ||
  record.phase === "complete"
)
  throw Error("RELEASE_RESUME_MISMATCH");
const previous = await github(`/actions/runs/${record.runId}`);
if (String(record.runId) !== process.env.GITHUB_RUN_ID && previous?.status !== "completed")
  throw Error("PREVIOUS_RELEASE_STILL_RUNNING");
const cloud =
  record.cloud &&
  phases.indexOf(record.phase) < phases.indexOf("deployed") &&
  record.phase !== "deploying";
const desktop = record.desktop && phases.indexOf(record.phase) < phases.indexOf("activated");
const outputs = { bundleId: "", legacyWebId: "", legacyWindowsId: "" };
if (cloud || desktop) {
  if (record.bundleId) {
    const artifact = await github(`/actions/artifacts/${record.bundleId}`);
    if (!artifact || artifact.expired || String(artifact.workflow_run?.id) !== record.artifactRunId)
      throw Error("RECOVERY_ARTIFACT_MISSING");
    outputs.bundleId = record.bundleId;
  } else {
    const list = await github(`/actions/runs/${record.artifactRunId}/artifacts?per_page=100`);
    if (list?.total_count !== list?.artifacts?.length) throw Error("ARTIFACT_LIST_INCOMPLETE");
    for (const [needed, name, key] of [
      [cloud, "production-web", "legacyWebId"],
      [desktop, "windows-release", "legacyWindowsId"],
    ]) {
      if (!needed) continue;
      const found = list.artifacts.filter((a) => a.name === name && !a.expired);
      if (found.length !== 1) throw Error("RECOVERY_ARTIFACT_MISSING");
      outputs[key] = String(found[0].id);
    }
  }
}
for (const [key, value] of Object.entries(outputs))
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `恢复阶段：${record.phase}；需要 Web 附件：${cloud}；需要 Windows 附件：${desktop}。\n`,
  );
