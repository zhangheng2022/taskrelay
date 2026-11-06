import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PROTOCOL_VERSION } from "../packages/contracts/src/index";

const exec = promisify(execFile);
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
