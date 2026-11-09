/** 检查工作流及本仓库 composite action 的安全约定；纯策略可通过与 CLI 相同入口验证。 */
export function validateWorkflow(document, file, composite = false) {
  const reference = (uses) => {
    if (uses && !uses.startsWith("./") && !/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/.test(uses))
      throw Error(`ACTION_SHA_REQUIRED:${file}`);
  };
  const steps = (items) => {
    for (const step of items ?? []) {
      reference(step.uses);
      if (step.run?.includes("${{")) throw Error(`INLINE_EXPRESSION_FORBIDDEN:${file}`);
    }
  };
  if (composite) {
    if (document.runs?.using !== "composite") throw Error(`LOCAL_ACTION_TYPE_INVALID:${file}`);
    steps(document.runs.steps);
    return;
  }
  const triggers =
    typeof document.on === "string"
      ? [document.on]
      : Array.isArray(document.on)
        ? document.on
        : Object.keys(document.on ?? {});
  if (triggers.includes("pull_request_target")) throw Error(`PR_TARGET_FORBIDDEN:${file}`);
  if (JSON.stringify(document.permissions) !== JSON.stringify({ contents: "read" }))
    throw Error(`WORKFLOW_DEFAULT_PERMISSION:${file}`);
  for (const [id, job] of Object.entries(document.jobs ?? {})) {
    reference(job.uses);
    if (job["runs-on"] && JSON.stringify(job["runs-on"]).includes("self-hosted"))
      throw Error("SELF_HOSTED_FORBIDDEN");
    if (
      job["runs-on"] &&
      (!Number.isInteger(job["timeout-minutes"]) || job["timeout-minutes"] <= 0)
    )
      throw Error(`JOB_TIMEOUT_REQUIRED:${file}`);
    if (job.secrets === "inherit") throw Error(`IMPLICIT_SECRETS_FORBIDDEN:${file}`);
    for (const [permission, value] of Object.entries(job.permissions ?? {})) {
      if (value === "none" || (value === "read" && ["contents", "actions"].includes(permission)))
        continue;
      if (
        permission === "security-events" &&
        value === "write" &&
        id === "codeql" &&
        file.endsWith("/ci.yml")
      )
        continue;
      if (
        permission === "contents" &&
        value === "write" &&
        id === "production" &&
        file.endsWith("/release.yml") &&
        job.environment === "production"
      )
        continue;
      throw Error(`JOB_PERMISSION_FORBIDDEN:${file}:${id}`);
    }
    steps(job.steps);
  }
}
