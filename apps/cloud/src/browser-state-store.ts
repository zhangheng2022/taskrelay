import { dbTime } from "./database";
import { applicationDb } from "./database";
import { DurableObject } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { seal, unseal } from "./crypto";
import type { AppEnv } from "./env";
import { BROWSER_STATE_MAX_BYTES } from "../../../packages/contracts/src/accounts";

/** 一个账号状态候选独占一个 DO；元数据键与字段同名，密文键 part0..N 按零基序读取。 */
interface BrowserStateMetadata extends Record<string, unknown> {
  /** KV 格式版本；正常读取只接受 2，旧对象仅在冻结转换入口升级。 */
  formatVersion: 2;
  /** D1 状态引用/候选的不可变对象键；对象自身不拥有发布权。 */
  key: string;
  /** 分块数量；每块最多 500000 原始字节，AAD 为 browser-state:<key>:N。alarm 先写退休墓碑再删分块。 */
  parts: number;
}

/** 每个不可变状态对象独占一个 SQLite DO；D1 引用是唯一发布事实。
 * alarm 先在 D1 写退休墓碑再回收，发布同时检查墓碑，避免迟到请求引用已删除内容。 */
export class BrowserStateStore extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, { ...env, DB: applicationDb(env.DB) });
  }
  async put(key: string, bytes: ArrayBuffer) {
    if (!bytes.byteLength || bytes.byteLength > BROWSER_STATE_MAX_BYTES)
      throw Error("BROWSER_STATE_TOO_LARGE");
    if (await this.ctx.storage.get("key")) throw Error("BROWSER_STATE_CONFLICT");
    // key 为不可变对象身份；partN 各自按 browser-state:<key>:N 加密。
    const values: BrowserStateMetadata = {
      formatVersion: 2,
      key,
      parts: Math.ceil(bytes.byteLength / 500_000),
    };
    for (let i = 0; i < Number(values.parts); i++)
      values[`part${i}`] = await seal(
        Buffer.from(bytes.slice(i * 500_000, (i + 1) * 500_000)).toString("base64"),
        this.env.MASTER_KEY,
        `browser-state:${key}:${i}`,
      );
    await this.ctx.storage.transaction(async (tx) => {
      if (await tx.get("key")) throw Error("BROWSER_STATE_CONFLICT");
      await tx.put(values);
      await tx.setAlarm(Date.now() + 600_000);
    });
  }
  async get(key: string): Promise<ArrayBuffer | null> {
    const meta = await this.ctx.storage.get(["formatVersion", "key", "parts"]);
    if (meta.get("key") !== key) return null;
    if (meta.get("formatVersion") !== 2) throw Error("STORAGE_CONVERSION_REQUIRED");
    const chunks: Uint8Array[] = [];
    const saved = await this.ctx.storage.get<string>(
      Array.from({ length: Number(meta.get("parts")) }, (_, i) => `part${i}`),
    );
    for (let i = 0; i < Number(meta.get("parts")); i++) {
      const cipher = saved.get(`part${i}`);
      if (!cipher) return null;
      chunks.push(
        Buffer.from(
          await unseal<string>(cipher, this.env.MASTER_KEY, `browser-state:${key}:${i}`),
          "base64",
        ),
      );
    }
    return Uint8Array.from(Buffer.concat(chunks)).buffer;
  }
  /** 离线切换的独立入口；只在冻结窗口验证并升级元数据，保留原对象键和密文。 */
  async convertMetadata(key: string) {
    if (
      (
        await this.env.DB.prepare("SELECT value FROM settings WHERE key='storageFrozen'").first<{
          value: string;
        }>()
      )?.value !== "1"
    )
      throw Error("STORAGE_NOT_FROZEN");
    const meta = await this.ctx.storage.get(["key", "parts", "formatVersion"]);
    if (meta.get("key") !== key) throw Error("BROWSER_STATE_NOT_FOUND");
    if (![undefined, 1, 2].includes(meta.get("formatVersion") as number | undefined))
      throw Error("STORAGE_VERSION_UNSUPPORTED");
    const parts = Number(meta.get("parts"));
    if (
      !Number.isSafeInteger(parts) ||
      parts < 1 ||
      parts > Math.ceil(BROWSER_STATE_MAX_BYTES / 500_000)
    )
      throw Error("BROWSER_STATE_INVALID");
    const rows = await this.ctx.storage.get<string>(
      Array.from({ length: parts }, (_, i) => `part${i}`),
    );
    for (let i = 0; i < parts; i++) {
      const cipher = rows.get(`part${i}`);
      if (!cipher) throw Error("BROWSER_STATE_INVALID");
      const value = await unseal<unknown>(cipher, this.env.MASTER_KEY, `browser-state:${key}:${i}`);
      if (
        typeof value !== "string" ||
        Buffer.from(value, "base64").toString("base64") !== value ||
        Buffer.from(value, "base64").length > 500_000
      )
        throw Error("BROWSER_STATE_INVALID");
    }
    await this.ctx.storage.put("formatVersion", 2);
    return { converted: meta.get("formatVersion") !== 2 };
  }
  async alarm() {
    if (
      (
        await this.env.DB.prepare("SELECT value FROM settings WHERE key='storageFrozen'").first<{
          value: string;
        }>()
      )?.value === "1"
    ) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    const key = await this.ctx.storage.get<string>("key");
    if (!key) return;
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    const [, rows] = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO browser_state_retirements(object_key,retired_at)
        SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM accounts WHERE state_object_key=? OR previous_state_object_key=?)
        AND NOT EXISTS(SELECT 1 FROM browser_state_candidates WHERE object_key=? AND retired=0 AND expires_at>?)`,
      ).bind(
        key,
        dbTime(new Date().toISOString()),
        key,
        key,
        key,
        dbTime(new Date().toISOString()),
      ),
      this.env.DB.prepare(
        "SELECT object_key FROM browser_state_retirements WHERE object_key=?",
      ).bind(key),
      // 密文回收时一并移除含来源域名的候选元数据，仅留下防迟到发布的最小墓碑。
      this.env.DB.prepare(
        "DELETE FROM browser_state_candidates WHERE object_key=? AND EXISTS(SELECT 1 FROM browser_state_retirements WHERE object_key=?)",
      ).bind(key, key),
    ]);
    if (rows.results.length) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
    } else await this.ctx.storage.setAlarm(Date.now() + 3_600_000);
  }
}
