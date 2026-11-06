import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const failures = [];
const desktop = JSON.parse(
  await readFile(path.join(root, "apps/desktop/package.json"), "utf8"),
);
const repository = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const runtimeLock = JSON.parse(await readFile(path.join(root, "scripts/runtime-package-lock.json"), "utf8"));
const runtimeDependencies = runtimeLock.packages[""].dependencies;
if (JSON.stringify(Object.entries(runtimeDependencies).sort()) !== JSON.stringify(Object.entries(desktop.dependencies).sort()))
  failures.push("Desktop runtime lock must be refreshed with node scripts/stage-runtime.mjs --update-lock");
// 同一个执行进程不能混用框架版本；版本由经过验收的清单决定，不在检查器内固定旧版。
for (const name of ["@browserbasehq/stagehand", "@langchain/core", "@langchain/langgraph", "@langchain/langgraph-checkpoint", "langchain", "p-limit"]) {
  const version = desktop.dependencies[name];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || version !== repository.dependencies[name])
    failures.push(`${name} must use the same exact release in root and desktop`);
}
for (const relative of [
  "apps/desktop/src/main/index.ts",
  "apps/desktop/src/preload/index.ts",
  "apps/desktop/src/executor/runtime.ts",
  "apps/cloud/src/index.ts",
  "packages/contracts/src/index.ts",
  "README.md",
  "docs/ACCEPTANCE.md",
])
  await stat(path.join(root, relative)).catch(() =>
    failures.push("Missing " + relative),
  );
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (
      ["node_modules", "dist", "out", ".vite", ".wrangler"].includes(entry.name)
    )
      continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (/\.(ts|tsx)$/.test(file)) {
      const source = await readFile(file, "utf8");
      if (
        /redirect:\s*['"]error['"]/.test(source) &&
        file.includes(path.join("apps", "cloud"))
      )
        failures.push(
          "Unsupported Workers redirect mode: " + path.relative(root, file),
        );
      if (
        /(?:apiKey|MASTER_KEY)\s*[:=]\s*['"][a-zA-Z0-9_-]{30,}['"]/.test(source)
      )
        failures.push(
          "Possible embedded credential: " + path.relative(root, file),
        );
    }
  }
}
await walk(path.join(root, "apps"));
await walk(path.join(root, "packages"));
if (failures.length) {
  for (const item of failures) console.error(item);
  process.exitCode = 1;
} else console.log("Repository structure and static delivery checks passed.");
