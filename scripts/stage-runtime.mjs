import { mkdir, writeFile, cp, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
const root = path.resolve(import.meta.dirname, ".."),
  staging = path.join(root, ".cache/runtime");
await mkdir(staging, { recursive: true });
const app = JSON.parse(
  await readFile(path.join(root, "apps/desktop/package.json"), "utf8"),
);
const repository = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
await writeFile(
  path.join(staging, "package.json"),
  JSON.stringify({
    name: "taskrelay-runtime",
    version: "0.1.0",
    private: true,
    dependencies: app.dependencies,
    overrides: repository.overrides,
  }),
);
const npmCli = path.join(
  path.dirname(process.execPath),
  "node_modules/npm/bin/npm-cli.js",
);
await promisify(execFile)(
  process.execPath,
  [
    npmCli,
    "install",
    "--omit=dev",
    "--ignore-scripts",
    "--workspaces=false",
    "--no-audit",
    "--prefix",
    staging,
  ],
  { windowsHide: true, timeout: 180000 },
);
await cp(
  path.join(staging, "node_modules"),
  path.join(root, "apps/desktop/node_modules"),
  { recursive: true },
);
console.log("External ESM runtime dependencies staged.");
