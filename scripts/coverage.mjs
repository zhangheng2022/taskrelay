/** Ubuntu 是覆盖率门槛平台。c8 --all 包含未加载业务文件；纯类型模块由实际转译为空确认后排除。 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { transformSync } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
process.chdir(root);
const sources = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "apps", "packages", "scripts"],
  { encoding: "utf8" },
)
  .trim()
  .split(/\r?\n/)
  .filter(
    (file) =>
      /\.(?:[cm]?ts|tsx|[cm]?js)$/.test(file) &&
      !/\.d\.[cm]?ts$/.test(file) &&
      !/(node_modules|\/out\/|\/dist\/|\/\.vite\/)/.test(file),
  );
const pureTypes = sources.filter(
  (file) =>
    /\.tsx?$/.test(file) &&
    !transformSync(readFileSync(file, "utf8"), {
      loader: file.endsWith("tsx") ? "tsx" : "ts",
    }).code.trim(),
);
mkdirSync(".cache", { recursive: true });
const config = {
  all: true,
  extension: [".ts", ".tsx", ".mts", ".js", ".mjs"],
  include: ["apps/*/src/**", "packages/*/src/**", "scripts/**"],
  exclude: ["**/node_modules/**", "**/*.d.ts", "**/*.d.mts", "**/*.d.cts", ...pureTypes],
  reporter: ["text", "html", "lcov", "json-summary"],
  reportsDirectory: "coverage",
};
writeFileSync(".cache/c8-config.json", JSON.stringify(config));
const tests = readdirSync("tests")
  .filter((file) => /\.test\.tsx?$/.test(file))
  .map((file) => `tests/${file}`);
const result = spawnSync(
  process.execPath,
  [
    "node_modules/c8/bin/c8.js",
    "--config",
    ".cache/c8-config.json",
    process.execPath,
    "--import",
    "tsx",
    "--test",
    ...tests,
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
const checked = spawnSync(process.execPath, ["scripts/check-coverage.mjs"], {
  stdio: "inherit",
  env: process.env,
});
process.exitCode = checked.status ?? 1;
