import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, rmdir } from "node:fs/promises";
import { downloadBrowserArchive } from "../../scripts/browser-download.mjs";
const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const electronChecksums = require("electron/checksums.json") as Record<string, string>;
// 两阶段复用固定 hook；私钥不进入 Forge 配置、Squirrel 参数或日志。
const windowsSign = process.env.TASKRELAY_SIGNING_DIRECTORY
  ? { hookModulePath: path.join(root, "scripts/windows-sign-hook.mjs") }
  : undefined;
if (process.env.TASKRELAY_RELEASE_SIGNING === "true" && !windowsSign)
  throw Error("RELEASE_SIGNING_REQUIRED");
let signingTemporaryDirectory: string | undefined;
const previousSquirrelTemp = process.env.SQUIRREL_TEMP;
const config: ForgeConfig = {
  packagerConfig: {
    windowsSign,
    // Keep checksum validation, using the manifest shipped with this installed Electron version.
    download: {
      checksums: electronChecksums,
      // 系统 curl 与浏览器下载共用分段缓存，绕开当前主机 Node 下载链路停滞；
      // 先按安装依赖的清单校验整体，再交给 @electron/get 再次校验，不能禁用 checksum。
      downloader: {
        download: async (url, target) => {
          const filename = path.basename(target),
            sha256 = electronChecksums[filename];
          if (!sha256) throw Error("ELECTRON_ARCHIVE_CHECKSUM_MISSING");
          const archive = path.join(root, ".cache", filename);
          await downloadBrowserArchive({ url, archive, sha256 });
          await copyFile(archive, target);
        },
      },
    },
    name: "TaskRelay",
    executableName: "TaskRelay",
    icon: path.join(root, "resources/icon.ico"),
    // sharp loads its platform addon and companion DLLs from the same directory.
    asar: { unpack: "**/node_modules/@img/**/*" },
    prune: false,
    extraResource: ["browser", "stagehand-extension", "icon.png", "NOTICE.txt"].map((p) =>
      path.join(root, "resources", p),
    ),
    ignore: (file) =>
      file.startsWith("/node_modules/.vite") ||
      (!!file &&
        !file.startsWith("/.vite") &&
        !file.startsWith("/node_modules") &&
        file !== "/package.json"),
  },
  hooks: {
    preMake: async () => {
      if (!windowsSign) return;
      // MSIX 宿主的 AppData 重定向可能让 Squirrel 与签名进程看到不同副本；
      // 使用仓库外层的真实缓存路径，使打包和签名操作同一文件。
      await mkdir(path.join(root, ".cache"), { recursive: true });
      signingTemporaryDirectory = await mkdtemp(path.join(root, ".cache/squirrel-signing-"));
      process.env.SQUIRREL_TEMP = signingTemporaryDirectory;
    },
    postMake: async (_config, results) => {
      if (signingTemporaryDirectory) {
        // Squirrel 已回收子目录，只移除本次创建的空目录；失败时保留忽略目录供排查。
        await rmdir(signingTemporaryDirectory);
        if (previousSquirrelTemp === undefined) delete process.env.SQUIRREL_TEMP;
        else process.env.SQUIRREL_TEMP = previousSquirrelTemp;
      }
      return results;
    },
    prePackage: async () => {
      await promisify(execFile)(process.execPath, [path.join(root, "scripts/stage-runtime.mjs")], {
        cwd: root,
        windowsHide: true,
        timeout: 180000,
      });
      await promisify(execFile)(process.execPath, [path.join(root, "scripts/verify-browser.mjs")], {
        cwd: root,
        windowsHide: true,
        timeout: 180000,
      });
    },
  },
  makers: [
    new MakerSquirrel({
      windowsSign,
      noMsi: true,
      name: "TaskRelay",
      setupExe: "TaskRelay Setup.exe",
      setupIcon: path.join(root, "resources/icon.ico"),
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main/index.ts",
          config: "vite.main.config.mts",
          target: "main",
        },
        {
          entry: "src/preload/index.ts",
          config: "vite.preload.config.mts",
          target: "preload",
        },
        {
          entry: "src/executor/entry.ts",
          config: "vite.executor.config.mts",
          target: "main",
        },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.mts" }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
export default config;
