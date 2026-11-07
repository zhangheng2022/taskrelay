import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "../packages/contracts/src/index";
import { workspaceFixture } from "./workspace-fixture";

const exec = promisify(execFile);
test("CDP 策略可幂等应用和升级已有边界补丁，未知源码拒绝改写", async (t) => {
  const prefix = path.join(os.tmpdir(), "taskrelay-cdp-policy-");
  const directory = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(prefix));
    await rm(directory, { recursive: true, force: true });
  });
  const module = path.join(directory, "chrome-remote-interface");
  await mkdir(path.join(module, "lib"), { recursive: true });
  await copyFile(
    new URL("../node_modules/chrome-remote-interface/package.json", import.meta.url),
    path.join(module, "package.json"),
  );
  const target = path.join(module, "lib/chrome.js");
  const patched = await readFile(
    new URL("../node_modules/chrome-remote-interface/lib/chrome.js", import.meta.url),
    "utf8",
  );
  await writeFile(target, patched);
  const run = () =>
    exec(process.execPath, [
      "--input-type=module",
      "-e",
      "const {applyCdpPolicy}=await import(process.argv[1]);await applyCdpPolicy(process.argv[2]);",
      "--",
      new URL("../scripts/cdp-policy.mjs", import.meta.url).href,
      directory,
    ]);
  await run();
  assert.equal(await readFile(target, "utf8"), patched);
  const legacy = patched.replace(
    "followRedirects: false,\n                    handshakeTimeout: 4000,\n                    closeTimeout: 1000,",
    "followRedirects: true,",
  );
  assert.notEqual(legacy, patched);
  await writeFile(target, legacy);
  await run();
  assert.equal(await readFile(target, "utf8"), patched);
  await writeFile(target, patched + "\n// unexpected upstream change\n");
  await assert.rejects(run(), /CDP_POLICY_REVIEW_REQUIRED/);
  assert.equal(await readFile(target, "utf8"), patched + "\n// unexpected upstream change\n");
});
test("安装验收范围识别独立浏览器测试改动，纯文档可跳过", async (t) => {
  const directory = await workspaceFixture(t, "scope");
  const git = (...args: string[]) => exec("git", args, { cwd: directory });
  await git("init");
  await git("config", "user.name", "Scope Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(directory, "README.md"), "# 初始\n");
  await git("add", ".");
  await git("commit", "-m", "初始");
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  const run = async (baseSha = base) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          [fileURLToPath(new URL("../scripts/change-scope.mjs", import.meta.url))],
          {
            cwd: directory,
            env: { ...process.env, BASE_SHA: baseSha, GITHUB_OUTPUT: "" },
          },
        )
      ).stdout,
    );
  await writeFile(path.join(directory, "README.md"), "# 文档修改\n");
  await git("commit", "-am", "文档");
  assert.equal((await run()).desktop, false);
  await mkdir(path.join(directory, "tests"));
  await writeFile(path.join(directory, "tests/browser-state-desktop.test.ts"), "// 生命周期验收\n");
  await git("add", ".");
  await git("commit", "-m", "浏览器测试");
  assert.equal((await run()).desktop, true);
  assert.equal((await run("")).desktop, true);
});
test("本地初始化排他创建密钥，已有配置及并发初始化都不覆盖", async (t) => {
  const prefix = path.join(os.tmpdir(), "taskrelay-setup-");
  const directory = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(prefix));
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, "scripts"));
  await mkdir(path.join(directory, "apps/web"), { recursive: true });
  const script = path.join(directory, "scripts/setup-local.mjs");
  const target = path.join(directory, "apps/web/.dev.vars");
  await copyFile(new URL("../scripts/setup-local.mjs", import.meta.url), script);
  await writeFile(target, "MASTER_KEY=fixture-existing\nDEV_MODE=1\n");
  await exec(process.execPath, [script]);
  assert.equal(await readFile(target, "utf8"), "MASTER_KEY=fixture-existing\nDEV_MODE=1\n");
  await rm(target);
  await Promise.all([exec(process.execPath, [script]), exec(process.execPath, [script])]);
  const created = await readFile(target, "utf8");
  assert.match(created, /^MASTER_KEY=[A-Za-z0-9+/]{43}=\nDEV_MODE=1\n$/);
  await exec(process.execPath, [script]);
  assert.equal(await readFile(target, "utf8"), created);
});

test("部署自检使用当前协议并精确判断目标和 Access 域名", async () => {
  const script = new URL("../scripts/cloud-self-check.mjs", import.meta.url).href;
  const fixture = `
    const mode = process.argv[2];
    globalThis.fetch = async (input, init) => {
      if (init.redirect !== "manual") throw Error("REDIRECT_POLICY_LOST");
      if (mode === "access" || mode === "spoof") return new Response(null, {
        status: 302, headers: { location: mode === "access"
          ? "https://zhangheng.cloudflareaccess.com/login"
          : "https://zhangheng.cloudflareaccess.com.attacker.example/login" },
      });
      const path = new URL(input).pathname;
      if (path === "/api/health") return Response.json({protocolVersion: ${PROTOCOL_VERSION}});
      return Response.json({}, {status: init.headers.Authorization || path === "/api/device/user/snapshot" ? 403 : 401});
    };
    await import(process.argv[1]);
  `;
  const run = (mode: string, origin = "https://tr.zhangheng.eu.org") =>
    exec(process.execPath, [
      "--input-type=module",
      "-e",
      fixture,
      "--",
      script,
      mode,
      `--origin=${origin}`,
    ]);
  assert.match((await run("normal")).stdout, /"complete":true/);
  assert.match((await run("access")).stdout, /"complete":false/);
  await assert.rejects(run("spoof"), /CHECK_FAILED/);
  await assert.rejects(
    run("normal", "https://tr.zhangheng.eu.org.attacker.example"),
    /DIAGNOSTIC_ORIGIN_NOT_ALLOWED/,
  );
});
