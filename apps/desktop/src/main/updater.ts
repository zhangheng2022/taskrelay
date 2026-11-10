import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AutoUpdater } from "electron";
import { z } from "zod";
import {
  newerVersion,
  packageName,
  packagePath,
  releaseSchema,
  UPDATE_ORIGIN,
  UPDATE_PATH,
  type DesktopRelease,
  type DesktopUpdateStatus,
} from "../../../../packages/contracts/src/updates";

const manifestSchema = z.object({ release: releaseSchema.nullable() }).strict();
type NativeUpdater = Pick<AutoUpdater, "setFeedURL" | "checkForUpdates"> & {
  on(event: "error" | "update-not-available", listener: () => void): unknown;
  on(
    event: "update-downloaded",
    listener: (event: unknown, notes: string, version: string) => void,
  ): unknown;
};
/** 更新流程分为实时/定时发现版本、自动下载校验、等待执行器空闲、调用本地安装器。
 * waiting/installing 阻止新领取，busy 回调统一检查任务、领取请求和待回传记录。
 */
export class DesktopUpdater {
  private value: DesktopUpdateStatus;
  private feed: string | null = null;
  private stopped = false;
  private abort = new AbortController();
  private checking: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private failures = 0;
  private retryAt = 0;
  private restarting = false;
  constructor(
    private options: {
      version: string;
      supported: boolean;
      directory: string;
      native: NativeUpdater;
      busy: () => boolean;
      changed: () => void;
      available: (release: DesktopRelease) => void;
      restart: () => void;
      fetcher?: typeof fetch;
      now?: () => number;
    },
  ) {
    this.value = {
      phase: options.supported ? "idle" : "unsupported",
      release: null,
      progress: null,
      checkedAt: null,
      error: null,
    };
    options.native.on("error", () => {
      if (this.value.phase === "installing") this.fail("安装更新失败，请稍后重试。");
    });
    options.native.on("update-not-available", () => {
      if (this.value.phase === "installing") this.fail("安装器未找到对应版本，请重新检查更新。");
    });
    options.native.on("update-downloaded", (_event, _notes, version) => {
      if (this.stopped || this.restarting || this.value.phase !== "installing") return;
      if (version !== this.value.release?.version || options.busy()) {
        this.fail("安装状态不一致，未自动重启。");
        return;
      }
      this.restarting = true;
      options.restart();
    });
  }
  get status(): DesktopUpdateStatus {
    return { ...this.value };
  }
  get blocksClaims() {
    return this.value.phase === "waiting" || this.value.phase === "installing";
  }
  private set(value: Partial<DesktopUpdateStatus>) {
    if (this.stopped) return;
    this.value = { ...this.value, ...value };
    this.options.changed();
  }
  private fail(error: string) {
    if (this.stopped) return;
    const minutes = [1, 5, 15, 60][Math.min(this.failures++, 3)];
    this.retryAt = (this.options.now ?? Date.now)() + minutes * 60_000;
    this.set({ phase: "error", progress: null, error });
  }
  start() {
    if (this.stopped || this.timer || this.value.phase === "unsupported") return;
    this.timer = setInterval(() => void this.check().catch(() => {}), 60_000);
    void this.check().catch(() => {});
  }
  check(manual = false): Promise<void> {
    if (this.checking) return this.checking;
    if (
      this.stopped ||
      (!manual && (this.options.now ?? Date.now)() < this.retryAt) ||
      ["unsupported", "downloading", "waiting", "installing"].includes(this.value.phase)
    )
      return Promise.resolve();
    this.checking = this.checkLatest().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }
  private async checkLatest() {
    const previous = this.value.release?.version;
    this.set({ phase: "checking", error: null });
    try {
      const response = await (this.options.fetcher ?? fetch)(
        `${UPDATE_ORIGIN}${UPDATE_PATH}/latest.json`,
        {
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
        },
      );
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
        throw Error();
      // Bound metadata even if an upstream omits Content-Length.
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (!response.body) throw Error();
      for await (const chunk of Readable.fromWeb(
        response.body as Parameters<typeof Readable.fromWeb>[0],
      )) {
        size += chunk.length;
        if (size > 16384) throw Error();
        chunks.push(chunk);
      }
      const { release } = manifestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (this.stopped) return;
      const available = release && newerVersion(release.version, this.options.version);
      if (!available || previous !== release.version) {
        this.failures = 0;
        this.retryAt = 0;
      }
      this.set({
        phase: !release ? "unpublished" : available ? "available" : "current",
        release: available ? release : null,
        checkedAt: new Date().toISOString(),
        progress: null,
      });
      if (!this.stopped && available && previous !== release.version) {
        // 系统通知只是提示，不能因通知服务异常阻断自动更新。
        try {
          this.options.available(release);
        } catch {
          /* 下载仍继续。 */
        }
      }
      if (available) await this.download(release.version);
    } catch {
      this.fail("无法检查更新，请检查网络后重试。");
    }
  }
  async download(version: string) {
    if (
      this.stopped ||
      !["available", "error"].includes(this.value.phase) ||
      !this.value.release ||
      this.value.release.version !== version
    )
      throw Error("UPDATE_SELECTION_EXPIRED");
    const release = this.value.release;
    this.set({ phase: "downloading", progress: 0, error: null });
    let directory: string | undefined;
    try {
      await mkdir(this.options.directory, { recursive: true });
      const root = await realpath(this.options.directory);
      for (const name of await readdir(root)) {
        if (/^download-[a-zA-Z0-9]+$/.test(name))
          await rm(path.join(root, name), { recursive: true, force: true });
      }
      // A unique, app-owned local feed. No URLs reach the native installer.
      directory = await mkdtemp(path.join(root, "download-"));
      const response = await (this.options.fetcher ?? fetch)(
        `${UPDATE_ORIGIN}${packagePath(release)}`,
        {
          redirect: "error",
          credentials: "omit",
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30 * 60 * 1000)]),
        },
      );
      if (
        !response.ok ||
        response.status !== 200 ||
        !response.body ||
        Number(response.headers.get("content-length")) !== release.bytes
      ) {
        await response.body?.cancel();
        throw Error();
      }
      const sha256 = createHash("sha256"),
        sha1 = createHash("sha1");
      let bytes = 0,
        last = -1;
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          bytes += chunk.length;
          if (bytes > release.bytes) {
            callback(Error("UPDATE_SIZE_MISMATCH"));
            return;
          }
          sha256.update(chunk);
          sha1.update(chunk);
          const progress = Math.floor((bytes / release.bytes) * 100);
          if (progress !== last) {
            last = progress;
            this.set({ progress });
          }
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        meter,
        createWriteStream(path.join(directory, packageName(release)), { flags: "wx" }),
        { signal: this.abort.signal },
      );
      if (
        bytes !== release.bytes ||
        sha256.digest("hex") !== release.sha256 ||
        sha1.digest("hex") !== release.sha1
      )
        throw Error();
      await writeFile(
        path.join(directory, "RELEASES"),
        `${release.sha1} ${packageName(release)} ${release.bytes}\n`,
        { flag: "wx" },
      );
      if (this.stopped) throw Error();
      this.feed = directory;
      this.set({ phase: "waiting", progress: 100 });
      this.tryInstall();
    } catch {
      // directory is created by mkdtemp under the fixed app update directory only.
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      this.fail("更新下载或完整性校验失败，请重试。");
    }
  }
  tryInstall() {
    if (this.stopped || this.value.phase !== "waiting" || !this.feed || this.options.busy()) return;
    // Set the gate synchronously before any installer work; polling cannot race this.
    this.set({ phase: "installing" });
    try {
      this.options.native.setFeedURL({ url: this.feed });
      this.options.native.checkForUpdates();
    } catch {
      this.fail("无法启动更新安装器，请重试。");
    }
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.abort.abort();
  }
}
