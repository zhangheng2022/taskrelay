import { spawn, execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, ".."),
  output = path.resolve(
    process.argv[3] ?? path.join(root, "out/packaged-smoke.json"),
  );
await mkdir(path.dirname(output), { recursive: true });
const executable =
  process.argv[2] ??
  path.join(root, "apps/desktop/out/TaskRelay-win32-x64/TaskRelay.exe");
const started = Date.now();
const child = spawn(
  executable,
  [
    "--taskrelay-smoke",
    output,
    `--user-data-dir=${path.join(path.dirname(output), "smoke-electron")}`,
  ],
  {
    windowsHide: true,
    stdio: "ignore",
  },
);
const timeout = setTimeout(() => {
  if (child.exitCode === null && child.pid)
    execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    });
}, 90000);
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
clearTimeout(timeout);
if ((await stat(output)).mtimeMs < started)
  throw new Error("SMOKE_DID_NOT_WRITE_FRESH_RESULT");
const report = JSON.parse(await readFile(output, "utf8"));
console.log(JSON.stringify(report, null, 2));
if (code !== 0 || report.passed !== true) process.exitCode = 1;
