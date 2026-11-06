import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
// One-time provisioning. Never print, write to disk, or pass the key as argv.
// Re-running rotates the encryption key and makes existing encrypted records unreadable.
if (process.argv[2] !== "--initial-empty-database")
  throw new Error("Use only for an empty first deployment: --initial-empty-database");
const root = path.resolve(import.meta.dirname, "..");
const child = spawn(
  process.execPath,
  [path.join(root, "node_modules/wrangler/bin/wrangler.js"), "secret", "put", "MASTER_KEY"],
  {
    cwd: path.join(root, "apps/web"),
    windowsHide: true,
    stdio: ["pipe", "inherit", "inherit"],
  },
);
child.stdin.end(randomBytes(32).toString("base64") + "\n");
process.exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
