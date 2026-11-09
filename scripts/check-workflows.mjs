/** 工作流静态检查和权限约束；不运行 PR 中的部署步骤。ShellCheck 路径显式传给 actionlint。 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { validateWorkflow } from "./workflow-validation.mjs";
import { qualityTool } from "./quality-tools.mjs";

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .trim()
  .split(/\r?\n/);
const workflows = tracked.filter((file) => /^\.github\/workflows\/.*\.ya?ml$/.test(file));
if (!workflows.length) throw Error("WORKFLOWS_MISSING");
for (const file of workflows) validateWorkflow(parse(readFileSync(file, "utf8")), file);
for (const file of tracked.filter((file) => /^\.github\/actions\/.+\/action\.ya?ml$/.test(file)))
  validateWorkflow(parse(readFileSync(file, "utf8")), file, true);
const shellcheck = await qualityTool("shellcheck");
execFileSync(await qualityTool("actionlint"), ["-color", "-shellcheck", shellcheck, ...workflows], {
  stdio: "inherit",
  windowsHide: true,
});
execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", "scripts/check-powershell.ps1"], {
  stdio: "inherit",
  windowsHide: true,
});
