import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { parse } from "yaml";
import { checkPlan, changedPaths, releaseImpact } from "../scripts/workflow-policy.mjs";
import { verifyPlan } from "../scripts/quality-gate.mjs";
import { validateWorkflow } from "../scripts/workflow-validation.mjs";
import { workspaceFixture } from "./workspace-fixture";

test("范围策略区分文档、产品与 CI 变更，未知内容全量", () => {
  assert.deepEqual(checkPlan(["README.md", "docs/ARCHITECTURE.md"]), {
    code: false,
    desktop: false,
  });
  assert.deepEqual(checkPlan(["apps/cloud/src/user.ts"]), { code: true, desktop: false });
  for (const file of [
    "package-lock.json",
    "packages/ui/src/app.tsx",
    "resources/browser-release.json",
    "unknown.config",
    "docs/RELEASE-NOTES.md",
    ".github/workflows/ci.yml",
  ])
    assert.equal(checkPlan([file]).desktop, true, file);
  assert.deepEqual(checkPlan(null), { code: true, desktop: true });
  assert.deepEqual(releaseImpact([".github/workflows/ci.yml", "scripts/release-artifacts.mjs"]), {
    cloud: false,
    desktop: false,
  });
  assert.deepEqual(releaseImpact(["scripts/stage-runtime.mjs"]), { cloud: false, desktop: true });
  assert.throws(() => releaseImpact(["packages/contracts/src/index.ts"], "cloud"));
});

test("真实 Git 差异保留重命名前的代码路径", async (t) => {
  const root = await workspaceFixture(t, "scope");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await mkdir(path.join(root, "apps/desktop"), { recursive: true });
  await writeFile(path.join(root, "apps/desktop/old.ts"), "// fixture\n");
  git("add", ".");
  git("commit", "-m", "初始");
  const base = git("rev-parse", "HEAD").trim();
  git("mv", "apps/desktop/old.ts", "README.md");
  git("commit", "-m", "移至文档");
  // 同 CLI 运行，避免改变测试进程的全局 cwd。
  const result = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const m=await import(process.argv[1]);console.log(JSON.stringify(m.changedPaths(process.argv[2])))",
      new URL("../scripts/workflow-policy.mjs", import.meta.url).href,
      base,
    ],
    { cwd: root, encoding: "utf8" },
  );
  const files: string[] = JSON.parse(result);
  assert.ok(files.includes("apps/desktop/old.ts"));
  assert.ok(files.includes("README.md"));
  assert.equal(checkPlan(files).desktop, true);
  assert.throws(() => changedPaths("not-a-commit"));
});

test("总门槛不因 scope 失败、非法输出、必需作业漏跑而放行", () => {
  const jobs: Record<string, { result: string; outputs?: Record<string, string> }> =
    Object.fromEntries(
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
  jobs.scope = { result: "success", outputs: { code: "true", desktop: "true" } };
  verifyPlan(jobs);
  for (const patch of [
    { result: "cancelled" },
    { result: "success", outputs: { code: "", desktop: "false" } },
    { result: "success", outputs: { code: "false", desktop: "true" } },
  ])
    assert.throws(() => verifyPlan({ ...jobs, scope: patch }));
  jobs.scope = { result: "success", outputs: { code: "false", desktop: "false" } };
  for (const name of Object.keys(jobs).filter(
    (key) => !["scope", "static", "secrets"].includes(key),
  ))
    jobs[name] = { result: "skipped" };
  verifyPlan(jobs);
  assert.throws(() => verifyPlan({ ...jobs, secrets: { result: "skipped" } }));
  assert.throws(() => verifyPlan({ ...jobs, desktop: { result: "failure" } }));
});

test("现有工作流和本地 action 满足安全策略，扩大权限或浮动引用被拒绝", async () => {
  for (const file of ["ci.yml", "release.yml", "build-windows.yml"])
    validateWorkflow(
      parse(await readFile(`.github/workflows/${file}`, "utf8")),
      `.github/workflows/${file}`,
    );
  validateWorkflow(
    parse(await readFile(".github/actions/setup-node/action.yml", "utf8")),
    ".github/actions/setup-node/action.yml",
    true,
  );
  const base = {
    on: "push",
    permissions: { contents: "read" },
    jobs: { test: { "runs-on": "ubuntu-24.04", "timeout-minutes": 5 } },
  };
  for (const job of [
    { uses: "owner/repo/.github/workflows/ci.yml@main" },
    { "runs-on": "self-hosted", "timeout-minutes": 5 },
    { "runs-on": "ubuntu-24.04" },
    { secrets: "inherit" },
    { permissions: { contents: "write" } },
    { steps: [{ run: "echo ${{ github.event.pull_request.title }}" }] },
  ])
    assert.throws(() =>
      validateWorkflow({ ...base, jobs: { test: job } }, ".github/workflows/ci.yml"),
    );
  assert.throws(() =>
    validateWorkflow({ ...base, on: "pull_request_target" }, ".github/workflows/ci.yml"),
  );
});
