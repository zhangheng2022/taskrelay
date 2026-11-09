import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, copyFile, cp, readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  fileTree,
  verifyFiles,
  verifyBundle,
  sourceArtifact,
  sha256,
  type BuildManifest,
} from "../scripts/release-artifacts.mjs";
import { workspaceFixture } from "./workspace-fixture";
import { requestUrl } from "./http-fixture";
import { signedFixture } from "./signing-fixture.mjs";

const sha = "a".repeat(40);
test("Web 文件清单检测替换、额外文件、错误 SHA，恢复清单不能被替换", async (t) => {
  const root = await workspaceFixture(t, "scope");
  const web = path.join(root, "web");
  await mkdir(web);
  await writeFile(path.join(web, "index.html"), "accepted bytes");
  const manifest: BuildManifest = {
    schema: 1,
    kind: "web",
    sourceCommit: sha,
    version: "0.19.4",
    repository: "zhangheng2022/taskrelay",
    runId: "12",
    runAttempt: "2",
    files: await fileTree(web),
  };
  await writeFile(path.join(web, "artifact-manifest.json"), JSON.stringify(manifest));
  assert.deepEqual(await verifyFiles("web", web, sha), manifest);
  await assert.rejects(verifyFiles("web", web, "b".repeat(40)), /MANIFEST_INVALID/);
  const plan = JSON.stringify({
    schema: 1,
    sha,
    sources: { web: { manifestHash: sha256(JSON.stringify(manifest)) } },
  });
  await writeFile(path.join(root, "release-plan.json"), plan);
  await verifyBundle(root, sha, sha256(plan), ["web"]);
  await assert.rejects(verifyBundle(root, sha, "b".repeat(64), ["web"]), /RESUME_PLAN_CHANGED/);
  await assert.rejects(verifyBundle(root, sha, sha256(plan), ["windows"]), /ARTIFACT_MISSING/);
  await writeFile(path.join(web, "index.html"), "changed bytes");
  await assert.rejects(verifyFiles("web", web, sha), /FILES_MISMATCH/);
  await writeFile(path.join(web, "index.html"), "accepted bytes");
  await writeFile(path.join(web, "unexpected.js"), "extra");
  await assert.rejects(verifyFiles("web", web, sha), /FILES_MISMATCH/);
});

test("候选来源只接受相同提交的主分支 CI 或本次发布补建，拒绝 PR 与混合尝试", async (t) => {
  const manifest: BuildManifest = {
    schema: 1,
    kind: "web",
    sourceCommit: sha,
    version: "0.19.4",
    repository: "zhangheng2022/taskrelay",
    runId: "12",
    runAttempt: "2",
    files: {},
  };
  const validRun = {
    head_sha: sha,
    head_branch: "master",
    repository: { full_name: manifest.repository },
    run_attempt: 2,
    path: ".github/workflows/ci.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
  };
  let run = { ...validRun };
  let artifact = { expired: false, workflow_run: { id: 12 }, name: "ci-web-2" };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) =>
    Response.json(requestUrl(input).includes("/artifacts/") ? artifact : run),
  );
  assert.equal((await sourceArtifact("42", manifest, 12, "20")).runId, "12");
  for (const change of [
    { event: "pull_request" },
    { head_sha: "b".repeat(40) },
    { conclusion: "failure" },
    { run_attempt: 3 },
    { repository: { full_name: "other/repo" } },
    { path: ".github/workflows/other.yml" },
  ]) {
    run = { ...validRun, ...change };
    await assert.rejects(sourceArtifact("42", manifest, 12, "20"), /SOURCE_INVALID/);
  }
  run = validRun;
  artifact.expired = true;
  await assert.rejects(sourceArtifact("42", manifest, 12, "20"), /SOURCE_INVALID/);
  artifact = { expired: false, workflow_run: { id: 12 }, name: "build-web-2" };
  run = {
    ...validRun,
    path: ".github/workflows/release.yml",
    event: "workflow_dispatch",
    status: "in_progress",
  };
  await sourceArtifact("42", manifest, 1, "12");
  await assert.rejects(sourceArtifact("42", manifest, 1, "20"), /SOURCE_INVALID/);
});

test("真实构建与归档入口保留 Windows 路径和验收来源，并复核完整发布包", async (t) => {
  const root = await workspaceFixture(t, "scope");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  await mkdir(path.join(root, "apps/web"), { recursive: true });
  await mkdir(path.join(root, "apps/desktop"), { recursive: true });
  await copyFile("apps/web/wrangler.jsonc", path.join(root, "apps/web/wrangler.jsonc"));
  await writeFile(
    path.join(root, "apps/desktop/package.json"),
    JSON.stringify({ version: "0.19.4" }),
  );
  git("init");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", ".");
  git("commit", "-m", "构建夹具");
  const sourceCommit = git("rev-parse", "HEAD").trim();
  await mkdir(path.join(root, "apps/desktop/out/make/squirrel.windows/x64"), { recursive: true });
  await mkdir(path.join(root, "out"));
  await mkdir(path.join(root, "artifacts/web"), { recursive: true });
  for (const name of ["TaskRelay Setup.exe", "TaskRelay-0.19.4-full.nupkg"])
    await writeFile(
      path.join(root, "apps/desktop/out/make/squirrel.windows/x64", name),
      "accepted package",
    );
  const report = { passed: true, version: "0.19.4" };
  const acceptance = {
    ...signedFixture("0.19.4", sha256("accepted package")),
    sourceCommit,
    version: "0.19.4",
    actionsRunId: "12",
    actionsRunAttempt: "1",
    sourceDirty: false,
    installedAsarMatches: true,
    systemEntry: { runner: "github-hosted" },
    reports: { "packaged-smoke": report, "installed-smoke": report },
  };
  for (const [file, data] of Object.entries({
    "release-manifest": acceptance,
    "desktop-release": { version: "0.19.4" },
    "system-entry": acceptance.systemEntry,
    "packaged-smoke": report,
    "installed-smoke": report,
  }))
    await writeFile(path.join(root, `out/${file}.json`), JSON.stringify(data));
  await writeFile(path.join(root, "artifacts/web/index.html"), "accepted web");
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: "zhangheng2022/taskrelay",
    GITHUB_RUN_ID: "12",
    GITHUB_RUN_ATTEMPT: "1",
    RELEASE_SHA: sourceCommit,
    GH_TOKEN: "fixture",
    WEB_ARTIFACT_ID: "41",
    WINDOWS_ARTIFACT_ID: "42",
    GITHUB_STEP_SUMMARY: path.join(root, "summary"),
  };
  const script = fileURLToPath(new URL("../scripts/release-artifacts.mjs", import.meta.url));
  execFileSync(process.execPath, [script, "stage-windows"], { cwd: root, env });
  execFileSync(process.execPath, [script, "stamp", "web", "artifacts/web"], { cwd: root, env });
  await cp(path.join(root, "out/candidate-windows"), path.join(root, "artifacts/windows"), {
    recursive: true,
  });
  const loader = path.join(root, "network.mjs");
  await writeFile(
    loader,
    `globalThis.fetch = async (input) => {
    const url = String(input), sha = process.env.RELEASE_SHA;
    if (url.includes("/actions/workflows/ci.yml/runs?")) return Response.json({workflow_runs:[{id:1,head_sha:sha,head_branch:"master",event:"push",status:"completed",conclusion:"success"}]});
    if (url.includes("/jobs?")) return Response.json({total_count:1,jobs:[{name:"CI Gate · 合并检查",conclusion:"success"}]});
    if (url.includes("/artifacts/")) return Response.json({expired:false,workflow_run:{id:12},name:url.endsWith("41")?"build-web-1":"build-windows-1"});
    if (url.endsWith("/runs/12")) return Response.json({head_branch:"master",repository:{full_name:"zhangheng2022/taskrelay"},run_attempt:1,path:".github/workflows/release.yml",event:"workflow_dispatch"});
    throw Error("UNEXPECTED_NETWORK");
  };`,
  );
  execFileSync(process.execPath, ["--import", pathToFileURL(loader).href, script, "assemble"], {
    cwd: root,
    env,
  });
  await verifyBundle(path.join(root, "artifacts"), sourceCommit);
  assert.match(await readFile(path.join(root, "summary"), "utf8"), /本次补建/);
});
