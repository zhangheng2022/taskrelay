import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
async function files(directory: string, prefix = ""): Promise<{ name: string; bytes: Buffer }[]> {
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink())
    throw new Error("EXTENSION_PATH_INVALID");
  const result: { name: string; bytes: Buffer }[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = path.posix.join(prefix, item.name), file = path.join(directory, item.name);
    if (item.isDirectory()) result.push(...await files(file, name));
    else if (item.isFile()) result.push({ name, bytes: await readFile(file) });
    else throw new Error("EXTENSION_PATH_INVALID");
  }
  return result.sort((a, b) => a.name.localeCompare(b.name, "en"));
}
const digest = (entries: Awaited<ReturnType<typeof files>>) => sha256(JSON.stringify(entries.map(f => [f.name, sha256(f.bytes)])));

/** Chromium can load an empty content script from a Windows installer directory.
 * Materialize the exact bundled bytes in an app-owned runtime directory; never patch the SDK.
 */
export async function prepareExtension(source: string, cache: string) {
  const bundled = await files(source);
  if (!bundled.some(f => f.name === "manifest.json") || !bundled.some(f => f.name === "content-script.js" && f.bytes.length))
    throw new Error("EXTENSION_RESOURCES_MISSING");
  const hash = digest(bundled);
  await mkdir(cache, { recursive: true });
  const target = path.join(await realpath(cache), hash);
  const verify = async () => {
    if (digest(await files(target)) !== hash) throw new Error("EXTENSION_INTEGRITY_FAILED");
    return realpath(target);
  };
  try { return await verify(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = await mkdtemp(path.join(await realpath(cache), ".preparing-"));
  try {
    for (const file of bundled) {
      const destination = path.join(staging, file.name);
      await mkdir(path.dirname(destination), { recursive: true });
      // A new file inherits the runtime directory's access context, not installer metadata.
      await writeFile(destination, file.bytes, { flag: "wx" });
    }
    if (digest(await files(staging)) !== hash) throw new Error("EXTENSION_INTEGRITY_FAILED");
    try { await rename(staging, target); } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // Another initialization may have published the same content; verify it below.
    }
    return await verify();
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
