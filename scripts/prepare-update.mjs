import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const notesFile = process.argv[2];
if (!notesFile)
  throw Error(
    "用法：node scripts/prepare-update.mjs <更新说明文件>；先生成本次 release-manifest.json",
  );
const desktop = JSON.parse(await readFile(path.join(root, "apps/desktop/package.json"), "utf8"));
const manifestFile = path.join(root, "out/release-manifest.json");
const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
const notes = (await readFile(path.resolve(notesFile), "utf8")).trim();
if (
  !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(desktop.version) ||
  notes.length > 4000
)
  throw Error("INVALID_RELEASE_METADATA");
if (
  manifest.version !== desktop.version ||
  !manifest.installedAsarMatches ||
  !["packaged-smoke", "installed-smoke"].every(
    (key) => manifest.reports?.[key]?.passed && manifest.reports[key].version === desktop.version,
  )
)
  throw Error("RELEASE_ACCEPTANCE_REQUIRED");
const filename = `TaskRelay-${desktop.version}-full.nupkg`;
const relative = `apps/desktop/out/make/squirrel.windows/x64/${filename}`;
const artifact = manifest.artifacts.find((a) => a.file === relative);
const fullPath = path.join(root, relative),
  info = await stat(fullPath);
if (!artifact || artifact.bytes !== info.size || (await stat(manifestFile)).mtimeMs < info.mtimeMs)
  throw Error("STALE_RELEASE_MANIFEST");
const sha256 = createHash("sha256"),
  sha1 = createHash("sha1");
for await (const chunk of createReadStream(fullPath)) {
  sha256.update(chunk);
  sha1.update(chunk);
}
const digest = sha256.digest("hex");
if (digest !== artifact.sha256) throw Error("PACKAGE_CHANGED_AFTER_ACCEPTANCE");
const release = {
  version: desktop.version,
  sha256: digest,
  sha1: sha1.digest("hex"),
  bytes: info.size,
  notes,
  publishedAt: new Date().toISOString(),
};
// Only generates a candidate. Publishing a package and activating the CF catalog are separate steps.
await writeFile(
  path.join(root, "out/desktop-release.json"),
  JSON.stringify(release, null, 2) + "\n",
);
console.log(`已生成 out/desktop-release.json（${release.version}），尚未发布或启用更新。`);
