/** 输出经过保守分类的 CI 检查计划；手动、定时及差异不可用时执行全量。 */
import { appendFileSync } from "node:fs";
import { changedPaths, checkPlan } from "./workflow-policy.mjs";
const base = process.env.BASE_SHA;
let files = null;
if (
  !["schedule", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME) &&
  /^[a-f0-9]{40}$/.test(base ?? "") &&
  !/^0+$/.test(base)
) {
  try {
    files = changedPaths(base, "HEAD", process.env.GITHUB_EVENT_NAME === "pull_request");
  } catch {
    console.error("差异不可用，执行全量检查");
  }
}
const plan = checkPlan(files);
if (process.env.GITHUB_OUTPUT)
  for (const [key, value] of Object.entries(plan))
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `检查范围：${plan.code ? "代码检查、跨平台测试、安全与构建" : "纯文档：格式、仓库约束与秘密扫描"}；Windows 安装验收：${plan.desktop ? "需要" : "无相关改动，跳过"}。\n`,
  );
console.log(JSON.stringify(plan));
