import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const files = [
  "apps/desktop/out/make/squirrel.windows/x64/TaskRelay Setup.exe",
  "apps/desktop/out/make/squirrel.windows/x64/TaskRelay-0.1.0-full.nupkg",
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
for (const name of ["packaged-smoke", "installed-smoke"]) {
  reports[name] = JSON.parse(
    await readFile(path.join(root, `out/${name}.json`), "utf8"),
  );
  if (!reports[name].passed) throw new Error(`${name} has not passed`);
}
const manifest = {
  version: "0.1.0",
  generatedAt: new Date().toISOString(),
  platform: "Windows x64",
  signed: false,
  stagehand: "4.3.0",
  artifacts,
  reports,
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
