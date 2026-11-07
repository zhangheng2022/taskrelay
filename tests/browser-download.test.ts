/** 下载进程适配器用确定性响应替代公网，验证真实分段缓存、超时续传、整体认证及原缓存保护。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadBrowserArchive } from "../scripts/browser-download.mjs";

const source = Buffer.alloc(5 * 1024 * 1024, 37),
  sha256 = createHash("sha256").update(source).digest("hex"),
  url = "https://storage.googleapis.com/chrome-for-testing-public/fixture/win64/chrome-win64.zip";
function provider(options: { interrupt?: boolean; ignoreRange?: boolean } = {}) {
  const ranges: string[] = [];
  let interrupted = false;
  const runCurl = async (args: string[]) => {
    assert.equal(args.at(-1), url);
    assert.equal(args[args.indexOf("--proto") + 1], "=https");
    const header = args[args.indexOf("--dump-header") + 1];
    if (args.includes("--head")) {
      await writeFile(
        header,
        `HTTP/1.1 200 OK\r\nContent-Length: ${source.length}\r\nETag: "fixed"\r\n\r\n`,
      );
      return 0;
    }
    const range = args[args.indexOf("--range") + 1];
    ranges.push(range);
    const [first, end] = range.split("-").map(Number);
    assert.equal(args[args.indexOf("--header") + 1], 'If-Match: "fixed"');
    const output = args[args.indexOf("--output") + 1];
    await writeFile(
      header,
      `HTTP/1.1 ${options.ignoreRange ? 200 : 206} OK\r\nContent-Range: bytes ${first}-${end}/${source.length}\r\n\r\n`,
    );
    if (options.interrupt && !interrupted && first === 0) {
      interrupted = true;
      await writeFile(output, source.subarray(0, 1024));
      return 28;
    }
    await writeFile(output, source.subarray(first, end + 1));
    return 0;
  };
  return { runCurl, ranges };
}

test("固定浏览器分段下载在超时后仅补缺少范围，整体哈希通过后发布；有效缓存不访问网络", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "taskrelay-browser-download-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = path.join(dir, "browser.zip"),
    adapter = provider({ interrupt: true });
  await writeFile(archive, "old-partial-cache");
  assert.equal(
    (await downloadBrowserArchive({ url, archive, sha256, runCurl: adapter.runCurl })).cached,
    false,
  );
  assert.ok(adapter.ranges.includes("1024-4194303"));
  assert.deepEqual(await readFile(archive), source);
  const cached = await downloadBrowserArchive({
    url,
    archive,
    sha256,
    runCurl: async () => {
      throw Error("NETWORK_MUST_NOT_RUN");
    },
  });
  assert.equal(cached.cached, true);
});

test("错误整体哈希或服务器忽略 Range 时不替换原缓存；坏分段回收后可重新下载", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "taskrelay-browser-hash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = path.join(dir, "browser.zip");
  await writeFile(archive, "preserve-original");
  await assert.rejects(
    downloadBrowserArchive({ url, archive, sha256: "0".repeat(64), runCurl: provider().runCurl }),
    /BROWSER_ARCHIVE_HASH_MISMATCH/,
  );
  assert.equal(await readFile(archive, "utf8"), "preserve-original");
  assert.equal(await stat(`${archive}.parts/0.part`).catch(() => null), null);
  await assert.rejects(
    downloadBrowserArchive({
      url,
      archive,
      sha256,
      runCurl: provider({ ignoreRange: true }).runCurl,
    }),
    /BROWSER_DOWNLOAD_RANGE_INVALID/,
  );
  assert.equal(await readFile(archive, "utf8"), "preserve-original");
  await downloadBrowserArchive({ url, archive, sha256, runCurl: provider().runCurl });
  assert.deepEqual(await readFile(archive), source);
});

test("下载进程退出后重试复用合法部分与完整分段，不重新下载已经接收的数据", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "taskrelay-browser-resume-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = path.join(dir, "browser.zip"),
    adapter = provider({ interrupt: true });
  await assert.rejects(
    downloadBrowserArchive({
      url,
      archive,
      sha256,
      runCurl: async (args: string[]) => {
        const range = args[args.indexOf("--range") + 1];
        if (!args.includes("--head") && range.startsWith("1024-")) return 7;
        return adapter.runCurl(args);
      },
    }),
    /BROWSER_DOWNLOAD_INCOMPLETE/,
  );
  assert.equal((await stat(`${archive}.parts/0.part`)).size, 1024);
  assert.equal((await stat(`${archive}.parts/1.part`)).size, source.length - 4194304);
  const retry = provider();
  await downloadBrowserArchive({ url, archive, sha256, runCurl: retry.runCurl });
  assert.deepEqual(retry.ranges, ["1024-4194303"]);
  assert.deepEqual(await readFile(archive), source);
});
