import { seal, unseal } from "./crypto";

type Storage = Pick<
  DurableObjectStorage,
  "get" | "put" | "delete" | "deleteAll" | "setAlarm"
>;
type Meta = {
  id: string;
  status: "pending" | "running" | "done" | "failed" | "consumed";
  expires: number;
  parts: number;
  error?: string;
};
export type EgressResult = {
  status: Meta["status"];
  cipher?: string;
  error?: string;
};
const CHUNK_SIZE = 60_000;
const TTL = 180_000;

// One object per inference. Payloads are encrypted, short-lived and never replayed
// after an alarm has crossed the durable "running" boundary.
export class EgressState {
  private listeners = new Set<() => void>();
  constructor(
    private storage: Storage,
    private secret: string,
    private execute: (job: unknown) => Promise<unknown>,
  ) {}

  async submitAndWait(id: string, cipher: string): Promise<EgressResult> {
    await this.submit(id, cipher);
    const deadline = Date.now() + 90_000;
    // Keep the wait inside the original RPC. A new RPC during alarm execution
    // can replace the DO's current I/O context with visitor request metadata.
    while (Date.now() < deadline) {
      const result = await this.wait();
      if (result.status !== "pending" && result.status !== "running")
        return result;
    }
    throw new Error("MODEL_EGRESS_TIMEOUT");
  }
  async submit(id: string, cipher: string) {
    if (!/^[a-f0-9-]{36}$/.test(id) || cipher.length > 4_000_000)
      throw new Error("MODEL_EGRESS_INPUT_INVALID");
    const existing = await this.storage.get<Meta>("meta");
    if (existing) {
      if (existing.id !== id) throw new Error("MODEL_EGRESS_JOB_MISMATCH");
      return;
    }
    const expires = Date.now() + TTL;
    // Install cleanup before writing sensitive data, including interrupted submissions.
    await this.storage.setAlarm(expires);
    const chunks = this.chunks(cipher);
    await this.storage.put({
      ...chunks,
      meta: {
        id,
        expires,
        status: "pending",
        parts: Object.keys(chunks).length,
      } satisfies Meta,
    });
    await this.storage.setAlarm(Date.now());
  }
  private chunks(cipher: string) {
    const chunks: Record<string, string> = {};
    for (let offset = 0; offset < cipher.length; offset += CHUNK_SIZE)
      chunks[`part:${offset / CHUNK_SIZE}`] = cipher.slice(
        offset,
        offset + CHUNK_SIZE,
      );
    return chunks;
  }
  private keys(meta: Meta) {
    return Array.from({ length: meta.parts }, (_, i) => `part:${i}`);
  }
  private async payload(meta: Meta) {
    const values = await this.storage.get<string>(this.keys(meta));
    return this.keys(meta)
      .map((key) => {
        const value = values.get(key);
        if (value === undefined)
          throw new Error("MODEL_EGRESS_PAYLOAD_MISSING");
        return value;
      })
      .join("");
  }
  private wake() {
    for (const notify of this.listeners) notify();
    this.listeners.clear();
  }
  async read(): Promise<EgressResult> {
    const meta = await this.storage.get<Meta>("meta");
    if (!meta || meta.expires <= Date.now())
      return { status: "failed", error: "MODEL_EGRESS_EXPIRED" };
    return {
      status: meta.status,
      error: meta.error,
      ...(meta.status === "done" ? { cipher: await this.payload(meta) } : {}),
    };
  }
  async wait(): Promise<EgressResult> {
    const first = await this.read();
    if (first.status !== "pending" && first.status !== "running") return first;
    await new Promise<void>((resolve) => {
      const notify = () => {
        clearTimeout(timer);
        this.listeners.delete(notify);
        resolve();
      };
      const timer = setTimeout(notify, 15_000);
      this.listeners.add(notify);
      void this.read().then((latest) => {
        if (latest.status !== "pending" && latest.status !== "running")
          notify();
      }, notify);
    });
    return this.read();
  }
  async ack() {
    const meta = await this.storage.get<Meta>("meta");
    if (!meta || (meta.status !== "done" && meta.status !== "failed")) return;
    await this.storage.delete(this.keys(meta));
    await this.storage.put("meta", {
      ...meta,
      status: "consumed",
      parts: 0,
      error: undefined,
    });
    this.wake();
  }
  async alarm() {
    const meta = await this.storage.get<Meta>("meta");
    if (!meta || meta.expires <= Date.now()) {
      await this.storage.deleteAll();
      this.wake();
      return;
    }
    if (meta.status === "running") {
      await this.storage.delete(this.keys(meta));
      await this.storage.put("meta", {
        ...meta,
        status: "failed",
        parts: 0,
        error: "MODEL_CALL_OUTCOME_UNKNOWN",
      });
      await this.storage.setAlarm(meta.expires);
      this.wake();
      return;
    }
    if (meta.status !== "pending") {
      await this.storage.setAlarm(meta.expires);
      return;
    }
    await this.storage.put("meta", { ...meta, status: "running" });
    await this.storage.setAlarm(meta.expires);
    try {
      const job = await unseal(
        await this.payload(meta),
        this.secret,
        `egress:${meta.id}:request`,
      );
      await this.storage.delete(this.keys(meta));
      const result = await this.execute(job);
      const cipher = await seal(
        result,
        this.secret,
        `egress:${meta.id}:response`,
      );
      if (cipher.length > 4_000_000)
        throw new Error("MODEL_RESPONSE_TOO_LARGE");
      const chunks = this.chunks(cipher);
      await this.storage.put({
        ...chunks,
        meta: {
          ...meta,
          status: "done",
          parts: Object.keys(chunks).length,
        } satisfies Meta,
      });
    } catch (error) {
      const message = (error as Error).message;
      await this.storage.delete(this.keys(meta));
      await this.storage.put("meta", {
        ...meta,
        status: "failed",
        parts: 0,
        error: /^[A-Z][A-Z0-9_]+$/.test(message)
          ? message
          : "MODEL_EGRESS_FAILED",
      });
    }
    this.wake();
  }
}
