/** Actions 发布 API 边界：固定服务地址，关闭重定向和自动重试，错误不透传响应正文或凭据。 */
export const repository = "zhangheng2022/taskrelay";
export const account = "b3a410496c5e49e582b4af19d2f2eec6";
export const database = "9d387f48-6e34-4af4-a2a0-10f958d65a16";
export const dbPath = `/accounts/${account}/d1/database/${database}`;
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
export async function verifyQuality(sha) {
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
  const gate = jobs.jobs.filter((item) => item.name === "quality-gate");
  if (gate.length !== 1 || gate[0].conclusion !== "success")
    throw Error("RELEASE_QUALITY_GATE_MISSING");
  return run.id;
}
