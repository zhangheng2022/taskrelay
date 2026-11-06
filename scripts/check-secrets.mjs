/** 密钥扫描覆盖当前树及 Git 历史；日志和附件强制脱敏，任何有效命中均失败。 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { qualityTool } from "./quality-tools.mjs";
mkdirSync("out/quality", { recursive: true });
execFileSync(
  await qualityTool("gitleaks"),
  [
    "git",
    ".",
    "--redact=100",
    "--report-format=json",
    "--report-path=out/quality/gitleaks.json",
    "--no-banner",
  ],
  { stdio: "inherit", windowsHide: true },
);
