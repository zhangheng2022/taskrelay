import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
const target = new URL("../apps/web/.dev.vars", import.meta.url);
if (!existsSync(target))
  writeFileSync(target, `MASTER_KEY=${randomBytes(32).toString("base64")}\nDEV_MODE=1\n`);
console.log("Local secrets ready; existing values preserved.");
