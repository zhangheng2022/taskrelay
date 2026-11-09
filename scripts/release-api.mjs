/** Actions 发布 API 边界：固定服务地址，关闭重定向和自动重试，错误不透传响应正文或凭据。 */
import { ciGateName } from "./workflow-policy.mjs";
import { readFileSync } from "node:fs";
export const repository = "zhangheng2022/taskrelay";
// 单业务 D1 的标识只由 Wrangler 配置维护，离线换库后发布/备份不能再访问旧库。
const config = readFileSync("apps/web/wrangler.jsonc", "utf8");
const accounts = [...config.matchAll(/"account_id"\s*:\s*"([a-f0-9]{32})"/g)],
  databases = [...config.matchAll(/"database_id"\s*:\s*"([a-f0-9-]{36})"/g)];
if (accounts.length !== 1 || databases.length !== 1) throw Error("RELEASE_DATABASE_CONFIG_INVALID");
export const account = accounts[0][1];
export const database = databases[0][1];
export const dbPath = `/accounts/${account}/d1/database/${database}`;
// 托管 Runner 是 API 客户端；固定使用同一 Worker 已有的机器入口，避免主站 Bot Fight 人机挑战。
// 不携带用户 Cookie/部署令牌，不自动换域或降低主站防护；客户端更新地址仍为主站。
export const productionOrigin = "https://taskrelay.zhangheng.workers.dev";
export async function productionHealth() {
  const response = await fetch(`${productionOrigin}/api/health`, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!response.ok) throw Error(`PRODUCTION_HEALTH_UNAVAILABLE:${response.status}`);
  const data = await response.json();
  if (
    data?.service !== "TaskRelay" ||
    !Number.isSafeInteger(data.protocolVersion) ||
    data.protocolVersion < 1 ||
    (data.sourceCommit != null && !/^[a-f0-9]{40}$/.test(data.sourceCommit))
  )
    throw Error("PRODUCTION_HEALTH_INVALID");
  return data;
}
export async function github(route, method = "GET", body) {
  const response = await fetch(`https://api.github.com/repos/${repository}${route}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 404 && method === "GET") return null;
  if (!response.ok) throw Error(`GITHUB_API_FAILED:${response.status}`);
  return response.status === 204 ? null : response.json();
}
export async function cloudflare(route, method = "GET", body) {
  if (!process.env.CLOUDFLARE_API_TOKEN) throw Error("CLOUDFLARE_TOKEN_REQUIRED");
  const response = await fetch(`https://api.cloudflare.com/client/v4${route}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    headers: {
      Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw Error(`CLOUDFLARE_API_FAILED:${response.status}`);
  const data = await response.json();
  if (data.success !== true) throw Error("CLOUDFLARE_OPERATION_FAILED");
  return data.result;
}
export async function query(sql, params = []) {
  const rows = await cloudflare(`${dbPath}/query`, "POST", { sql, params });
  if (!Array.isArray(rows) || !rows.length || rows.some((row) => row.success !== true))
    throw Error("D1_QUERY_FAILED");
  return rows;
}
export async function verifyQuality(sha, legacy = false) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error("RELEASE_SHA_INVALID");
  const runs = await github(
    `/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`,
  );
  const run = runs?.workflow_runs?.find(
    (item) => item.head_sha === sha && item.head_branch === "master" && item.event === "push",
  );
  if (!run || run.status !== "completed" || run.conclusion !== "success")
    throw Error("RELEASE_QUALITY_NOT_GREEN");
  const jobs = await github(`/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
  if (jobs?.total_count !== jobs?.jobs?.length) throw Error("QUALITY_JOBS_INCOMPLETE");
  const gate = jobs.jobs.filter((item) => item.name === (legacy ? "quality-gate" : ciGateName));
  if (gate.length !== 1 || gate[0].conclusion !== "success")
    throw Error("RELEASE_QUALITY_GATE_MISSING");
  return run.id;
}
