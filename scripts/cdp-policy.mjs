import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** CRI 0.34 尚无公开 WebSocket 选项，且发送回调登记晚于快速回复会丢响应。
 * 只补连接边界与登记顺序，协议编号/分发仍归 SDK；不增加命令重试。
 * 版本和完整源码哈希锁定，升级必须复审；生产暂存使用 ignore-scripts，须显式调用。 */
export async function applyCdpPolicy(modules) {
  const directory = path.join(modules, "chrome-remote-interface");
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  const file = path.join(directory, "lib/chrome.js");
  const source = await readFile(file, "utf8");
  const before = "followRedirects: true,";
  const after =
    "followRedirects: false,\n                    handshakeTimeout: 4000,\n                    closeTimeout: 1000,";
  const sendBefore = `        this._ws.send(JSON.stringify(message), (err) => {
            if (err) {
                // handle low-level WebSocket errors
                if (typeof callback === 'function') {
                    callback(err);
                }
            } else {
                this._callbacks[id] = callback;
            }
        });`;
  const sendAfter = `        const payload = JSON.stringify(message);
        this._callbacks[id] = callback;
        const failed = (err) => {
            if (!err) return;
            const pending = this._callbacks[id];
            delete this._callbacks[id];
            if (typeof pending === 'function') pending(err);
        };
        try {
            this._ws.send(payload, failed);
        } catch (err) {
            failed(err);
        }`;
  const original = source.replace(after, before).replace(sendAfter, sendBefore);
  if (
    manifest.version !== "0.34.0" ||
    createHash("sha256").update(original).digest("hex") !==
      "0941d4260b7b207ca3b637e51ca9a6d6192a7af2d3855e96603972fcbab7399f"
  )
    throw Error("CDP_POLICY_REVIEW_REQUIRED");
  const patched = original.replace(before, after).replace(sendBefore, sendAfter);
  if (source !== patched) await writeFile(file, patched);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await applyCdpPolicy(path.resolve(import.meta.dirname, "../node_modules"));
  // 桌面精选依赖存在时也校正；不存在时由 stage-runtime 创建并应用。
  const desktopModules = path.resolve(import.meta.dirname, "../apps/desktop/node_modules");
  try {
    await readFile(path.join(desktopModules, "chrome-remote-interface/package.json"));
  } catch (error) {
    if (error.code === "ENOENT") process.exit(0);
    throw error;
  }
  await applyCdpPolicy(desktopModules);
}
