/** 路径影响保守归并；手动及首次检查默认包含安装验收，未知范围不允许静默省略。 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const base = process.env.BASE_SHA;
const files =
  base && /^[a-f0-9]{40}$/.test(base) && !/^0+$/.test(base)
    ? execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" })
        .trim()
        .split(/\r?\n/)
    : null;
const desktop =
  !files ||
  files.some((file) =>
    /^(apps\/desktop\/|packages\/|resources\/|scripts\/|\.github\/|package(?:-lock)?\.json|tsconfig\.json)/.test(
      file,
    ),
  );
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `desktop=${desktop}\n`);
console.log(JSON.stringify({ desktop }));
