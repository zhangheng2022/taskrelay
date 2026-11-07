import { DurableObject } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { seal, unseal } from "./crypto";
import type { AppEnv } from "./env";
import { imageLimits } from "../../../packages/contracts/src/images";

/** 每次上传独占分块加密对象。聊天截图先暂存，alarm 根据D1发布索引决定
 * 永久保留或清理孤儿；删除聊天先关闭写入，因此过期核对不能复活已删除图片。 */
export class Evidence extends DurableObject<AppEnv> {
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
    const values: Record<string, unknown> = {
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
    let meta = await this.ctx.storage.get(["key", "expires", "parts", "pendingPersistent"]);
    if (
      meta.get("key") === key &&
      meta.get("pendingPersistent") &&
      Number(meta.get("expires")) <= Date.now()
    ) {
      await this.reconcile();
      meta = await this.ctx.storage.get(["key", "expires", "parts", "pendingPersistent"]);
    }
    if (
      meta.get("key") !== key ||
      (meta.get("expires") !== null && Number(meta.get("expires")) <= Date.now())
    )
      return null;
    // 旧对象没有缩略图时回退原图；权限和过期检查与原图完全一致。
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
    for (let i = 0; i < Number(meta.get("parts")); i++) {
      const cipher = await this.ctx.storage.get<string>("part" + i);
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
  private async reconcile() {
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
      ).bind(key, new Date().toISOString(), key),
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
