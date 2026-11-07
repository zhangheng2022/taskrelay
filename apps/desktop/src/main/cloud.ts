import { PROTOCOL_VERSION } from "../../../../packages/contracts/src/index";
import { safeStorage } from "electron";
import { Journal } from "./journal";
import WebSocket from "ws";
import { z } from "zod";
import { idSchema } from "../../../../packages/contracts/src/index";
/** Main 的云端适配器：保存设备令牌、协商协议，并提供 HTTP 请求和变更通知。
 * WebSocket 仅触发重新读取；运行、租约和任务状态仍以鉴权后的 HTTP 响应为准。
 */
export class Cloud {
  online = false;
  private readyUntil = 0;
  private stopEvents: (() => void) | null = null;
  constructor(readonly journal: Journal) {}
  get url() {
    return this.journal.get<string>("cloudUrl") ?? "https://tr.zhangheng.eu.org";
  }
  get paired() {
    return !!this.journal.get<string>("token");
  }
  storeToken(token: string) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("OS_ENCRYPTION_UNAVAILABLE");
    this.journal.set("token", safeStorage.encryptString(token).toString("base64"));
  }
  private token() {
    const encrypted = this.journal.get<string>("token");
    if (!encrypted) throw new Error("DEVICE_UNAUTHORIZED");
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  }
  async connect(executorIdle: boolean) {
    // 离线转换保留的终态/关闭回执不执行浏览器副作用，可在协议升级后以原身份确认。
    // 其他旧请求及未收尾检查点仍阻止升级，不能用格式切换重放未知操作。
    const localReady =
      executorIdle &&
      !this.journal.incomplete().length &&
      this.journal
        .pending()
        .every((row) => /^\/api\/runner\/runs\/[^/]+\/(finish|browser-closed)$/.test(row.path));
    type Status = { maintenance: boolean };
    let status: Status;
    try {
      status = await this.request<Status>("GET", "/api/device/status");
    } catch (error) {
      if ((error as Error).message !== "DEVICE_UPGRADE_REQUIRED") throw error;
      if (!localReady) throw new Error("LOCAL_HISTORY_UNRESOLVED");
      await this.request("POST", "/api/device/upgrade", {
        protocolVersion: PROTOCOL_VERSION,
        localReady: true,
      });
      status = await this.request<Status>("GET", "/api/device/status");
    }
    if (!status.maintenance) this.readyUntil = 0;
    if (status.maintenance && Date.now() > this.readyUntil && localReady) {
      await this.request("POST", "/api/device/upgrade", {
        protocolVersion: PROTOCOL_VERSION,
        localReady: true,
      });
      this.readyUntil = Date.now() + 180000;
    }
    return status;
  }
  watch(fn: () => void) {
    this.stopEvents?.();
    let stopped = false,
      socket: WebSocket | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      failures = 0;
    const start = () => {
      if (stopped) return;
      if (!this.paired) {
        timer = setTimeout(start, 30000);
        return;
      }
      const url = new URL("/api/device/events", this.url);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      try {
        socket = new WebSocket(url, {
          headers: {
            Authorization: `Bearer ${this.token()}`,
            "x-taskrelay-protocol": String(PROTOCOL_VERSION),
          },
          handshakeTimeout: 12000,
          followRedirects: false,
        });
        socket.on("open", () => {
          failures = 0;
          fn();
        });
        socket.on("message", () => fn());
        socket.on("error", () => socket?.close());
        socket.on("close", () => {
          if (!stopped)
            timer = setTimeout(start, Math.min(60000, 3000 * 2 ** Math.min(failures++, 5)));
        });
      } catch {
        if (!stopped) timer = setTimeout(start, 30000);
      }
    };
    start();
    this.stopEvents = () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    };
  }
  close() {
    this.stopEvents?.();
    this.stopEvents = null;
  }
  async request<T>(
    method: string,
    p: string,
    body?: unknown,
    publicCall = false,
    binary?: Uint8Array,
  ): Promise<T> {
    // 图片及缩略图用标准 multipart 二进制上传；不会把字节编码进 JSON 或 URL。
    let multipart: FormData | undefined;
    if (binary && p.endsWith("/snapshots")) {
      const metadata = z
        .object({
          epoch: z.number().int().positive(),
          captureId: idSchema,
          purpose: z.enum(["chat", "vision"]),
          thumbnail: z.instanceof(Uint8Array).optional(),
        })
        .parse(body);
      multipart = new FormData();
      multipart.set("epoch", String(metadata.epoch));
      multipart.set("captureId", metadata.captureId);
      multipart.set("purpose", metadata.purpose);
      multipart.set(
        "image",
        new Blob([new Uint8Array(binary)], { type: "image/png" }),
        "image.png",
      );
      if (metadata.thumbnail)
        multipart.set(
          "thumbnail",
          new Blob([new Uint8Array(metadata.thumbnail)], { type: "image/png" }),
          "thumbnail.png",
        );
    }
    const response = await fetch(`${this.url}${p}`, {
      method,
      headers: {
        "x-taskrelay-protocol": String(PROTOCOL_VERSION),
        ...(publicCall ? {} : { Authorization: `Bearer ${this.token()}` }),
        ...(multipart
          ? {}
          : binary
            ? {
                "Content-Type": "image/png",
                "x-lease-epoch": String((body as { epoch: number }).epoch),
              }
            : body
              ? { "Content-Type": "application/json" }
              : {}),
      },
      body: multipart ?? (binary ? Buffer.from(binary) : body ? JSON.stringify(body) : undefined),
      redirect: "error",
      signal: AbortSignal.timeout(
        p.includes("/heartbeat") || p.endsWith("/claim") || method === "GET" ? 12000 : 180000,
      ),
    }).catch(() => {
      this.online = false;
      throw new Error("OFFLINE");
    });
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw new Error(
        [502, 503, 504].includes(response.status)
          ? `HTTP_${response.status}`
          : "CLOUD_RESPONSE_INVALID",
      );
    this.online = true;
    const data = (await response.json()) as T & { error?: string };
    if (!response.ok)
      throw Object.assign(new Error(data.error ?? `HTTP_${response.status}`), {
        data,
      });
    return data;
  }
}
