import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

/** 需要目录重命名或初始化 Git 的夹具使用工作区可写目录。每次独占一个子目录。 */
export async function workspaceFixture(t: TestContext, name: "extension" | "scope") {
  const root = fileURLToPath(new URL("../.cache/test-fixtures", import.meta.url));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, name + "-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(root));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
