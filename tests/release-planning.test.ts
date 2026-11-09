import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { workspaceFixture } from "./workspace-fixture";
const exec = promisify(execFile);

test("发布预检真实入口选择 CI 附件、只补建缺失范围，恢复不按附件推断范围", async (t) => {
  const root = await workspaceFixture(t, "scope");
  const loader = path.join(root, "preflight.mjs");
  const output = path.join(root, "outputs");
  const sha = execFileSync("git", ["rev-parse", "origin/master"], { encoding: "utf8" }).trim();
  await writeFile(
    loader,
    `
    import cp from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    const original = cp.execFileSync;
    cp.execFileSync = (file, args, options) => file === "git" && args[0] === "rev-parse" && args[1].startsWith("v") ? process.env.RELEASE_SHA + "\\n" : original(file, args, options);
    syncBuiltinESMExports();
    globalThis.fetch = async (input, options) => {
      if (options?.method && options.method !== "GET") throw Error("UNEXPECTED_WRITE");
      const url = String(input), mode = process.env.PLANNING_FIXTURE, sha = process.env.RELEASE_SHA;
      if (url.includes("/actions/workflows/ci.yml/runs?")) return Response.json({ workflow_runs: [{ id: 1, head_sha: sha, head_branch: "master", event: "push", status: "completed", conclusion: "success" }] });
      if (url.includes("/actions/runs/1/jobs?")) return Response.json({ total_count: 1, jobs: [{ name: "CI Gate · 合并检查", conclusion: "success" }] });
      if (url.endsWith("/actions/runs/1")) return Response.json({ run_attempt: 2 });
      if (url.includes("/actions/runs/1/artifacts?")) {
        const artifacts = mode === "missing" ? [] : [{ id: 11, name: "ci-web-2", expired: false }, { id: 12, name: "ci-windows-2", expired: mode === "expired" }];
        return Response.json({ total_count: artifacts.length, artifacts });
      }
      if (url.endsWith("/actions/runs/9")) return Response.json({ head_branch: "master", event: "workflow_dispatch", path: ".github/workflows/release.yml", status: "completed" });
      if (url.endsWith("/api/health")) return Response.json({ service: "TaskRelay", protocolVersion: 19, sourceCommit: sha });
      if (url.endsWith("/releases/latest")) return Response.json({ tag_name: "v0.1.0" });
      if (url.includes("/releases/tags/")) return new Response(null, { status: 404 });
      throw Error("UNEXPECTED_NETWORK:" + url);
    };
  `,
  );
  for (const mode of ["present", "missing", "expired", "resume"]) {
    await writeFile(output, "");
    const result = await exec(
      process.execPath,
      ["--import", pathToFileURL(loader).href, "scripts/release-preflight.mjs"],
      {
        env: {
          ...process.env,
          PLANNING_FIXTURE: mode,
          GITHUB_REF: "refs/heads/master",
          GITHUB_RUN_ID: "10",
          RELEASE_SHA: sha,
          RELEASE_SCOPE: "all",
          RELEASE_MODE: mode === "resume" ? "resume" : "publish",
          RECOVERY_RUN: "9",
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: output,
          GH_TOKEN: "fixture",
        },
      },
    );
    const plan = JSON.parse(result.stdout.trim());
    assert.equal(plan.buildWeb, mode === "missing");
    assert.equal(plan.buildWindows, ["missing", "expired"].includes(mode));
    assert.equal(plan.artifactRunId, mode === "resume" ? "9" : "10");
    assert.equal(plan.webArtifactId, ["present", "expired"].includes(mode) ? "11" : "");
    if (mode === "resume") assert.equal(plan.cloud || plan.desktop, false);
    assert.match(await readFile(output, "utf8"), /发布提交/);
  }
});

test("恢复预检真实入口按 D1 阶段下载原附件，等待设备无需附件", async (t) => {
  const root = await workspaceFixture(t, "scope");
  const output = path.join(root, "recovery-output");
  for (const mode of [
    "resume-ready",
    "resume-bundle-ready",
    "resume-published",
    "resume-bundle-published",
  ]) {
    await writeFile(output, "");
    await exec(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./tests/release-production-fixture.mjs",
        "scripts/release-recovery.mjs",
      ],
      {
        env: {
          ...process.env,
          RELEASE_FIXTURE: mode,
          RELEASE_SHA: "a".repeat(40),
          GITHUB_RUN_ID: "11",
          ARTIFACT_RUN_ID: "11",
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: output,
          CLOUDFLARE_API_TOKEN: "fixture",
          GH_TOKEN: "fixture",
        },
      },
    );
    const text = await readFile(output, "utf8");
    assert.match(text, /恢复阶段/);
    if (mode.includes("ready")) assert.match(text, /bundleId=\nlegacyWebId=\nlegacyWindowsId=\n/);
    else if (mode.includes("bundle")) assert.match(text, /bundleId=90/);
    else assert.match(text, /legacyWindowsId=92/);
  }
});
