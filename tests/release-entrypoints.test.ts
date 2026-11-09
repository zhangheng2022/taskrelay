import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
test("真实发布脚本在非主分支或健康异常时阻止所有生产写入", async (t) => {
  const prefix = path.join(tmpdir(), "relay-release-entry-");
  const directory = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(prefix));
    await rm(directory, { recursive: true, force: true });
  });
  const sha = execFileSync("git", ["rev-parse", "origin/master"], { encoding: "utf8" }).trim();
  const loader = path.join(directory, "network-fixture.mjs");
  // 子进程入口全部网络由此夹具封闭；意外请求直接失败，绝不接触真实部署令牌或生产 API。
  await writeFile(
    loader,
    `
    globalThis.fetch = async (input, options) => {
      const url = String(input);
      if (options?.method && options.method !== "GET") throw Error("UNEXPECTED_WRITE");
      if (url.startsWith("https://api.github.com/repos/zhangheng2022/taskrelay/actions/workflows/ci.yml/runs?"))
        return Response.json({workflow_runs:[{id:1,head_sha:process.env.RELEASE_SHA,head_branch:"master",event:"push",status:"completed",conclusion:"success"}]});
      if (url === "https://api.github.com/repos/zhangheng2022/taskrelay/actions/runs/1/jobs?filter=latest&per_page=100")
        return Response.json({total_count:1,jobs:[{name:"CI Gate · 合并检查",conclusion:"success"}]});
      if (url === "https://taskrelay.zhangheng.workers.dev/api/health")
        return new Response("fixture upstream private body", {status:503});
      throw Error("UNEXPECTED_NETWORK");
    };
  `,
  );
  for (const [entry, ref, expected] of [
    ["release-production.mjs", "refs/heads/feature", "PRODUCTION_ACTIONS_ONLY"],
    ["release-preflight.mjs", "refs/heads/master", "PRODUCTION_HEALTH_UNAVAILABLE:503"],
  ]) {
    await assert.rejects(
      exec(process.execPath, ["--import", pathToFileURL(loader).href, `scripts/${entry}`], {
        env: {
          ...process.env,
          RELEASE_SHA: sha,
          GITHUB_REF: ref,
          GITHUB_ACTIONS: "true",
          GH_TOKEN: "fixture-only",
          CLOUDFLARE_API_TOKEN: "",
          RELEASE_MODE: "publish",
        },
        windowsHide: true,
      }),
      (error: ExecFileException & { stderr: string }) => {
        assert.ok(error.stderr.includes(expected), error.stderr);
        assert.equal(error.stderr.includes("fixture upstream private body"), false);
        assert.equal(error.stderr.includes("UNEXPECTED_"), false);
        return true;
      },
    );
  }
});

test("真实生产发布入口核对 SQL、安装包和恢复结果，异常保留暂停与恢复点", async (t) => {
  const summaryPrefix = path.join(tmpdir(), "relay-release-summary-");
  const summaryDirectory = await mkdtemp(summaryPrefix);
  t.after(async () => {
    assert.ok(path.resolve(summaryDirectory).startsWith(summaryPrefix));
    await rm(summaryDirectory, { recursive: true, force: true });
  });
  const migrationCount = (await readdir("apps/cloud/migrations")).filter((name) =>
    name.endsWith(".sql"),
  ).length;
  const cases: Record<string, { phase?: string; error?: string }> = {
    success: { phase: "complete" },
    "deploy-fails": { phase: "deploying", error: "FIXTURE_DEPLOY_FAILED" },
    desktop: { phase: "complete" },
    "bad-download": { phase: "registered", error: "CLOUDFLARE_DOWNLOAD_HASH_MISMATCH" },
    "no-device": { phase: "complete" },
    "original-paused": { phase: "complete" },
    "resume-published": { phase: "complete" },
    "resume-bundle-published": { phase: "complete" },
    "resume-bundle-ready": { phase: "complete" },
    "resume-bundle-changed": { phase: "publishing", error: "RESUME_PLAN_CHANGED" },
    "resume-unknown": { phase: "deploying", error: "DEPLOYMENT_OUTCOME_UNCONFIRMED" },
    "resume-ready": { phase: "complete" },
    "wrong-manifest": { error: "ARTIFACT_ACCEPTANCE_MISMATCH" },
    duplicate: { phase: "deploying", error: "RELEASE_RECOVERY_REQUIRED" },
    "bad-artifact": { error: "RELEASE_SIGNATURE_INVALID" },
    "bad-smoke": { error: "ARTIFACT_ACCEPTANCE_MISMATCH" },
    "resume-active": { phase: "deploying", error: "PREVIOUS_RELEASE_STILL_RUNNING" },
    "resume-artifact-changed": { phase: "publishing", error: "RESUME_ARTIFACT_CHANGED" },
  };
  for (const [mode, expected] of Object.entries(cases)) {
    let stdout: string;
    try {
      const result = await exec(
        process.execPath,
        [
          "--import",
          "tsx",
          "--import",
          "./tests/release-production-fixture.mjs",
          "scripts/release-production.mjs",
        ],
        {
          env: {
            ...process.env,
            RELEASE_FIXTURE: mode,
            RELEASE_SHA: "a".repeat(40),
            GITHUB_REF: "refs/heads/master",
            GITHUB_ACTIONS: "true",
            GITHUB_RUN_ID: "11",
            ARTIFACT_RUN_ID: "11",
            GH_TOKEN: "fixture-only",
            CLOUDFLARE_API_TOKEN: "fixture-only",
            RELEASE_MODE: "publish",
            RELEASE_CLOUD: "true",
            RELEASE_DESKTOP: "false",
            GITHUB_STEP_SUMMARY: path.join(summaryDirectory, `${mode}.md`),
          },
          windowsHide: true,
        },
      );
      assert.equal(expected.error, undefined, mode);
      stdout = result.stdout;
    } catch (error) {
      const failed = error as ExecFileException & { stderr: string; stdout: string };
      assert.ok(expected.error, `${mode}: ${failed.stderr}`);
      assert.ok(failed.stderr.includes(expected.error), failed.stderr);
      stdout = failed.stdout;
    }
    const output = JSON.parse(
      stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith("RELEASE_FIXTURE_RESULT="))!
        .slice("RELEASE_FIXTURE_RESULT=".length),
    );
    if (!expected.phase) {
      assert.deepEqual(output.commands, []);
      assert.equal(output.state.productionRelease, undefined);
      assert.equal(output.state.claimsEnabled, "1");
      assert.equal(output.state.maintenance, "0");
      assert.equal(output.migrations, migrationCount);
      continue;
    }
    assert.deepEqual(
      output.commands,
      mode.startsWith("resume-") || mode === "duplicate" ? [] : ["migrate", "deploy"],
    );
    assert.equal(output.migrations, migrationCount);
    const state = JSON.parse(output.state.productionRelease);
    const success = expected.phase === "complete";
    assert.equal(state.phase, expected.phase);
    if (success || ["deploy-fails", "bad-download", "resume-unknown"].includes(mode)) {
      const summary = await readFile(path.join(summaryDirectory, `${mode}.md`), "utf8");
      assert.ok(summary.includes(`source-sha=${"a".repeat(40)}`));
      assert.ok(summary.includes("recovery-run=11"));
      assert.equal(summary.includes("生产发布：已完成（complete）"), success);
      assert.equal(summary.includes("等待兼容设备"), false);
    }
    assert.equal(state.bookmark, "fixture-bookmark");
    assert.equal(output.state.claimsEnabled, success && mode !== "original-paused" ? "1" : "0");
    assert.equal(output.state.maintenance, success && mode !== "original-paused" ? "0" : "1");
    if (["desktop", "no-device", "bad-download", "resume-published"].includes(mode))
      assert.equal(
        JSON.parse(output.state.desktopReleaseCatalog).latest,
        mode === "bad-download" ? "0.4.10" : "0.17.1",
      );
  }
});
