/** 工作流静态检查和权限约束；不运行 PR 中的部署步骤。ShellCheck 路径显式传给 actionlint。 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { qualityTool } from "./quality-tools.mjs";

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .trim()
  .split(/\r?\n/);
const workflows = tracked.filter((file) => /^\.github\/workflows\/.*\.ya?ml$/.test(file));
if (!workflows.length) throw Error("WORKFLOWS_MISSING");
for (const file of workflows) {
  const workflow = parse(readFileSync(file, "utf8"));
  const triggers =
    typeof workflow.on === "string"
      ? [workflow.on]
      : Array.isArray(workflow.on)
        ? workflow.on
        : Object.keys(workflow.on ?? {});
  if (triggers.includes("pull_request_target")) throw Error(`PR_TARGET_FORBIDDEN:${file}`);
  if (workflow.permissions?.contents !== "read") throw Error(`WORKFLOW_DEFAULT_PERMISSION:${file}`);
  for (const job of Object.values(workflow.jobs ?? {})) {
    if (job["runs-on"] && JSON.stringify(job["runs-on"]).includes("self-hosted"))
      throw Error("SELF_HOSTED_FORBIDDEN");
    for (const step of job.steps ?? []) {
      if (
        step.uses &&
        !step.uses.startsWith("./") &&
        !/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/.test(step.uses)
      )
        throw Error(`ACTION_SHA_REQUIRED:${file}`);
      if (step.run?.includes("${{")) throw Error(`INLINE_EXPRESSION_FORBIDDEN:${file}`);
    }
  }
}
const shellcheck = await qualityTool("shellcheck");
execFileSync(await qualityTool("actionlint"), ["-color", "-shellcheck", shellcheck, ...workflows], {
  stdio: "inherit",
  windowsHide: true,
});
execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", "scripts/check-powershell.ps1"], {
  stdio: "inherit",
  windowsHide: true,
});
