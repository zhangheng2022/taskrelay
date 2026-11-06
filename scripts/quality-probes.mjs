/** 在隔离目录注入预期失败，核验工具真的拒绝坏输入；不改业务源码、不提交模拟秘密、不把工具启动当成功。 */
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { qualityTool } from "./quality-tools.mjs";
import { verifyJobs } from "./quality-gate.mjs";
import { randomBytes } from "node:crypto";
const root = process.cwd();
const directory = path.resolve(".cache/quality-probes");
mkdirSync(directory, { recursive: true });
if (directory !== path.join(root, ".cache", "quality-probes"))
  throw Error("PROBE_CLEANUP_PATH_INVALID");
const results = [];
function rejected(name, executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
    ...options,
  });
  if (result.error || result.status === null || result.status === 0)
    throw Error(`QUALITY_PROBE_NOT_REJECTED:${name}`);
  const expected = {
    format: /Code style issues/,
    "floating-promise": /no-floating-promises/,
    hooks: /rules-of-hooks/,
    "test-failure": /fail 1/,
    workflow: /invalid|expected|format/i,
    secret: /leaks found/i,
    coverage: /COVERAGE_BELOW_FLOOR/,
    dependency: /high severity vulnerabilit/i,
  }[name];
  if (!expected?.test(result.stdout + result.stderr))
    throw Error(`QUALITY_PROBE_WRONG_FAILURE:${name}`);
  // 不转储子进程输出，密钥样例也不能进入日志；汇总门槛收到失败必须拒绝。
  let blocked = false;
  try {
    verifyJobs({ static: { result: "failure" } }, true);
  } catch {
    blocked = true;
  }
  if (!blocked) throw Error("QUALITY_PROBE_GATE_BYPASSED");
  results.push({ name, rejected: true });
}
const fixture = (name, content) => {
  const file = path.join(directory, name);
  writeFileSync(file, content);
  return file;
};
try {
  const format = fixture("format.js", "const value={a:1};\n");
  rejected("format", process.execPath, [
    "node_modules/prettier/bin/prettier.cjs",
    "--ignore-path",
    fixture("empty.ignore", ""),
    "--check",
    format,
  ]);
  fixture(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { target: "ES2023", module: "NodeNext", strict: true, jsx: "react-jsx" },
      include: ["*.ts", "*.tsx"],
    }),
  );
  const config = JSON.parse(readFileSync(".oxlintrc.json", "utf8"));
  config.ignorePatterns = [];
  const configFile = fixture("oxlint.json", JSON.stringify(config));
  const lint = (file) => [
    "node_modules/oxlint/bin/oxlint",
    "--no-ignore",
    "--type-aware",
    "--config",
    configFile,
    "--tsconfig",
    path.join(directory, "tsconfig.json"),
    file,
  ];
  rejected(
    "floating-promise",
    process.execPath,
    lint(fixture("promise.ts", "export {}; Promise.resolve(1);\n")),
  );
  rejected(
    "hooks",
    process.execPath,
    lint(
      fixture(
        "hooks.tsx",
        'import {useState} from "react"; export function Bad({show}:{show:boolean}) { if(show) useState(1); return null; }',
      ),
    ),
  );
  rejected("test-failure", process.execPath, [
    "--test",
    fixture(
      "failure.test.mjs",
      'import test from "node:test"; test("negative",()=>{throw Error("expected");});',
    ),
  ]);
  rejected("workflow", await qualityTool("actionlint"), [
    fixture(
      "invalid.yml",
      "name: invalid\non: push\njobs:\n  bad:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: unknown\n",
    ),
  ]);
  // 固定格式样例只在内存传入扫描器，既不是有效账号，也不会写入仓库。
  rejected("secret", await qualityTool("gitleaks"), ["stdin", "--redact=100", "--no-banner"], {
    input:
      'github_token = "ghp_' +
      randomBytes(48)
        .toString("base64")
        .replaceAll(/[^A-Za-z0-9]/g, "")
        .slice(0, 36) +
      '"\n',
  });
  const coverageDir = path.join(directory, "coverage");
  mkdirSync(coverageDir, { recursive: true });
  const scriptsDir = path.join(directory, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, "coverage-baseline.json"),
    JSON.stringify({ lines: 80, branches: 80, functions: 80 }),
  );
  writeFileSync(
    path.join(coverageDir, "coverage-summary.json"),
    JSON.stringify({
      total: {
        lines: { pct: 0, total: 1 },
        branches: { pct: 0, total: 1 },
        functions: { pct: 0, total: 1 },
      },
    }),
  );
  rejected("coverage", process.execPath, [path.join(root, "scripts/check-coverage.mjs")], {
    cwd: directory,
    env: { ...process.env, COVERAGE_BASE: "" },
  });
  fixture(
    "package.json",
    JSON.stringify({
      name: "taskrelay-vulnerability-fixture",
      private: true,
      version: "1.0.0",
      dependencies: { lodash: "4.17.20" },
    }),
  );
  const npm =
    process.env.npm_execpath ??
    (process.platform === "win32"
      ? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
      : null);
  const npmCommand = npm ? process.execPath : "npm";
  const install = spawnSync(
    npmCommand,
    [
      ...(npm ? [npm] : []),
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--workspaces=false",
      "--prefix",
      directory,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  if (install.status !== 0) throw Error("VULNERABILITY_FIXTURE_SETUP_FAILED");
  rejected("dependency", npmCommand, [
    ...(npm ? [npm] : []),
    "audit",
    "--audit-level=high",
    "--prefix",
    directory,
    "--workspaces=false",
  ]);
  console.log(JSON.stringify(results));
  mkdirSync("out/quality", { recursive: true });
  writeFileSync("out/quality/negative-probes.json", JSON.stringify(results, null, 2));
} finally {
  // 固定隔离目录先核对边界，再由同一进程清理。
  rmSync(directory, { recursive: true, force: true });
}
