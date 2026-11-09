import test from "node:test";
import assert from "node:assert/strict";
import { verifyJobs, verifySarif } from "../scripts/quality-gate.mjs";
import { assertFloors, changedLines, parseLcov } from "../scripts/check-coverage.mjs";

test("质量汇总拒绝取消、漏跑、缺报告及必要安装作业跳过", () => {
  const jobs = Object.fromEntries(
    [
      "static",
      "secrets",
      "test-linux",
      "test-windows",
      "workflow-checks",
      "security",
      "codeql",
      "web",
      "desktop",
    ].map((name) => [name, { result: "success", outputs: { verified: "true" } }]),
  );
  verifyJobs(jobs, true);
  for (const state of ["failure", "cancelled", "skipped", "unknown"]) {
    assert.throws(() => verifyJobs({ ...jobs, "test-linux": { result: state } }, true));
  }
  assert.throws(() => verifyJobs({ ...jobs, web: { result: "success" } }, true));
  assert.throws(() => verifyJobs({ ...jobs, desktop: { result: "skipped" } }, true));
  verifyJobs({ ...jobs, desktop: { result: "skipped" } }, false);
});
test("CodeQL 门槛读取实际规则严重程度，忽略 UI 隐藏不会放行", () => {
  const report = (score?: string, level = "warning") => ({
    runs: [
      {
        tool: {
          driver: {
            rules: [
              {
                id: "q",
                properties: score ? { "security-severity": score } : {},
                defaultConfiguration: { level },
              },
            ],
          },
        },
        results: [{ ruleId: "q", suppressions: [{ status: "accepted" }] }],
      },
    ],
  });
  verifySarif(report("6.9"));
  assert.throws(() => verifySarif(report("7.0")));
  assert.throws(() => verifySarif(report("9.8")));
  assert.throws(() => verifySarif(report(undefined, "error")));
  assert.throws(() => verifySarif({ runs: [] }));
  assert.throws(() => verifySarif(report("NaN")));
  const extensionReport = {
    runs: [
      {
        tool: {
          driver: { name: "CodeQL" },
          extensions: [
            {
              name: "codeql/javascript-queries",
              rules: [{ id: "q", properties: { "security-severity": "8.1" } }],
            },
          ],
        },
        results: [{ ruleId: "q", rule: { index: 0, toolComponent: { index: 0 } } }],
      },
    ],
  };
  assert.throws(() => verifySarif(extensionReport), /BLOCKING_FINDINGS/);
  extensionReport.runs[0].results = [];
  verifySarif(extensionReport);
});
test("覆盖率不能降低基线或漏报，差异行只按新增范围计数", () => {
  const summary = Object.fromEntries(
    ["lines", "branches", "functions"].map((key) => [key, { pct: 85, total: 100 }]),
  );
  const floor = { lines: 80, branches: 80, functions: 80 };
  assertFloors(summary, floor, floor);
  assert.throws(() => assertFloors(summary, { ...floor, lines: 79 }, floor));
  assert.throws(() => assertFloors(summary, { ...floor, branches: 90 }));
  assert.throws(() => assertFloors({}, floor));
  assert.throws(() => assertFloors(summary, {}), /FLOOR_INVALID/);
  assert.throws(() => assertFloors(summary, { ...floor, lines: NaN }), /FLOOR_INVALID/);
  assert.deepEqual([...changedLines("@@ -2,3 +4,2 @@\n@@ -9 +8,0 @@")], [4, 5]);
  assert.equal(
    parseLcov("SF:apps/a.ts\nDA:4,0\nDA:5,2\nend_of_record").get("apps/a.ts")?.get(5),
    2,
  );
});
