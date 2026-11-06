/** 精选桌面生产依赖锁同样审计，禁止只审根 workspace 而遗漏实际安装包依赖。 */
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
const directory = path.resolve(".cache/runtime-audit");
mkdirSync(directory, { recursive: true });
const lock = JSON.parse(readFileSync("scripts/runtime-package-lock.json", "utf8"));
copyFileSync("scripts/runtime-package-lock.json", path.join(directory, "package-lock.json"));
writeFileSync(
  path.join(directory, "package.json"),
  JSON.stringify({
    name: lock.name,
    version: lock.version,
    dependencies: lock.packages[""].dependencies,
  }),
);
const npm =
  process.env.npm_execpath ??
  (process.platform === "win32"
    ? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
    : null);
const result = spawnSync(
  npm ? process.execPath : "npm",
  [...(npm ? [npm] : []), "audit", "--audit-level=high", "--prefix", directory],
  { stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
