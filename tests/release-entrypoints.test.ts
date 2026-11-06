import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
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
        return Response.json({total_count:1,jobs:[{name:"quality-gate",conclusion:"success"}]});
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

test("真实生产发布入口按 SQL 状态推进，部署失败保留暂停和恢复点", async () => {
  for (const mode of ["success", "deploy-fails"]) {
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
            GITHUB_STEP_SUMMARY: "",
          },
          windowsHide: true,
        },
      );
      assert.equal(mode, "success");
      stdout = result.stdout;
    } catch (error) {
      assert.equal(mode, "deploy-fails");
      const failed = error as ExecFileException & { stderr: string; stdout: string };
      assert.ok(failed.stderr.includes("FIXTURE_DEPLOY_FAILED"), failed.stderr);
      stdout = failed.stdout;
    }
    const output = JSON.parse(
      stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith("RELEASE_FIXTURE_RESULT="))!
        .slice("RELEASE_FIXTURE_RESULT=".length),
    );
    assert.deepEqual(output.commands, ["migrate", "deploy"]);
    assert.equal(output.migrations, 28);
    const state = JSON.parse(output.state.productionRelease);
    assert.equal(state.phase, mode === "success" ? "complete" : "deploying");
    assert.equal(state.bookmark, "fixture-bookmark");
    assert.equal(output.state.claimsEnabled, mode === "success" ? "1" : "0");
    assert.equal(output.state.maintenance, mode === "success" ? "0" : "1");
  }
});
