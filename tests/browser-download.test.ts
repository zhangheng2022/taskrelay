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

test("元数据临时失败会退避重试，旧响应不会掩盖网络错误", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "taskrelay-metadata-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = path.join(dir, "browser.zip"),
    adapter = provider();
  let attempts = 0;
  await downloadBrowserArchive({
    url,
    archive,
    sha256,
    runCurl: async (args: string[]) => {
      if (args.includes("--head") && ++attempts < 3) {
        if (attempts === 1)
          await writeFile(
            args[args.indexOf("--dump-header") + 1],
            "HTTP/1.1 503 Unavailable\r\nContent-Length: 12\r\n\r\n",
          );
        return attempts === 1 ? 22 : 7;
      }
      return adapter.runCurl(args);
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(await readFile(archive), source);
});

test("HEAD 缺少长度或不受支持时只读一字节 Range，并按整体哈希验证下载", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "taskrelay-metadata-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const status of [200, 405, 501]) {
    const archive = path.join(dir, `browser-${status}.zip`),
      adapter = provider();
    let probes = 0;
    await downloadBrowserArchive({
      url,
      archive,
      sha256,
      runCurl: async (args: string[]) => {
        const header = args[args.indexOf("--dump-header") + 1];
        if (args.includes("--head")) {
          await writeFile(header, `HTTP/1.1 ${status} Result\r\n\r\n`);
          return status === 200 ? 0 : 22;
        }
        if (args[args.indexOf("--range") + 1] === "0-0") {
          probes++;
          assert.equal(args[args.indexOf("--max-filesize") + 1], "1");
          await writeFile(
            header,
            `HTTP/1.1 206 Partial\r\nContent-Range: bytes 0-0/${source.length}\r\nETag: "fixed"\r\n\r\n`,
          );
          await writeFile(args[args.indexOf("--output") + 1], source.subarray(0, 1));
          return 0;
        }
        return adapter.runCurl(args);
      },
    });
    assert.equal(probes, 1);
    assert.deepEqual(await readFile(archive), source);
    assert.equal(await stat(`${archive}.parts/probe.byte`).catch(() => null), null);
  }
});

test("元数据重试有界，永久错误直接拒绝，非法一字节响应不能替换原缓存", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "taskrelay-metadata-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const mode of [
    "unavailable",
    "missing",
    "ignored-range",
    "wrong-range",
    "empty-body",
    "oversize",
  ]) {
    const archive = path.join(dir, `${mode}.zip`);
    await writeFile(archive, "preserve-original");
    let attempts = 0;
    await assert.rejects(
      downloadBrowserArchive({
        url,
        archive,
        sha256,
        runCurl: async (args: string[]) => {
          const header = args[args.indexOf("--dump-header") + 1];
          if (args.includes("--head")) {
            attempts++;
            const status = mode === "unavailable" ? 503 : mode === "missing" ? 404 : 200;
            await writeFile(header, `HTTP/1.1 ${status} Result\r\n\r\n`);
            return status === 200 ? 0 : 22;
          }
          const range =
            mode === "wrong-range"
              ? `bytes 1-1/${source.length}`
              : `bytes 0-0/${mode === "oversize" ? 2 ** 32 : source.length}`;
          await writeFile(
            header,
            `HTTP/1.1 ${mode === "ignored-range" ? 200 : 206} Result\r\nContent-Range: ${range}\r\n\r\n`,
          );
          await writeFile(args[args.indexOf("--output") + 1], mode === "empty-body" ? "" : "x");
          return 0;
        },
      }),
      /BROWSER_DOWNLOAD_METADATA_INVALID:HTTP_\d+:CURL_\d+:SIZE_/,
    );
    assert.equal(attempts, mode === "missing" ? 1 : 3);
    assert.equal(await readFile(archive, "utf8"), "preserve-original");
    assert.equal(await stat(`${archive}.parts/probe.byte`).catch(() => null), null);
  }
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

test("分段临时 HTTP 错误重试同一范围，错误页不污染合法前缀或最终归档", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "taskrelay-browser-transient-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = path.join(dir, "browser.zip"),
    adapter = provider({ interrupt: true });
  const attempts = new Map<string, number>();
  await downloadBrowserArchive({
    url,
    archive,
    sha256,
    runCurl: async (args: string[]) => {
      if (args.includes("--head")) return adapter.runCurl(args);
      const range = args[args.indexOf("--range") + 1];
      const tried = attempts.get(range) ?? 0;
      attempts.set(range, tried + 1);
      if (range.startsWith("1024-") && tried < 2) {
        const status = tried === 0 ? 504 : 429;
        await writeFile(
          args[args.indexOf("--dump-header") + 1],
          `HTTP/1.1 ${status} Error\r\nContent-Length: 12\r\n\r\n`,
        );
        await writeFile(args[args.indexOf("--output") + 1], "gateway page");
        return 22;
      }
      return adapter.runCurl(args);
    },
  });
  assert.equal(attempts.get("1024-4194303"), 3);
  assert.deepEqual(await readFile(archive), source);
});

test("持续临时 HTTP 错误受既有六次上限约束，不覆盖原缓存", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "taskrelay-browser-retry-limit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = path.join(dir, "browser.zip"),
    adapter = provider();
  await writeFile(archive, "preserve-original");
  const attempts = new Map<string, number>();
  await assert.rejects(
    downloadBrowserArchive({
      url,
      archive,
      sha256,
      runCurl: async (args: string[]) => {
        if (args.includes("--head")) return adapter.runCurl(args);
        const range = args[args.indexOf("--range") + 1];
        attempts.set(range, (attempts.get(range) ?? 0) + 1);
        await writeFile(
          args[args.indexOf("--dump-header") + 1],
          "HTTP/1.1 503 Unavailable\r\n\r\n",
        );
        return 22;
      },
    }),
    /BROWSER_DOWNLOAD_INCOMPLETE/,
  );
  assert.deepEqual([...attempts.values()], [6, 6]);
  assert.equal(await readFile(archive, "utf8"), "preserve-original");
  assert.equal(await stat(`${archive}.parts/0.part`).catch(() => null), null);
});

test("GitHub 跳转后连接失败重试原范围，跳转正文不作为分段；成功退出的 302 仍拒绝", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "taskrelay-browser-redirect-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = path.join(dir, "browser.zip"),
    adapter = provider();
  let interrupted = false;
  await downloadBrowserArchive({
    url,
    archive,
    sha256,
    runCurl: async (args: string[]) => {
      if (args.includes("--head")) return adapter.runCurl(args);
      const range = args[args.indexOf("--range") + 1];
      if (range.startsWith("0-") && !interrupted) {
        interrupted = true;
        await writeFile(
          args[args.indexOf("--dump-header") + 1],
          "HTTP/1.1 302 Found\r\nLocation: https://release-assets.githubusercontent.com/fixture\r\n\r\n",
        );
        await writeFile(args[args.indexOf("--output") + 1], "redirect page");
        return 28;
      }
      return adapter.runCurl(args);
    },
  });
  assert.ok(interrupted);
  assert.deepEqual(await readFile(archive), source);
  assert.ok(adapter.ranges.includes("0-4194303"));
  await writeFile(archive, "preserve-original");
  await assert.rejects(
    downloadBrowserArchive({
      url: url + "?new-source=1",
      archive,
      sha256,
      runCurl: async (args: string[]) => {
        const normalized = [...args.slice(0, -1), url];
        if (args.includes("--head")) return adapter.runCurl(normalized);
        await writeFile(args[args.indexOf("--dump-header") + 1], "HTTP/1.1 302 Found\r\n\r\n");
        return 0;
      },
    }),
    /BROWSER_DOWNLOAD_RANGE_INVALID:HTTP_302:CURL_0/,
  );
  assert.equal(await readFile(archive, "utf8"), "preserve-original");
});
