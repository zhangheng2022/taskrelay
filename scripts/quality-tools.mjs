/** 质量工具只下载已固定版本和 SHA-256 的官方产物，复用同一安装逻辑供本地与 Actions 使用。 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";

export async function qualityTool(name) {
  const spec = JSON.parse(await readFile(new URL("./quality-tools.json", import.meta.url), "utf8"))[
    name
  ];
  const platform = spec?.platforms[process.platform];
  if (!platform || process.arch !== "x64") throw Error("QUALITY_PLATFORM_UNSUPPORTED");
  const directory = path.resolve(".cache/tools", `${name}-${spec.version}-${process.platform}`);
  await mkdir(directory, { recursive: true });
  const archive = path.join(
    directory,
    platform.url.endsWith(".zip") ? "download.zip" : "download.tar.gz",
  );
  let bytes = await readFile(archive).catch(() => null);
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== platform.sha256) {
    const response = await fetch(platform.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw Error("QUALITY_TOOL_DOWNLOAD_FAILED");
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== platform.sha256)
      throw Error("QUALITY_TOOL_HASH_MISMATCH");
    await writeFile(archive, bytes);
  }
  execFileSync("tar", ["-xf", archive, "-C", directory], { windowsHide: true });
  const binary = name + (process.platform === "win32" ? ".exe" : "");
  for (const file of await readdir(directory, { recursive: true }))
    if (path.basename(file) === binary) return path.join(directory, file);
  throw Error("QUALITY_TOOL_BINARY_MISSING");
}
