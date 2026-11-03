import {
  install,
  resolveBuildId,
  Browser,
  BrowserPlatform,
} from "@puppeteer/browsers";
import {
  mkdir,
  cp,
  readFile,
  writeFile,
  readdir,
  stat,
} from "node:fs/promises";
import { createHash, generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const root = path.resolve(import.meta.dirname, ".."),
  target = path.join(root, "resources/browser");
await mkdir(target, { recursive: true });
const buildId = await resolveBuildId(
  Browser.CHROME,
  BrowserPlatform.WIN64,
  "stable",
);
console.log(`Downloading Chrome for Testing ${buildId} (Windows x64)…`);
let source;
if (process.platform === "win32") {
  const archive = path.join(root, ".cache", `chrome-${buildId}.zip`),
    unpack = path.join(root, ".cache", `chrome-${buildId}`);
  await promisify(execFile)(
    "curl.exe",
    [
      "--fail",
      "--location",
      "--retry",
      "2",
      "--connect-timeout",
      "15",
      "--max-time",
      "300",
      "--output",
      archive,
      `https://storage.googleapis.com/chrome-for-testing-public/${buildId}/win64/chrome-win64.zip`,
    ],
    { windowsHide: true, timeout: 330000, maxBuffer: 1024 * 1024 },
  );
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  await promisify(execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(unpack)} -Force`,
    ],
    { windowsHide: true, timeout: 180000 },
  );
  source = path.join(unpack, "chrome-win64");
} else {
  const installed = await install({
    browser: Browser.CHROME,
    buildId,
    platform: BrowserPlatform.WIN64,
    cacheDir: path.join(root, ".cache/browsers"),
  });
  source = path.dirname(installed.executablePath);
}
await cp(source, path.join(target, "chrome-win64"), { recursive: true });
await cp(
  path.join(root, "node_modules/@browserbasehq/stagehand/dist/extension"),
  path.join(root, "resources/stagehand-extension"),
  { recursive: true },
);
// Stable public identity allows Chromium's CDP origin allowlist to be specific.
const identityPath = path.join(root, "resources/stagehand-public-key.txt");
let publicKey;
try {
  publicKey = (await readFile(identityPath, "utf8")).trim();
} catch {
  publicKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64");
  await writeFile(identityPath, publicKey + "\n");
}
const extensionManifestPath = path.join(
  root,
  "resources/stagehand-extension/manifest.json",
);
const extensionManifest = JSON.parse(
  await readFile(extensionManifestPath, "utf8"),
);
extensionManifest.key = publicKey;
await writeFile(
  extensionManifestPath,
  JSON.stringify(extensionManifest, null, 2),
);
const files = {};
async function walk(dir, prefix = "") {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, item.name),
      file = path.join(dir, item.name);
    if (item.isDirectory()) await walk(file, relative);
    else
      files[relative] = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
  }
}
await walk(path.join(target, "chrome-win64"), "chrome-win64");
const manifest = {
  browser: "Chrome for Testing",
  buildId,
  platform: "win64",
  stagehandVersion: "4.3.0",
  executable: "chrome-win64/chrome.exe",
  executableSha256: files["chrome-win64/chrome.exe"],
  files,
};
await writeFile(
  path.join(target, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);
await writeFile(
  path.join(root, "resources/NOTICE.txt"),
  "TaskRelay\n\nElectron: MIT, https://www.electronjs.org/\nStagehand 4.3.0: MIT, https://github.com/browserbase/stagehand\nChromium / Chrome for Testing: bundled browser and its third-party notices remain subject to their respective licenses. See chrome://credits and the browser LICENSE files.\nNo RewardPilot source, assets, or UI are included.\n",
);
console.log(
  `Prepared browser ${buildId}; ${Object.keys(files).length} files hashed.`,
);
