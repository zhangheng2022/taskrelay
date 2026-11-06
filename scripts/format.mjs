/** 仅格式化仓库跟踪文件和新加入的源码；第三方技能、锁文件与产物由 ignore 排除。 */
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const mode = process.argv.includes("--write") ? "--write" : "--check";
for (let start = 0; start < files.length; start += 80) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/prettier/bin/prettier.cjs"),
      mode,
      "--ignore-unknown",
      ...files.slice(start, start + 80),
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
