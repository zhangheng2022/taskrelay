/** 覆盖率下限与新增行校验；缺失数据不能按零行成功。纯格式文件按 Prettier 归一化比较排除。 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import prettier from "prettier";

export function assertFloors(summary, floors, previous) {
  for (const key of ["lines", "branches", "functions"]) {
    if (!Number.isFinite(summary[key]?.pct) || !(summary[key]?.total > 0))
      throw Error(`COVERAGE_REPORT_INVALID:${key}`);
    if (previous && floors[key] < previous[key]) throw Error(`COVERAGE_FLOOR_DECREASED:${key}`);
    if (summary[key].pct < floors[key]) throw Error(`COVERAGE_BELOW_FLOOR:${key}`);
  }
}
export function parseLcov(input) {
  const files = new Map();
  let current;
  for (const line of input.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      current = new Map();
      files.set(line.slice(3).replaceAll("\\", "/"), current);
    }
    if (line.startsWith("DA:") && current) {
      const [n, hits] = line.slice(3).split(",").map(Number);
      current.set(n, hits);
    }
  }
  return files;
}
export function changedLines(diff) {
  const lines = new Set();
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    for (let n = Number(match[1]), end = n + Number(match[2] ?? 1); n < end; n++) lines.add(n);
  }
  return lines;
}
async function main() {
  const floors = JSON.parse(readFileSync("scripts/coverage-baseline.json", "utf8"));
  const summary = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8")).total;
  const base = process.env.COVERAGE_BASE;
  let previous;
  if (base) {
    if (!/^[a-f0-9]{40}$/.test(base)) throw Error("COVERAGE_BASE_INVALID");
    const old = spawnSync("git", ["show", `${base}:scripts/coverage-baseline.json`], {
      encoding: "utf8",
    });
    if (old.status === 0) previous = JSON.parse(old.stdout);
  }
  assertFloors(summary, floors, previous);
  let executable = 0,
    covered = 0;
  if (base && previous) {
    const files = parseLcov(readFileSync("coverage/lcov.info", "utf8"));
    const changed = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`],
      { encoding: "utf8" },
    )
      .trim()
      .split(/\r?\n/);
    mkdirSync(".cache/coverage-diff", { recursive: true });
    const options = JSON.parse(readFileSync(".prettierrc.json", "utf8"));
    for (const file of changed) {
      if (
        !/^(apps\/[^/]+\/src|packages\/[^/]+\/src|scripts)\/.*\.(?:tsx?|mts|mjs|js)$/.test(file) ||
        file.endsWith(".d.ts")
      )
        continue;
      const current = readFileSync(file, "utf8");
      const old = spawnSync("git", ["show", `${base}:${file}`], { encoding: "utf8" });
      const normalizedOld =
        old.status === 0 ? await prettier.format(old.stdout, { ...options, filepath: file }) : "";
      const normalizedCurrent = await prettier.format(current, { ...options, filepath: file });
      if (normalizedOld === normalizedCurrent) continue;
      if (normalizedCurrent !== current) throw Error(`COVERAGE_REQUIRES_FORMATTED_SOURCE:${file}`);
      writeFileSync(".cache/coverage-diff/old", normalizedOld);
      writeFileSync(".cache/coverage-diff/new", current);
      const diff = spawnSync(
        "git",
        [
          "--no-pager",
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-index",
          "--unified=0",
          "--",
          ".cache/coverage-diff/old",
          ".cache/coverage-diff/new",
        ],
        { encoding: "utf8" },
      );
      if (![0, 1].includes(diff.status)) throw Error("COVERAGE_DIFF_FAILED");
      const counts = files.get(file);
      if (!counts) {
        // 转译为空的纯类型文件已经由 c8 配置明确排除；其他源码漏报必须失败。
        const config = JSON.parse(readFileSync(".cache/c8-config.json", "utf8"));
        if (config.exclude.includes(file)) continue;
        throw Error(`COVERAGE_FILE_MISSING:${file}`);
      }
      for (const line of changedLines(diff.stdout))
        if (counts.has(line)) {
          executable++;
          if (counts.get(line) > 0) covered++;
        }
    }
    if (executable && covered / executable < 0.8)
      throw Error(`DIFF_COVERAGE_BELOW_80:${covered}/${executable}`);
  }
  const report = `覆盖率：行 ${summary.lines.pct}%，分支 ${summary.branches.pct}%，函数 ${summary.functions.pct}%。\n差异可执行行：${covered}/${executable}${previous ? "" : "（首次建立基线，未套用后续 PR 的差异门槛）"}。\n`;
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
