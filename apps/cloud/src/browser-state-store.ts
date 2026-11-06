import { DurableObject } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { seal, unseal } from "./crypto";
import type { AppEnv } from "./env";
import { BROWSER_STATE_MAX_BYTES } from "../../../packages/contracts/src/accounts";

/** 每个不可变状态对象独占一个 SQLite DO；D1 引用是唯一发布事实。
 * alarm 先在 D1 写退休墓碑再回收，发布同时检查墓碑，避免迟到请求引用已删除内容。 */
export class BrowserStateStore extends DurableObject<AppEnv> {
  async put(key: string, bytes: ArrayBuffer) {
    if (!bytes.byteLength || bytes.byteLength > BROWSER_STATE_MAX_BYTES)
      throw Error("BROWSER_STATE_TOO_LARGE");
    if (await this.ctx.storage.get("key")) throw Error("BROWSER_STATE_CONFLICT");
    const values: Record<string, unknown> = { key, parts: Math.ceil(bytes.byteLength / 500_000) };
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
    const meta = await this.ctx.storage.get(["key", "parts"]);
    if (meta.get("key") !== key) return null;
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < Number(meta.get("parts")); i++) {
      const cipher = await this.ctx.storage.get<string>(`part${i}`);
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
  async alarm() {
    const key = await this.ctx.storage.get<string>("key");
    if (!key) return;
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    const [, rows] = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO browser_state_retirements(object_key,retired_at)
        SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM accounts WHERE state_object_key=? OR previous_state_object_key=?)
        AND NOT EXISTS(SELECT 1 FROM browser_state_candidates WHERE object_key=? AND retired=0 AND expires_at>?)`,
      ).bind(key, new Date().toISOString(), key, key, key, new Date().toISOString()),
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
