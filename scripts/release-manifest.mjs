import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const desktop = JSON.parse(
  await readFile(path.join(root, "apps/desktop/package.json"), "utf8"),
);
const files = [
  "apps/desktop/out/make/squirrel.windows/x64/TaskRelay Setup.exe",
  `apps/desktop/out/make/squirrel.windows/x64/TaskRelay-${desktop.version}-full.nupkg`,
  "apps/desktop/out/make/squirrel.windows/x64/RELEASES",
  "apps/desktop/out/TaskRelay-win32-x64/TaskRelay.exe",
  "apps/desktop/out/TaskRelay-win32-x64/resources/app.asar",
  "resources/browser/manifest.json",
];
const artifacts = [];
for (const file of files) {
  const fullPath = path.join(root, file),
    hash = createHash("sha256");
  for await (const chunk of createReadStream(fullPath)) hash.update(chunk);
  artifacts.push({
    file,
    bytes: (await stat(fullPath)).size,
    sha256: hash.digest("hex"),
  });
}
const reports = {};
const packagedAsar = artifacts.find((a) => a.file.endsWith("app.asar"));
const packagedAt = (await stat(path.join(root, packagedAsar.file))).mtimeMs;
for (const name of ["packaged-smoke", "installed-smoke"]) {
  if ((await stat(path.join(root, `out/${name}.json`))).mtimeMs < packagedAt)
    throw new Error(`${name} belongs to an older build`);
  reports[name] = JSON.parse(
    await readFile(path.join(root, `out/${name}.json`), "utf8"),
  );
  if (!reports[name].passed) throw new Error(`${name} has not passed`);
  if (reports[name].version !== desktop.version || reports[name].asarSha256 !== packagedAsar.sha256)
    throw new Error(`${name} does not identify this version and ASAR`);
}
const installedReport = reports["installed-smoke"];
if (typeof installedReport.resourcesPath !== "string" || !path.isAbsolute(installedReport.resourcesPath) ||
    typeof installedReport.executablePath !== "string" || !path.isAbsolute(installedReport.executablePath))
  throw new Error("Installed smoke must identify its actual executable and resources");
const installedAsar = path.join(
  installedReport.resourcesPath,
  "app.asar",
);
if (realpathSync.native(path.join(path.dirname(installedReport.executablePath), "resources")) !== realpathSync.native(installedReport.resourcesPath))
  throw new Error("Installed executable and resources do not belong together");
const installedHash = createHash("sha256");
for await (const chunk of createReadStream(installedAsar))
  installedHash.update(chunk);
if (installedHash.digest("hex") !== packagedAsar.sha256)
  throw new Error("Installed UI does not match this build");
const manifest = {
  version: desktop.version,
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
  }).trim(),
  sourceDirty: !!execFileSync("git", ["status", "--porcelain"], { cwd: root, windowsHide: true, encoding: "utf8" }).trim(),
  generatedAt: new Date().toISOString(),
  platform: "Windows x64",
  signed: false,
  stagehand: desktop.dependencies["@browserbasehq/stagehand"],
  artifacts,
  reports,
  installedAsarPath: realpathSync.native(installedAsar),
  installedAsarMatches: true,
};
await writeFile(
  path.join(root, "out/release-manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    { version: manifest.version, installer: artifacts[0], reportsPassed: true },
    null,
    2,
  ),
);
