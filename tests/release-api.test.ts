import test from "node:test";
import assert from "node:assert/strict";
import { verifyQuality, cloudflare, query, productionHealth } from "../scripts/release-api.mjs";
import { requestUrl } from "./http-fixture";
const sha = "a".repeat(40);
test("发布健康检查使用固定机器入口，无凭据和重试，拒绝错误服务或版本元数据", async (t) => {
  let status = 200;
  let body: unknown = { service: "TaskRelay", protocolVersion: 17, sourceCommit: sha };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    assert.equal(requestUrl(input), "https://taskrelay.zhangheng.workers.dev/api/health");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.headers, undefined);
    return Response.json(body, { status });
  });
  assert.equal((await productionHealth()).sourceCommit, sha);
  body = { service: "TaskRelay", protocolVersion: 17 };
  assert.equal((await productionHealth()).sourceCommit, undefined);
  for (const invalid of [
    null,
    { service: "Other", protocolVersion: 17 },
    { service: "TaskRelay", protocolVersion: 0 },
    { service: "TaskRelay", protocolVersion: 17, sourceCommit: "invalid" },
  ]) {
    body = invalid;
    await assert.rejects(productionHealth(), /PRODUCTION_HEALTH_INVALID/);
  }
  status = 403;
  body = "private upstream content";
  await assert.rejects(productionHealth(), { message: "PRODUCTION_HEALTH_UNAVAILABLE:403" });
  assert.equal(calls, 7);
});
test("发布预检只接受目标 SHA 的 master push 最新报告和唯一成功总门槛", async (t) => {
  let report = {
    id: 7,
    head_sha: sha,
    head_branch: "master",
    event: "push",
    status: "completed",
    conclusion: "success",
  };
  let jobs = [{ name: "quality-gate", conclusion: "success" }];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) =>
    requestUrl(input).includes("/jobs?")
      ? Response.json({ total_count: jobs.length, jobs })
      : Response.json({ workflow_runs: [report] }),
  );
  assert.equal(await verifyQuality(sha), 7);
  for (const patch of [
    { head_sha: "b".repeat(40) },
    { event: "pull_request" },
    { status: "in_progress" },
    { conclusion: "failure" },
  ]) {
    const previous = report;
    report = { ...report, ...patch };
    await assert.rejects(verifyQuality(sha));
    report = previous;
  }
  jobs = [];
  await assert.rejects(verifyQuality(sha));
  jobs = [{ name: "quality-gate", conclusion: "cancelled" }];
  await assert.rejects(verifyQuality(sha));
});
test("生产 API 禁止重定向、隐藏上游秘密，失败及未知结果不重试", async (t) => {
  const original = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = "fixture-token";
  t.after(() => {
    if (original === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = original;
  });
  let calls = 0;
  let mode = "http";
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    assert.equal(init?.redirect, "error");
    if (mode === "http") return new Response("sensitive-upstream-body", { status: 403 });
    if (mode === "database")
      return Response.json({ success: true, result: [{ success: false, results: [] }] });
    throw Error("request outcome unknown");
  });
  await assert.rejects(
    cloudflare("/accounts"),
    (error: Error) => error.message === "CLOUDFLARE_API_FAILED:403",
  );
  mode = "database";
  await assert.rejects(query("SELECT 1"), /D1_QUERY_FAILED/);
  mode = "unknown";
  await assert.rejects(cloudflare("/accounts", "POST", {}));
  assert.equal(calls, 3);
});
