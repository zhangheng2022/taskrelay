/** 质量汇总只接受明确成功；取消、漏跑、缺少报告都阻止合并。条件安装作业只由受测路径判定决定跳过。 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function verifyJobs(jobs, desktopRequired, codeRequired = true) {
  const required = ["static", "secrets"];
  if (codeRequired)
    required.push("test-linux", "test-windows", "security", "codeql", "web", "workflow-checks");
  if (desktopRequired) required.push("desktop");
  for (const name of required) {
    if (jobs[name]?.result !== "success" || jobs[name]?.outputs?.verified !== "true")
      throw Error(`QUALITY_JOB_INCOMPLETE:${name}`);
  }
  for (const name of [
    "test-linux",
    "test-windows",
    "security",
    "codeql",
    "web",
    "workflow-checks",
    "desktop",
  ]) {
    if (!required.includes(name) && !["success", "skipped"].includes(jobs[name]?.result))
      throw Error(`QUALITY_JOB_UNEXPECTED_STATE:${name}`);
  }
}
export function verifyPlan(jobs) {
  const scope = jobs.scope;
  if (
    scope?.result !== "success" ||
    !["true", "false"].includes(scope.outputs?.desktop) ||
    !["true", "false"].includes(scope.outputs?.code)
  )
    throw Error("QUALITY_SCOPE_INVALID");
  if (scope.outputs.desktop === "true" && scope.outputs.code !== "true")
    throw Error("QUALITY_SCOPE_INVALID");
  verifyJobs(jobs, scope.outputs.desktop === "true", scope.outputs.code === "true");
}

export function verifySarif(document) {
  if (!Array.isArray(document.runs) || !document.runs.length) throw Error("CODEQL_REPORT_MISSING");
  let count = 0;
  for (const run of document.runs) {
    if (!Array.isArray(run.results) || !run.tool?.driver) throw Error("CODEQL_REPORT_INVALID");
    // 新版 CodeQL 将查询包规则放在 extensions；按 SARIF 组件引用解析，不能只看 driver。
    const components = [run.tool.driver, ...(run.tool.extensions ?? [])];
    if (run.invocations?.some((item) => item.executionSuccessful === false))
      throw Error("CODEQL_SCAN_FAILED");
    for (const result of run.results) {
      const reference = result.rule;
      const componentRef = reference?.toolComponent;
      const selected = componentRef
        ? (run.tool.extensions ?? []).filter((component, index) =>
            componentRef.index !== undefined
              ? index === componentRef.index
              : componentRef.guid
                ? component.guid === componentRef.guid
                : component.name === componentRef.name,
          )
        : components;
      const ruleId = result.ruleId ?? reference?.id;
      const candidates = selected.flatMap((component) =>
        (component.rules ?? []).filter((item, index) =>
          ruleId !== undefined
            ? item.id === ruleId
            : index === (reference?.index ?? result.ruleIndex),
        ),
      );
      if (candidates.length !== 1) throw Error("CODEQL_RULE_MISSING_OR_AMBIGUOUS");
      const rule = candidates[0];
      const score = rule.properties?.["security-severity"];
      const level = result.level ?? rule.defaultConfiguration?.level ?? "warning";
      // 包含被标为 suppressed/baseline 的结果；门槛不依赖 GitHub UI 是否隐藏发现。
      if ((score !== undefined && Number(score) >= 7) || (score === undefined && level === "error"))
        count++;
      if (score !== undefined && !Number.isFinite(Number(score)))
        throw Error("CODEQL_SEVERITY_INVALID");
    }
  }
  if (count) throw Error(`CODEQL_BLOCKING_FINDINGS:${count}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "sarif") verifySarif(JSON.parse(readFileSync(process.argv[3], "utf8")));
  else verifyPlan(JSON.parse(process.env.QUALITY_NEEDS ?? "{}"));
  console.log("质量门槛通过");
}
