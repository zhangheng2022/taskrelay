import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const config: ForgeConfig = {
  packagerConfig: {
    // Keep checksum validation, using the manifest shipped with this installed Electron version.
    download: { checksums: require("electron/checksums.json") },
    name: "TaskRelay",
    executableName: "TaskRelay",
    icon: path.join(root, "resources/icon.ico"),
    // sharp loads its platform addon and companion DLLs from the same directory.
    asar: { unpack: "**/node_modules/@img/**/*" },
    prune: false,
    extraResource: [
      "browser",
      "stagehand-extension",
      "icon.png",
      "NOTICE.txt",
    ].map((p) => path.join(root, "resources", p)),
    ignore: (file) =>
      file.startsWith("/node_modules/.vite") ||
      (!!file &&
        !file.startsWith("/.vite") &&
        !file.startsWith("/node_modules") &&
        file !== "/package.json"),
  },
  hooks: {
    prePackage: async () => {
      await promisify(execFile)(
        process.execPath,
        [path.join(root, "scripts/stage-runtime.mjs")],
        { cwd: root, windowsHide: true, timeout: 180000 },
      );
      await promisify(execFile)(
        process.execPath,
        [path.join(root, "scripts/verify-browser.mjs")],
        { cwd: root, windowsHide: true, timeout: 180000 },
      );
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
