import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { copyFile } from "node:fs/promises";
import { downloadBrowserArchive } from "../../scripts/browser-download.mjs";
const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const electronChecksums = require("electron/checksums.json") as Record<string, string>;
const config: ForgeConfig = {
  packagerConfig: {
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
