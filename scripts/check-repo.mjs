import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const failures = [];
const desktop = JSON.parse(
  await readFile(path.join(root, "apps/desktop/package.json"), "utf8"),
);
if (desktop.dependencies["@browserbasehq/stagehand"] !== "4.3.0")
  failures.push("Stagehand must be pinned to 4.3.0");
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
