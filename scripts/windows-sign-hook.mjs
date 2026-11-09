/** Forge 与 Squirrel 共用签名入口：只签产品入口，第三方资源保持原字节；私钥由临时用户证书库持有。 */
import path from "node:path";
import { execFileSync } from "node:child_process";

export function shouldSign(file) {
  // Squirrel 在临时目录重写 stub 和 Update.exe；文件名白名单与 resources 排除同时生效。
  const normalized = file.replaceAll("\\", "/");
  if (/(^|\/)resources\//i.test(normalized)) return false;
  return /^(TaskRelay(?:_ExecutionStub)?\.exe|(?:TaskRelay )?Setup\.exe|Update\.exe|Squirrel\.exe)$/i.test(
    path.win32.basename(file),
  );
}

export default function signFile(file) {
  if (!shouldSign(file)) return;
  if (!process.env.TASKRELAY_SIGNING_DIRECTORY) throw Error("SIGNING_CERTIFICATE_REQUIRED");
  try {
    execFileSync(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        path.join(import.meta.dirname, "windows-signature.ps1"),
        "-Action",
        "Sign",
        "-File",
        path.resolve(file),
      ],
      { windowsHide: true, stdio: "pipe", timeout: 120_000 },
    );
  } catch {
    throw Error("WINDOWS_SIGNING_FAILED");
  }
}
