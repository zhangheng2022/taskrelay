import { safeStorage } from "electron";
import { Journal } from "./journal";
export class Cloud {
  online = false;
  constructor(readonly journal: Journal) {}
  get url() {
    return (
      this.journal.get<string>("cloudUrl") ??
      "https://taskrelay.zhangheng.workers.dev"
    );
  }
  get paired() {
    return !!this.journal.get<string>("token");
  }
  storeToken(token: string) {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("OS_ENCRYPTION_UNAVAILABLE");
    this.journal.set(
      "token",
      safeStorage.encryptString(token).toString("base64"),
    );
  }
  private token() {
    const encrypted = this.journal.get<string>("token");
    if (!encrypted) throw new Error("DEVICE_UNAUTHORIZED");
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  }
  async request<T>(
    method: string,
    p: string,
    body?: unknown,
    publicCall = false,
    binary?: Uint8Array,
  ): Promise<T> {
    const response = await fetch(`${this.url}${p}`, {
      method,
      headers: {
        ...(publicCall ? {} : { Authorization: `Bearer ${this.token()}` }),
        ...(binary
          ? {
              "Content-Type": "image/png",
              "x-lease-epoch": String((body as { epoch: number }).epoch),
            }
          : body
            ? { "Content-Type": "application/json" }
            : {}),
      },
      body: binary
        ? Buffer.from(binary)
        : body
          ? JSON.stringify(body)
          : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(
        p.includes("/heartbeat") || p.endsWith("/claim") || method === "GET"
          ? 12000
          : 180000,
      ),
    }).catch(() => {
      this.online = false;
      throw new Error("OFFLINE");
    });
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw new Error("CLOUD_RESPONSE_INVALID");
    this.online = true;
    const data = (await response.json()) as T & { error?: string };
    if (!response.ok)
      throw Object.assign(new Error(data.error ?? `HTTP_${response.status}`), {
        data,
      });
    return data;
  }
  async user<T>(method: string, p: string, body?: unknown): Promise<T> {
    const cachedAllowed =
      method === "GET" &&
      /\/(snapshot|runs\/[^/]+|tasks\/[^/]+\/chat|settings)$/.test(p);
    try {
      const result = await this.request<T>(
        method,
        p.replace("/api/user/", "/api/device/user/"),
        body,
      );
      if (cachedAllowed) this.journal.cache(p, result);
      return result;
    } catch (e) {
      if ((e as Error).message === "OFFLINE" && cachedAllowed) {
        const cached = this.journal.cached<T>(p);
        if (cached) return cached;
      }
      throw e;
    }
  }
}
