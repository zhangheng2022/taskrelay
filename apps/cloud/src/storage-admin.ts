/** 数据库离线切换的管理员控制入口；冻结期间逐对象核验格式与密文，全部核验后才开放业务写入。
 * D1 保留对象引用权威，DO RPC 只转换对应私有对象元数据，不导入任意用户内容或执行脚本。 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Variables } from "./env";
const references = `SELECT 'evidence' kind,object_key FROM artifacts
 UNION SELECT 'browser-state',state_object_key FROM accounts WHERE state_object_key IS NOT NULL
 UNION SELECT 'browser-state',previous_state_object_key FROM accounts WHERE previous_state_object_key IS NOT NULL
 UNION SELECT 'browser-state',object_key FROM browser_state_candidates WHERE retired=0`;
const schema = z
  .object({
    objects: z
      .array(
        z
          .object({ kind: z.enum(["evidence", "browser-state"]), key: z.string().min(1).max(300) })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();
export const storageAdmin = new Hono<{ Bindings: AppEnv; Variables: Variables }>()
  .get("/status", async (c) => {
    const [meta, pending] = await c.env.DB.batch([
      c.env.DB.prepare("SELECT version,source_digest FROM storage_meta"),
      c.env.DB.prepare(
        `SELECT r.kind,r.object_key FROM (${references}) r WHERE NOT EXISTS(SELECT 1 FROM storage_object_checks v WHERE v.kind=r.kind AND v.object_key=r.object_key) ORDER BY r.kind,r.object_key LIMIT 50`,
      ),
    ]);
    return c.json({ meta: meta.results[0], pending: pending.results });
  })
  .post("/objects/convert", async (c) => {
    if (
      (
        await c.env.DB.prepare("SELECT value FROM settings WHERE key='storageFrozen'").first<{
          value: string;
        }>()
      )?.value !== "1"
    )
      throw Error("STORAGE_NOT_FROZEN");
    const input = schema.parse(await c.req.json());
    const results = [];
    for (const object of input.objects) {
      if (
        !(await c.env.DB.prepare(`SELECT 1 FROM (${references}) WHERE kind=? AND object_key=?`)
          .bind(object.kind, object.key)
          .first())
      )
        throw Error("STORAGE_OBJECT_NOT_REFERENCED");
      const result =
        object.kind === "evidence"
          ? await c.env.EVIDENCE_STORE.getByName(object.key).convertMetadata(object.key)
          : await c.env.BROWSER_STATES.getByName(object.key).convertMetadata(object.key);
      await c.env.DB.prepare(
        "INSERT INTO storage_object_checks(kind,object_key,verified_at) VALUES(?,?,?) ON CONFLICT(kind,object_key) DO UPDATE SET verified_at=excluded.verified_at",
      )
        .bind(object.kind, object.key, Date.now())
        .run();
      results.push({ ...object, ...result });
    }
    return c.json({ objects: results });
  })
  .post("/activate", async (c) => {
    z.object({ objectsVerified: z.literal(true), clientsPrepared: z.literal(true) })
      .strict()
      .parse(await c.req.json());
    const [result] = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE settings SET value='0' WHERE key='storageFrozen' AND value='1'
   AND NOT EXISTS(SELECT 1 FROM (${references}) r WHERE NOT EXISTS(SELECT 1 FROM storage_object_checks v WHERE v.kind=r.kind AND v.object_key=r.object_key))
   AND NOT EXISTS(SELECT 1 FROM runs WHERE status IN ('queued','running','waiting_user','verifying') OR cleanup_pending=1)`),
    ]);
    if (!result.meta.changes) throw Error("STORAGE_ACTIVATION_BLOCKED");
    // 只开放存储写入；maintenance 和 claimsEnabled 由发布控制恢复原开关，不能越过发布屏障。
    return c.json({ storageFrozen: false });
  });
