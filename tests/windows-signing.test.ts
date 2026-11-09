import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { validateSigning } from "../scripts/signing-policy.mjs";
import signFile, { shouldSign } from "../scripts/windows-sign-hook.mjs";
import { verifyFiles, fileTree, verifyBundle, sha256 } from "../scripts/release-artifacts.mjs";
import { signedFixture } from "./signing-fixture.mjs";
import { workspaceFixture } from "./workspace-fixture";

test("签名只覆盖产品入口，不重签浏览器与原生依赖", () => {
  for (const name of [
    "TaskRelay.exe",
    "TaskRelay_ExecutionStub.exe",
    "Update.exe",
    "Squirrel.exe",
    "Setup.exe",
    "TaskRelay Setup.exe",
  ])
    assert.equal(shouldSign(`C:\\build\\${name}`), true, name);
  for (const name of [
    "resources/browser/TaskRelay.exe",
    "resources/app.asar.unpacked/node_modules/Update.exe",
    "chrome.exe",
    "lib.dll",
    "addon.node",
    "Setup.msi",
  ])
    assert.equal(shouldSign(`C:/build/${name}`), false, name);
});

test("Forge 签名入口拒绝缺失证书，隔离子进程输出并传播签名失败", (t) => {
  const previous = process.env.TASKRELAY_SIGNING_DIRECTORY;
  const calls: unknown[][] = [];
  let fail = false;
  const mocked = t.mock.method(childProcess, "execFileSync", (...args: unknown[]) => {
    calls.push(args);
    if (fail) throw Error("private diagnostic must not escape");
    return Buffer.alloc(0);
  });
  syncBuiltinESMExports();
  try {
    delete process.env.TASKRELAY_SIGNING_DIRECTORY;
    signFile("resources/browser/TaskRelay.exe");
    assert.throws(() => signFile("TaskRelay.exe"), /SIGNING_CERTIFICATE_REQUIRED/);
    assert.equal(calls.length, 0);
    process.env.TASKRELAY_SIGNING_DIRECTORY = "isolated-test-state";
    const file = path.resolve("out/TaskRelay Setup.exe");
    signFile(file);
    const [command, args, options] = calls[0] as [string, string[], Record<string, unknown>];
    assert.equal(command, "pwsh");
    assert.equal(args.at(-1), file);
    assert.equal(args[args.indexOf("-Action") + 1], "Sign");
    assert.equal(options.stdio, "pipe");
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 120_000);
    fail = true;
    assert.throws(() => signFile(file), { message: "WINDOWS_SIGNING_FAILED" });
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.TASKRELAY_SIGNING_DIRECTORY;
    else process.env.TASKRELAY_SIGNING_DIRECTORY = previous;
  }
});

test("发布签名门槛拒绝未签名、测试证书、错证书、缺时间戳、过期证据和包内不一致", () => {
  const valid = signedFixture("0.19.6");
  validateSigning({ ...valid, version: "0.19.6" });
  const cases: ((m: typeof valid) => void)[] = [
    (m) => {
      m.signed = false;
    },
    (m) => {
      m.signing.testOnly = true;
    },
    (m) => {
      m.signing.certificateSha256 = "c".repeat(64);
    },
    (m) => {
      m.signing.files[0].timestamped = false;
    },
    (m) => {
      m.signing.files[0].trusted = false;
    },
    (m) => {
      m.signing.files[0].status = "HashMismatch";
    },
    (m) => {
      m.signing.notAfter = m.signing.checkedAt;
    },
    (m) => {
      m.signing.checkedAt = new Date(Date.now() - 7_200_000).toISOString();
    },
    (m) => {
      m.signing.files.pop();
    },
    (m) => {
      m.signing.files[2].sha256 = "c".repeat(64);
    },
    (m) => {
      m.signing.packageSha256 = "c".repeat(64);
    },
    (m) => {
      m.signing.files[0].certificateSha256 = "c".repeat(64);
    },
    (m) => {
      m.artifacts[1].sha256 = "c".repeat(64);
    },
  ];
  for (const mutate of cases) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.throws(() => validateSigning({ ...invalid, version: "0.19.6" }), /SIGNATURE_INVALID/);
  }
  valid.signing.testOnly = true;
  validateSigning({ ...valid, version: "0.19.6" }, { allowTest: true });
});

test("真实候选验证入口拒绝即使文件树匹配的未签名候选", async (t) => {
  const root = await workspaceFixture(t, "scope");
  await mkdir(path.join(root, "out"));
  await writeFile(path.join(root, "out/release-manifest.json"), JSON.stringify({ signed: false }));
  await writeFile(
    path.join(root, "artifact-manifest.json"),
    JSON.stringify({
      schema: 1,
      kind: "windows",
      sourceCommit: "a".repeat(40),
      repository: "zhangheng2022/taskrelay",
      runId: "1",
      runAttempt: "1",
      files: await fileTree(root),
    }),
  );
  await assert.rejects(verifyFiles("windows", root, "a".repeat(40)), /SIGNATURE_INVALID/);
});

test("旧未签名发布仅可持原固定清单恢复，新版本不得使用旧发布例外", async (t) => {
  const root = await workspaceFixture(t, "scope");
  const windows = path.join(root, "windows");
  await mkdir(path.join(windows, "out"), { recursive: true });
  const source = "a".repeat(40);
  for (const version of ["0.19.5", "0.19.6"]) {
    const report = { passed: true, version };
    const acceptance = {
      signed: false,
      version,
      sourceCommit: source,
      actionsRunId: "1",
      actionsRunAttempt: "1",
      sourceDirty: false,
      installedAsarMatches: true,
      systemEntry: { runner: "github-hosted" },
      reports: { "packaged-smoke": report, "installed-smoke": report },
    };
    await writeFile(path.join(windows, "out/release-manifest.json"), JSON.stringify(acceptance));
    for (const name of ["packaged-smoke", "installed-smoke"])
      await writeFile(path.join(windows, `out/${name}.json`), JSON.stringify(report));
    const manifest = {
      schema: 1,
      kind: "windows",
      version,
      sourceCommit: source,
      repository: "zhangheng2022/taskrelay",
      runId: "1",
      runAttempt: "1",
      files: await fileTree(windows),
    };
    await writeFile(path.join(windows, "artifact-manifest.json"), JSON.stringify(manifest));
    const plan = JSON.stringify({
      schema: 1,
      sha: source,
      sources: { windows: { manifestHash: sha256(JSON.stringify(manifest)) } },
    });
    await writeFile(path.join(root, "release-plan.json"), plan);
    await assert.rejects(verifyBundle(root, source, undefined, ["windows"]), /SIGNATURE_INVALID/);
    await assert.rejects(
      verifyBundle(root, source, "b".repeat(64), ["windows"]),
      /RESUME_PLAN_CHANGED/,
    );
    if (version === "0.19.5") await verifyBundle(root, source, sha256(plan), ["windows"]);
    else
      await assert.rejects(
        verifyBundle(root, source, sha256(plan), ["windows"]),
        /SIGNATURE_INVALID/,
      );
  }
});

test("Forge 签名制作使用同一真实缓存目录，正式构建缺证书时拒绝启动", () => {
  const source =
    'import config from "./apps/desktop/forge.config.mts"; import fs from "node:fs"; import assert from "node:assert/strict"; await config.hooks.preMake(); const temp=process.env.SQUIRREL_TEMP; assert.match(temp.replaceAll("\\\\","/"),/\\/.cache\\/squirrel-signing-/); assert.ok(fs.existsSync(temp)); const result=[]; assert.equal(await config.hooks.postMake({},result),result); assert.equal(fs.existsSync(temp),false);';
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    stdio: "pipe",
    env: {
      ...process.env,
      TASKRELAY_SIGNING_DIRECTORY: "fixture",
      TASKRELAY_RELEASE_SIGNING: "true",
    },
  });
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          'await import("./apps/desktop/forge.config.mts")',
        ],
        {
          stdio: "pipe",
          env: {
            ...process.env,
            TASKRELAY_SIGNING_DIRECTORY: "",
            TASKRELAY_RELEASE_SIGNING: "true",
          },
        },
      ),
    /RELEASE_SIGNING_REQUIRED/,
  );
});

test(
  "Windows 证书准备拒绝缺失秘密并清理临时文件；重复创建不覆盖备份",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await workspaceFixture(t, "scope");
    const script = path.resolve("scripts/signing-certificate.ps1");
    const state = path.join(root, "state");
    const run = (...args: string[]) =>
      execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, ...args], {
        encoding: "utf8",
        stdio: "pipe",
        env: {
          ...process.env,
          GITHUB_ENV: "",
          TASKRELAY_RELEASE_SIGNING: "false",
          TASKRELAY_SIGNING_PFX_BASE64: "",
          TASKRELAY_SIGNING_PASSWORD: "",
        },
      });
    assert.throws(
      () => run("-Action", "Prepare", "-StateDirectory", state),
      /SIGNING_PREPARATION_FAILED/,
    );
    run("-Action", "Cleanup", "-StateDirectory", state);
    const backup = path.join(root, "backup");
    await mkdir(backup);
    await writeFile(path.join(backup, "existing"), "preserved");
    assert.throws(() => run("-Action", "Create", "-PrivateRoot", backup), /BACKUP_ALREADY_EXISTS/);
    assert.equal(await readFile(path.join(backup, "existing"), "utf8"), "preserved");
    // 用一次性备份验证真实 PFX 解密及固定公开证书匹配，不读取正式私钥。
    const temporaryBackup = path.join(root, "new-backup");
    run("-Action", "Create", "-PrivateRoot", temporaryBackup);
    const keyDirectory = path.join(temporaryBackup, (await readdir(temporaryBackup))[0]);
    const passwordFile = path.join(keyDirectory, "pfx-password.txt");
    const password = await readFile(passwordFile, "utf8");
    await writeFile(passwordFile, "incorrect-fixture-password");
    assert.throws(
      () =>
        run(
          "-Action",
          "Prepare",
          "-PfxDirectory",
          keyDirectory,
          "-PublicDirectory",
          keyDirectory,
          "-StateDirectory",
          state,
        ),
      /SIGNING_PREPARATION_FAILED/,
    );
    await writeFile(passwordFile, password);
    assert.throws(
      () => run("-Action", "Prepare", "-PfxDirectory", keyDirectory, "-StateDirectory", state),
      /SIGNING_PREPARATION_FAILED/,
    );
    try {
      run(
        "-Action",
        "Prepare",
        "-PfxDirectory",
        keyDirectory,
        "-PublicDirectory",
        keyDirectory,
        "-StateDirectory",
        state,
      );
    } finally {
      run("-Action", "Cleanup", "-StateDirectory", state);
    }
    // 缺少时间戳的原始 PE 不能作为已签名交付；不访问外部时间戳服务。
    try {
      run("-Action", "Prepare", "-TestCertificate", "-StateDirectory", state);
      const target = path.join(root, "TaskRelay.exe");
      await copyFile("node_modules/@electron/windows-sign/vendor/signtool.exe", target);
      const metadata = JSON.parse(
        await readFile(path.join(state, "certificate-info.json"), "utf8"),
      ) as { thumbprint: string };
      execFileSync(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$cert = Get-Item ('Cert:\\CurrentUser\\My\\' + $env:TEST_CERT_THUMBPRINT); Set-AuthenticodeSignature -LiteralPath $env:TEST_SIGN_FILE -Certificate $cert -HashAlgorithm SHA256 | Out-Null",
        ],
        {
          stdio: "pipe",
          env: {
            ...process.env,
            TEST_CERT_THUMBPRINT: metadata.thumbprint,
            TEST_SIGN_FILE: target,
          },
        },
      );
      assert.throws(() =>
        execFileSync(
          "pwsh",
          [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            path.resolve("scripts/windows-signature.ps1"),
            "-Action",
            "Inspect",
            "-File",
            target,
            "-SigningDirectory",
            state,
          ],
          { stdio: "pipe" },
        ),
      );
      run("-Action", "Seal", "-StateDirectory", state);
      assert.throws(() =>
        execFileSync(
          "pwsh",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "if (Test-Path ('Cert:\\CurrentUser\\My\\' + $env:TEST_CERT_THUMBPRINT)) { exit 0 } else { exit 1 }",
          ],
          { stdio: "pipe", env: { ...process.env, TEST_CERT_THUMBPRINT: metadata.thumbprint } },
        ),
      );
    } finally {
      run("-Action", "Cleanup", "-StateDirectory", state);
    }
  },
);
