import { mkdir, writeFile, cp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { applyCdpPolicy } from "./cdp-policy.mjs";
const root = path.resolve(import.meta.dirname, ".."),
  staging = path.join(root, ".cache/runtime");
const lock = path.join(root, "scripts/runtime-package-lock.json");
const updateLock = process.argv.includes("--update-lock");
await mkdir(staging, { recursive: true });
const app = JSON.parse(await readFile(path.join(root, "apps/desktop/package.json"), "utf8"));
const repository = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
await writeFile(
  path.join(staging, "package.json"),
  JSON.stringify({
    name: "taskrelay-runtime",
    version: app.version,
    private: true,
    dependencies: app.dependencies,
    overrides: repository.overrides,
  }),
);
const npmCli = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
// 构建只消费已审查的生产锁文件；更新依赖时显式重新解析，避免每次打包漂移。
if (!updateLock) await cp(lock, path.join(staging, "package-lock.json"));
await promisify(execFile)(
  process.execPath,
  [
    npmCli,
    updateLock ? "install" : "ci",
    "--omit=dev",
    "--ignore-scripts",
    "--workspaces=false",
    "--no-audit",
    "--prefix",
    staging,
  ],
  { windowsHide: true, timeout: 180000 },
);
if (updateLock) await cp(path.join(staging, "package-lock.json"), lock);
await applyCdpPolicy(path.join(staging, "node_modules"));
const destination = path.resolve(root, "apps/desktop/node_modules");
if (destination !== path.join(root, "apps", "desktop", "node_modules"))
  throw Error("RUNTIME_STAGING_PATH_INVALID");
await rm(destination, { recursive: true, force: true });
await cp(path.join(staging, "node_modules"), destination, { recursive: true });
console.log("External ESM runtime dependencies staged.");
