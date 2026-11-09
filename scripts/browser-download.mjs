/** 浏览器与 Electron 固定构建资源下载：分段并发、保留已接收字节，最终整体哈希才允许发布缓存。
 * 只处理公开构建资源；每段校验 Content-Range 与长度，超时不丢进度，失败不替换原缓存。
 * curl adapter 保持系统代理/TLS 行为；测试替换网络进程，不替换分块和完整性流程。 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, appendFile, stat, unlink, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

const segmentBytes = 4 * 1024 * 1024;
const sizeOf = async (file) => (await stat(file).catch(() => ({ size: 0 }))).size;
async function hash(file) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest("hex");
}
async function curl(args) {
  try {
    await promisify(execFile)(process.platform === "win32" ? "curl.exe" : "curl", args, {
      windowsHide: true,
      timeout: 75000,
      maxBuffer: 1024 * 1024,
    });
    return 0;
  } catch (error) {
    return typeof error.code === "number" ? error.code : -1;
  }
}
function headers(text) {
  const response = text
    .trim()
    .split(/\r?\n\r?\n/)
    .at(-1)
    .split(/\r?\n/);
  return {
    status: Number(response.shift()?.split(" ")[1]),
    values: new Map(
      response.map((line) => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
      }),
    ),
  };
}

/** archive 为构建入口指定的自有缓存文件；runCurl 只用于隔离进程/网络测试。 */
export async function downloadBrowserArchive({ url, archive, sha256, runCurl = curl }) {
  if ((await sizeOf(archive)) && (await hash(archive)) === sha256) return { cached: true };
  const directory = `${archive}.parts`;
  await mkdir(directory, { recursive: true });
  const common = [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    "--connect-timeout",
    "15",
    "--max-time",
    "60",
  ];
  const headPath = `${directory}/head.headers`;
  let head, size, code;
  for (let attempt = 0; attempt < 3; attempt++) {
    // 每次清除旧响应，避免网络失败后误用前次 HEAD；只接受最终资源的有效大小。
    await unlink(headPath).catch(() => {});
    code = await runCurl([
      ...common,
      "--head",
      "--dump-header",
      headPath,
      "--output",
      process.platform === "win32" ? "NUL" : "/dev/null",
      url,
    ]);
    head = headers(await readFile(headPath, "utf8").catch(() => ""));
    size = Number(head.values.get("content-length"));
    if (
      code === 0 &&
      head.status === 200 &&
      Number.isSafeInteger(size) &&
      size > 0 &&
      size <= 1024 ** 3
    )
      break;
    // 部分代理不提供 HEAD 长度或不支持 HEAD；仅用严格的一字节 Range 获取总长。
    // 忽略 Range 的整包响应受 max-filesize 限制，并且不能通过下面的 206/长度校验。
    if ((code === 0 && head.status === 200) || [405, 501].includes(head.status)) {
      const probe = `${directory}/probe.byte`;
      await unlink(headPath).catch(() => {});
      await unlink(probe).catch(() => {});
      try {
        code = await runCurl([
          ...common,
          "--range",
          "0-0",
          "--max-filesize",
          "1",
          "--dump-header",
          headPath,
          "--output",
          probe,
          url,
        ]);
        head = headers(await readFile(headPath, "utf8").catch(() => ""));
        size = Number(/^bytes 0-0\/(\d+)$/.exec(head.values.get("content-range") ?? "")?.[1]);
        if (
          code === 0 &&
          head.status === 206 &&
          Number.isSafeInteger(size) &&
          size > 0 &&
          size <= 1024 ** 3 &&
          (await sizeOf(probe)) === 1
        )
          break;
      } finally {
        await unlink(probe).catch(() => {});
      }
    }
    const diagnostic = `HTTP_${head.status || 0}:CURL_${code}:SIZE_${Number.isSafeInteger(size) ? size : "missing"}`;
    if (attempt === 2 || [400, 401, 403, 404, 410].includes(head.status))
      throw Error(`BROWSER_DOWNLOAD_METADATA_INVALID:${diagnostic}`);
    console.log(`Build resource metadata retry ${attempt + 1}/3: ${diagnostic}`);
    await delay(500 * 2 ** attempt);
  }
  const etag = head.values.get("etag"),
    count = Math.ceil(size / segmentBytes);
  const metadata = JSON.stringify({ url, sha256, size, etag });
  const metaFile = `${directory}/source.json`;
  if ((await readFile(metaFile, "utf8").catch(() => "")) !== metadata) {
    // 仅删除当前资源的已知分段文件；不递归删除缓存目录或其他构建内容。
    for (let i = 0; i < count; i++) await unlink(`${directory}/${i}.part`).catch(() => {});
    await writeFile(metaFile, metadata);
  }
  let next = 0,
    completed = 0;
  async function worker() {
    while (next < count) {
      const index = next++,
        start = index * segmentBytes,
        end = Math.min(size - 1, start + segmentBytes - 1);
      const part = `${directory}/${index}.part`,
        incoming = `${part}.incoming`,
        header = `${part}.headers`;
      if ((await sizeOf(part)) > end - start + 1) await unlink(part);
      for (let attempt = 0; attempt < 6 && (await sizeOf(part)) < end - start + 1; attempt++) {
        const offset = await sizeOf(part),
          first = start + offset;
        await unlink(incoming).catch(() => {});
        await unlink(header).catch(() => {});
        const code = await runCurl([
          ...common,
          "--range",
          `${first}-${end}`,
          ...(etag ? ["--header", `If-Match: ${etag}`] : []),
          "--dump-header",
          header,
          "--output",
          incoming,
          url,
        ]);
        const reply = headers(await readFile(header, "utf8").catch(() => ""));
        const received = await sizeOf(incoming);
        if (!reply.status && code !== 0) continue;
        // curl 跟随跳转前连接失败时仅留下 3xx 头；没有最终资源响应，不能把跳转正文当分段。
        if (code !== 0 && [301, 302, 303, 307, 308].includes(reply.status)) {
          console.log(
            `Build resource redirect interrupted (curl ${code}); retry segment ${index + 1}/${count}.`,
          );
          continue;
        }
        // 网关/限流错误页不能写入分段；仅在既有六次上限内重试临时状态，保留此前合法前缀。
        if ([408, 429, 500, 502, 503, 504].includes(reply.status)) {
          console.log(
            `Build resource temporary HTTP ${reply.status}; retry segment ${index + 1}/${count}.`,
          );
          continue;
        }
        if (
          reply.status !== 206 ||
          reply.values.get("content-range") !== `bytes ${first}-${end}/${size}` ||
          received > end - first + 1
        )
          throw Error(`BROWSER_DOWNLOAD_RANGE_INVALID:HTTP_${reply.status}:CURL_${code}`);
        // curl 28（超时）/18（连接提前关闭）已接收的合法范围前缀可继续使用；其他错误不发布分段。
        if (code !== 0 && code !== 28 && code !== 18) continue;
        if (received) await appendFile(part, await readFile(incoming));
      }
      if ((await sizeOf(part)) !== end - start + 1) throw Error("BROWSER_DOWNLOAD_INCOMPLETE");
      completed++;
      if (completed % 8 === 0 || completed === count)
        console.log(`Build resource download: ${completed}/${count} segments ready.`);
    }
  }
  // 等全部下载进程退出再报告失败，避免重试与上一轮仍写入的分段竞争。
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => worker()));
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  const assembled = `${archive}.download`;
  await pipeline(
    Readable.from(
      (async function* () {
        for (let i = 0; i < count; i++) yield* createReadStream(`${directory}/${i}.part`);
      })(),
    ),
    createWriteStream(assembled),
  );
  if ((await hash(assembled)) !== sha256) {
    await unlink(assembled);
    for (let i = 0; i < count; i++) await unlink(`${directory}/${i}.part`).catch(() => {});
    throw Error("BROWSER_ARCHIVE_HASH_MISMATCH");
  }
  await rename(assembled, archive);
  return { cached: false };
}
