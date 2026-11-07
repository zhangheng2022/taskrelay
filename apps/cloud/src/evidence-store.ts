import { dbTime } from "./database";
import { applicationDb } from "./database";
import { DurableObject } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { seal, unseal } from "./crypto";
import type { AppEnv } from "./env";
import { imageLimits } from "../../../packages/contracts/src/images";

/** 一个私有图片对象的 KV 元数据；键名与下列字段同名，part0..N 按零基序拼接解密后的字节。 */
interface EvidenceMetadata extends Record<string, unknown> {
  /** KV 格式版本；正常读取只接受 2。 */
  formatVersion: 2;
  /** 与 D1 artifacts.object_key 绑定的不可变对象键。 */
  key: string;
  /** UTC 毫秒期限；NULL 为已发布长期图片，暂存对象由 alarm 向 D1 仲裁。 */
  expires: number | null;
  /** 长期图片是否仍待 D1 确认发布，确认前不得取消孤儿清理。 */
  pendingPersistent: boolean;
  /** partN 分块数量；每块最多 500000 原始字节，分别按 evidence:<key>:N 加密。 */
  parts: number;
}

/** 每次上传独占分块加密对象。聊天截图先暂存，alarm 根据D1发布索引决定
 * 永久保留或清理孤儿；删除聊天先关闭写入，因此过期核对不能复活已删除图片。 */
export class Evidence extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, { ...env, DB: applicationDb(env.DB) });
  }
  async put(
    key: string,
    bytes: ArrayBuffer,
    expires: number | null,
    pendingPersistent = false,
    thumbnail?: ArrayBuffer,
  ) {
    if (
      bytes.byteLength > 2_000_000 ||
      (thumbnail !== undefined && thumbnail.byteLength > imageLimits.thumbnailBytes) ||
      (expires !== null && (expires <= Date.now() || expires > Date.now() + 600_000))
    )
      throw new Error("EVIDENCE_INVALID");
    if (pendingPersistent && expires !== null) throw new Error("EVIDENCE_INVALID");
    const expiry = pendingPersistent ? Date.now() + 600_000 : expires;
    const existing = await this.ctx.storage.get<string>("key");
    if (existing && existing !== key) throw new Error("EVIDENCE_CONFLICT");
    const values: EvidenceMetadata = {
      // formatVersion 固定 KV 布局；part0..N 为各自绑定 evidence:<key>:<序号> 的密文。
      formatVersion: 2,
      key,
      expires: expiry,
      pendingPersistent,
      parts: Math.ceil(bytes.byteLength / 500_000),
    };
    const b = new Uint8Array(bytes);
    for (let i = 0; i < Number(values.parts); i++)
      values["part" + i] = await seal(
        Buffer.from(b.subarray(i * 500_000, (i + 1) * 500_000)).toString("base64"),
        this.env.MASTER_KEY,
        `evidence:${key}:${i}`,
      );
    if (thumbnail)
      values.thumbnail = await seal(
        Buffer.from(thumbnail).toString("base64"),
        this.env.MASTER_KEY,
        `evidence:${key}:thumbnail`,
      );
    await this.ctx.storage.transaction(async (tx) => {
      await tx.put(values);
      if (expiry !== null) await tx.setAlarm(expiry);
      else await tx.deleteAlarm();
    });
  }
  async get(key: string, thumbnail = false): Promise<ArrayBuffer | null> {
    let meta = await this.ctx.storage.get([
      "formatVersion",
      "key",
      "expires",
      "parts",
      "pendingPersistent",
    ]);
    if (meta.get("key") && meta.get("formatVersion") !== 2)
      throw Error("STORAGE_CONVERSION_REQUIRED");
    if (
      meta.get("key") === key &&
      meta.get("pendingPersistent") &&
      Number(meta.get("expires")) <= Date.now()
    ) {
      await this.reconcile();
      meta = await this.ctx.storage.get([
        "formatVersion",
        "key",
        "expires",
        "parts",
        "pendingPersistent",
      ]);
    }
    if (
      meta.get("key") !== key ||
      (meta.get("expires") !== null && Number(meta.get("expires")) <= Date.now())
    )
      return null;
    // 未生成缩略图时返回原图；权限和过期检查与原图完全一致。
    if (thumbnail) {
      const cipher = await this.ctx.storage.get<string>("thumbnail");
      if (cipher)
        return new Uint8Array(
          Buffer.from(
            await unseal<string>(cipher, this.env.MASTER_KEY, `evidence:${key}:thumbnail`),
            "base64",
          ),
        ).buffer;
    }
    const chunks: Uint8Array[] = [];
    const saved = await this.ctx.storage.get<string>(
      Array.from({ length: Number(meta.get("parts")) }, (_, i) => "part" + i),
    );
    for (let i = 0; i < Number(meta.get("parts")); i++) {
      const cipher = saved.get("part" + i);
      if (!cipher) return null;
      chunks.push(
        Buffer.from(
          await unseal<string>(cipher, this.env.MASTER_KEY, `evidence:${key}:${i}`),
          "base64",
        ),
      );
    }
    return Uint8Array.from(Buffer.concat(chunks)).buffer;
  }
  async remove() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
  /** 仅维护窗口中的管理员转换流程调用；验证全部密文后只增加元数据版本，不改对象身份。 */
  async convertMetadata(key: string) {
    if (
      (
        await this.env.DB.prepare("SELECT value FROM settings WHERE key='storageFrozen'").first<{
          value: string;
        }>()
      )?.value !== "1"
    )
      throw Error("STORAGE_NOT_FROZEN");
    const meta = await this.ctx.storage.get(["key", "parts", "formatVersion", "thumbnail"]);
    if (meta.get("key") !== key) throw Error("EVIDENCE_NOT_FOUND");
    if (![undefined, 1, 2].includes(meta.get("formatVersion") as number | undefined))
      throw Error("STORAGE_VERSION_UNSUPPORTED");
    const parts = Number(meta.get("parts"));
    if (!Number.isSafeInteger(parts) || parts < 1 || parts > 4) throw Error("EVIDENCE_INVALID");
    const rows = await this.ctx.storage.get<string>(
      Array.from({ length: parts }, (_, i) => "part" + i),
    );
    for (let i = 0; i < parts; i++) {
      const cipher = rows.get("part" + i);
      if (!cipher) throw Error("EVIDENCE_INVALID");
      const value = await unseal<unknown>(cipher, this.env.MASTER_KEY, `evidence:${key}:${i}`);
      if (
        typeof value !== "string" ||
        Buffer.from(value, "base64").toString("base64") !== value ||
        Buffer.from(value, "base64").length > 500_000
      )
        throw Error("EVIDENCE_INVALID");
    }
    if (meta.get("thumbnail")) {
      const value = await unseal<unknown>(
        String(meta.get("thumbnail")),
        this.env.MASTER_KEY,
        `evidence:${key}:thumbnail`,
      );
      if (
        typeof value !== "string" ||
        Buffer.from(value, "base64").toString("base64") !== value ||
        Buffer.from(value, "base64").length > imageLimits.thumbnailBytes
      )
        throw Error("EVIDENCE_INVALID");
    }
    await this.ctx.storage.put("formatVersion", 2);
    return { converted: meta.get("formatVersion") !== 2 };
  }
  private async reconcile() {
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
    const meta = await this.ctx.storage.get(["key", "expires", "pendingPersistent"]);
    const key = meta.get("key");
    if (!key) return;
    // alarm至少投递一次；重复旧alarm不能删除已经发布为永久的对象。
    if (meta.get("expires") === null) return;
    if (Number(meta.get("expires")) > Date.now()) {
      await this.ctx.storage.setAlarm(Number(meta.get("expires")));
      return;
    }
    if (!meta.get("pendingPersistent")) {
      await this.ctx.storage.deleteAll();
      return;
    }
    // D1不可用时保留可恢复的alarm，而不是删除可能已提交索引的对象。
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    // 先在索引数据库中原子写退休墓碑。发布INSERT也检查这个墓碑：若发布
    // 先完成则保留；若退休先完成则迟到发布失败，不会留下指向空对象的图片。
    const [, retirements] = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO evidence_retirements(object_key,retired_at)
        SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM artifacts a JOIN ai_threads t ON t.id=a.thread_id
          WHERE a.object_key=? AND a.persistent=1 AND t.closed=0)`,
      ).bind(key, dbTime(new Date().toISOString()), key),
      this.env.DB.prepare("SELECT object_key FROM evidence_retirements WHERE object_key=?").bind(
        key,
      ),
    ]);
    const published = retirements.results.length === 0;
    await this.ctx.storage.transaction(async (tx) => {
      if ((await tx.get("key")) !== key) return;
      if (published) {
        await tx.put({ expires: null, pendingPersistent: false });
        await tx.deleteAlarm();
      } else {
        await tx.delete([
          "key",
          "formatVersion",
          "expires",
          "parts",
          "pendingPersistent",
          "part0",
          "part1",
          "part2",
          "part3",
          "thumbnail",
        ]);
        await tx.deleteAlarm();
      }
    });
  }
  async alarm() {
    await this.reconcile();
  }
}
