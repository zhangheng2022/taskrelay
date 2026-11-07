import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdir, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { prepareExtension } from "../apps/desktop/src/main/extension";
import { workspaceFixture } from "./workspace-fixture";

async function fixture(t: import("node:test").TestContext) {
  const root = await workspaceFixture(t, "extension");
  const source = path.join(root, "安装 包", "extension"),
    cache = path.join(root, "runtime");
  await mkdir(path.join(source, "nested"), { recursive: true });
  await writeFile(path.join(source, "manifest.json"), '{"manifest_version":3}');
  await writeFile(path.join(source, "content-script.js"), "// 中文\nglobalThis.fixture = true;\n");
  await writeFile(path.join(source, "nested", "worker.js"), "// worker");
  return { source, cache };
}
test("扩展发布被拒且没有并发发布者时保留原始权限错误，清理暂存目录", async (t) => {
  const { source, cache } = await fixture(t);
  const denied = Object.assign(new Error("fixture rename denied"), { code: "EPERM" });
  const mock = t.mock.method(fs, "rename", async () => {
    throw denied;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(prepareExtension(source, cache), (error) => error === denied);
    assert.deepEqual(await fs.readdir(cache), []);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});
test("正式扩展准备：保留完整字节，复用相同内容，升级使用独立目录", async (t) => {
  const { source, cache } = await fixture(t);
  const prepared = await prepareExtension(source, cache);
  assert.notEqual(prepared, source);
  for (const file of ["manifest.json", "content-script.js", "nested/worker.js"])
    assert.deepEqual(
      await readFile(path.join(prepared, file)),
      await readFile(path.join(source, file)),
    );
  assert.equal(await prepareExtension(source, cache), prepared);
  await writeFile(path.join(source, "content-script.js"), "// updated");
  assert.notEqual(await prepareExtension(source, cache), prepared);
});
test("正式扩展准备：拒绝被清空或注入额外文件的缓存，不静默加载", async (t) => {
  const { source, cache } = await fixture(t);
  const prepared = await prepareExtension(source, cache);
  await writeFile(path.join(prepared, "content-script.js"), "");
  await assert.rejects(prepareExtension(source, cache), /EXTENSION_INTEGRITY_FAILED/);
  await writeFile(
    path.join(prepared, "content-script.js"),
    await readFile(path.join(source, "content-script.js")),
  );
  await writeFile(path.join(prepared, "injected.js"), "// unexpected");
  await assert.rejects(prepareExtension(source, cache), /EXTENSION_INTEGRITY_FAILED/);
});
test("正式扩展准备：缺失资源不发布，两个初始化可安全共享相同内容", async (t) => {
  const { source, cache } = await fixture(t);
  await writeFile(path.join(source, "content-script.js"), "");
  await assert.rejects(prepareExtension(source, cache), /EXTENSION_RESOURCES_MISSING/);
  await writeFile(path.join(source, "content-script.js"), "// restored");
  const results = await Promise.all([
    prepareExtension(source, cache),
    prepareExtension(source, cache),
  ]);
  assert.equal(results[0], results[1]);
});
