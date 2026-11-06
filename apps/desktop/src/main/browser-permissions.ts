import childProcess from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

/** 为 Chromium 的 LPAC 子进程补齐公开程序资源的读取/执行权限。
 * 仅接受自有 browser/chrome-win64，拒绝重解析路径；不触碰 Profile、父目录或用户数据。
 * 安装与 ZIP 解压不保证保留 ACL，Main 在首次启动前调用，失败时不启动浏览器。 */
export async function grantBrowserReadAccess(directory: string): Promise<void> {
  const root = path.resolve(directory);
  if (
    path.basename(root) !== "chrome-win64" ||
    path.basename(path.dirname(root)) !== "browser" ||
    (await realpath(root)).toLowerCase() !== root.toLowerCase()
  )
    throw Error("BROWSER_RESOURCE_PATH_INVALID");
  const validate = async (item: string): Promise<void> => {
    const info = await lstat(item);
    if (info.isSymbolicLink()) throw Error("BROWSER_RESOURCE_LINK_REJECTED");
    if (info.isDirectory())
      for (const name of await readdir(item)) await validate(path.join(item, name));
    else if (!info.isFile()) throw Error("BROWSER_RESOURCE_TYPE_INVALID");
  };
  await validate(root);
  if (!(await lstat(path.join(root, "chrome.exe"))).isFile())
    throw Error("BROWSER_EXECUTABLE_MISSING");
  await new Promise<void>((resolve, reject) => {
    childProcess.execFile(
      "icacls.exe",
      [root, "/grant", "*S-1-15-2-2:(OI)(CI)(RX)", "/T", "/Q"],
      { windowsHide: true, timeout: 15_000 },
      (error) => (error ? reject(Error("BROWSER_RESOURCE_PERMISSION_FAILED")) : resolve()),
    );
  });
}
