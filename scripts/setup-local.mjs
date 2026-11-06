import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
const target = new URL("../apps/web/.dev.vars", import.meta.url);
try {
  // 排他创建避免两个初始化进程在检查与写入之间覆盖已有密钥。
  writeFileSync(target, `MASTER_KEY=${randomBytes(32).toString("base64")}\nDEV_MODE=1\n`, {
    flag: "wx",
    mode: 0o600,
  });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
console.log("Local secrets ready; existing values preserved.");
