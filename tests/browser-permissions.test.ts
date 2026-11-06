import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { grantBrowserReadAccess } from "../apps/desktop/src/main/browser-permissions";

test("浏览器权限只授予程序目录读取执行，拒绝路径越界和链接，失败阻止启动", async (t) => {
  // 托管 Windows 的 TEMP 使用 RUNNER~1 短路径；夹具先解析系统临时根，
  // 再把真实路径交给生产入口，避免把合法别名当作本测试要拒绝的重解析路径。
  const temporary = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(temporary, "relay-browser-acl-"));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(temporary + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  const root = path.join(directory, "browser", "chrome-win64");
  const privateData = path.join(directory, "profile");
  await mkdir(root, { recursive: true });
  await mkdir(privateData);
  await writeFile(path.join(root, "chrome.exe"), "public executable fixture");
  await writeFile(path.join(privateData, "secret"), "private fixture");
  let calls = 0,
    fail = false;
  t.mock.method(
    childProcess,
    "execFile",
    (
      _file: string,
      args: string[],
      options: childProcess.ExecFileOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      calls++;
      assert.equal(_file, "icacls.exe");
      assert.deepEqual(args, [root, "/grant", "*S-1-15-2-2:(OI)(CI)(RX)", "/T", "/Q"]);
      assert.equal(options.windowsHide, true);
      callback(fail ? Error("private native error") : null, "", "");
    },
  );
  await grantBrowserReadAccess(root);
  fail = true;
  await assert.rejects(grantBrowserReadAccess(root), {
    message: "BROWSER_RESOURCE_PERMISSION_FAILED",
  });
  await assert.rejects(grantBrowserReadAccess(privateData), /BROWSER_RESOURCE_PATH_INVALID/);
  await symlink(
    privateData,
    path.join(root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(grantBrowserReadAccess(root), /BROWSER_RESOURCE_LINK_REJECTED/);
  assert.equal(calls, 2);
  assert.equal(await readFile(path.join(privateData, "secret"), "utf8"), "private fixture");
});
