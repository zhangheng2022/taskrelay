/** 质量工具只下载已固定版本和 SHA-256 的官方产物。网页下载失败时核对同一 GitHub 资产，令牌仅用于官方 API。 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";

/** 备用入口仍须匹配原仓库、tag、文件名及浏览器下载地址；跨域取文件时绝不转发 API 令牌。 */
export async function qualityToolBytes(platform, fetcher = fetch, token = process.env.GH_TOKEN) {
  let response;
  try {
    response = await fetcher(platform.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    // 只对传输失败或非成功响应尝试官方 API，成功响应的哈希不符必须直接拒绝。
  }
  if (!response?.ok) {
    await response?.body?.cancel();
    const source = new URL(platform.url);
    const match = source.pathname.match(
      /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/,
    );
    if (source.origin !== "https://github.com" || source.search || source.hash || !match)
      throw Error("QUALITY_TOOL_SOURCE_INVALID");
    const [, owner, repo, tag, filename] = match;
    const headers = {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const metadata = await fetcher(
      `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`,
      { headers, redirect: "error", signal: AbortSignal.timeout(30_000) },
    );
    if (!metadata.ok) throw Error("QUALITY_TOOL_METADATA_FAILED");
    const release = await metadata.json();
    const asset = release.assets?.find(
      (item) => item.name === filename && item.browser_download_url === platform.url,
    );
    if (release.tag_name !== tag || !Number.isSafeInteger(asset?.id) || asset.id < 1)
      throw Error("QUALITY_TOOL_ASSET_MISMATCH");
    const download = await fetcher(
      `https://api.github.com/repos/${owner}/${repo}/releases/assets/${asset.id}`,
      {
        headers: { ...headers, Accept: "application/octet-stream" },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (download.status !== 302) throw Error("QUALITY_TOOL_ASSET_REDIRECT_REQUIRED");
    const location = new URL(download.headers.get("location") ?? "", platform.url);
    await download.body?.cancel();
    if (
      location.protocol !== "https:" ||
      location.username ||
      location.password ||
      location.port ||
      !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(
        location.hostname,
      )
    )
      throw Error("QUALITY_TOOL_ASSET_HOST_INVALID");
    response = await fetcher(location.href, {
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw Error("QUALITY_TOOL_DOWNLOAD_FAILED");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== platform.sha256)
    throw Error("QUALITY_TOOL_HASH_MISMATCH");
  return bytes;
}

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
    bytes = await qualityToolBytes(platform);
    await writeFile(archive, bytes);
  }
  execFileSync("tar", ["-xf", archive, "-C", directory], { windowsHide: true });
  const binary = name + (process.platform === "win32" ? ".exe" : "");
  for (const file of await readdir(directory, { recursive: true }))
    if (path.basename(file) === binary) return path.join(directory, file);
  throw Error("QUALITY_TOOL_BINARY_MISSING");
}
