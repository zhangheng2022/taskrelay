import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../resources/browser");
const desktop = JSON.parse(
  await readFile(path.resolve(import.meta.dirname, "../apps/desktop/package.json"), "utf8"),
);
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
if (
  manifest.stagehandVersion !== desktop.dependencies["@browserbasehq/stagehand"] ||
  manifest.platform !== "win64" ||
  !/^\d+(\.\d+){3}$/.test(manifest.buildId)
)
  throw new Error("Browser manifest incompatible");
for (const [relative, hash] of Object.entries(manifest.files)) {
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) throw new Error("Manifest path rejected");
  if (
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex") !== hash
  )
    throw new Error(`Browser hash mismatch: ${relative}`);
}
console.log(`Verified Chrome ${manifest.buildId}, ${Object.keys(manifest.files).length} hashes.`);
