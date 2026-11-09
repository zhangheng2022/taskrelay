/** 偏好编辑采用版本条件写；交办首次读取后加密固定，恢复及协助只读同一快照。 */
import { Hono } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import type { AppEnv, Variables } from "../env";
import { dbTime } from "../database";
import { seal, unseal } from "../crypto";
import { idSchema } from "../../../../packages/contracts/src/index";
import type {
  MemoryPreference,
  TaskPreference,
} from "../../../../packages/contracts/src/preferences";
import { pageKey, pageCursor } from "../pagination";
import { estimateTokens } from "../../../../packages/model/src/agent-context";
const ns = JSON.stringify(["preferences"]);
type MemoryRow = {
  key: string;
  value: string;
  enabled: number;
  version: number;
  created_at: string;
  updated_at: string;
};
async function allMemories(
  env: AppEnv,
  owner: string,
  options: { cursor?: [number, string] | null; enabled?: boolean; limit?: number } = {},
): Promise<MemoryPreference[]> {
  const { cursor, enabled, limit } = options;
  const rows = await env.DB.prepare(
    `SELECT key,value,enabled,version,created_at,updated_at FROM ai_memories WHERE owner=? AND namespace=?
     ${enabled === undefined ? "" : "AND enabled=?"}
     ${cursor ? "AND (created_at<? OR (created_at=? AND key<?))" : ""}
     ORDER BY created_at DESC,key DESC ${limit ? "LIMIT ?" : ""}`,
  )
    .bind(
      owner,
      ns,
      ...(enabled === undefined ? [] : [Number(enabled)]),
      ...(cursor ? [cursor[0], cursor[0], cursor[1]] : []),
      ...(limit ? [limit] : []),
    )
    .all<MemoryRow>();
  return Promise.all(
    rows.results.map(async (r) => {
      const value = await unseal<{ text?: string }>(
        r.value,
        env.MASTER_KEY,
        `memory:${owner}:${ns}:${r.key}`,
      );
      return {
        id: r.key,
        text: value.text ?? "",
        enabled: !!r.enabled,
        version: r.version,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    }),
  );
}
const input = z
  .object({
    text: z.string().trim().min(1).max(1000),
    confirmed: z.literal(true),
    enabled: z.boolean().default(false),
    expectedVersion: z.number().int().nonnegative().default(0),
  })
  .strict();
const page = z.object({
  before: z.string().max(512).optional(),
  q: z.string().max(100).optional(),
  state: z.enum(["all", "enabled", "disabled"]).default("all"),
});
export const preferences = new Hono<{ Bindings: AppEnv; Variables: Variables }>()
  .get(
    "/memory-page",
    validator("query", (v) => page.parse(v)),
    async (c) => {
      const { before, q, state } = c.req.valid("query"),
        cursor = pageKey(before);
      // 普通翻页只读取及解密本页，避免取消百条上限后每页反复扫描全部密文。
      // 内容查询无法在数据库明文索引，仍在所属用户的密文解密后匹配。
      const items = (
        await allMemories(c.env, c.get("userId"), {
          cursor,
          enabled: state === "all" ? undefined : state === "enabled",
          limit: q ? undefined : 31,
        })
      ).filter((m) => !q || m.text.toLocaleLowerCase().includes(q.toLocaleLowerCase()));
      return c.json({
        items: items.slice(0, 30),
        nextCursor: items.length > 30 ? pageCursor(items[29].createdAt, items[29].id) : null,
      });
    },
  )
  .put(
    "/memories/:id",
    validator("json", (v: z.input<typeof input>) => input.parse(v)),
    async (c) => {
      const b = c.req.valid("json"),
        id = idSchema.parse(c.req.param("id")),
        owner = c.get("userId"),
        at = dbTime(Date.now());
      const value = await seal(
        { text: b.text, source: "user-confirmed" },
        c.env.MASTER_KEY,
        `memory:${owner}:${ns}:${id}`,
      );
      const result =
        b.expectedVersion === 0
          ? await c.env.DB.prepare(
              "INSERT OR IGNORE INTO ai_memories(owner,namespace,key,value,created_at,updated_at,enabled,version) VALUES(?,?,?,?,?,?,?,1)",
            )
              .bind(owner, ns, id, value, at, at, Number(b.enabled))
              .run()
          : await c.env.DB.prepare(
              "UPDATE ai_memories SET value=?,enabled=?,version=version+1,updated_at=? WHERE owner=? AND namespace=? AND key=? AND version=?",
            )
              .bind(value, Number(b.enabled), at, owner, ns, id, b.expectedVersion)
              .run();
      if (!result.meta.changes) return c.json({ error: "MEMORY_VERSION_CONFLICT" }, 409);
      return c.json({ ok: true });
    },
  )
  .delete(
    "/memories/:id",
    validator("json", (v: { expectedVersion: number }) =>
      z.object({ expectedVersion: z.number().int().positive() }).strict().parse(v),
    ),
    async (c) => {
      const result = await c.env.DB.prepare(
        "DELETE FROM ai_memories WHERE owner=? AND namespace=? AND key=? AND version=?",
      )
        .bind(
          c.get("userId"),
          ns,
          idSchema.parse(c.req.param("id")),
          c.req.valid("json").expectedVersion,
        )
        .run();
      if (!result.meta.changes) return c.json({ error: "MEMORY_VERSION_CONFLICT" }, 409);
      return c.json({ ok: true });
    },
  );

export async function readPreferences(
  env: AppEnv,
  owner: string,
  id?: string,
): Promise<TaskPreference[]> {
  if (!id) return [];
  const row = await env.DB.prepare(
    "SELECT p.value FROM preference_snapshots p JOIN ai_threads t ON t.id=p.thread_id WHERE p.id=? AND p.owner=? AND t.closed=0",
  )
    .bind(id, owner)
    .first<{ value: string }>();
  if (!row) throw Error("PREFERENCE_SNAPSHOT_UNAVAILABLE");
  return unseal<TaskPreference[]>(row.value, env.MASTER_KEY, `preferences:${owner}:${id}`);
}
export async function capturePreferences(env: AppEnv, owner: string, threadId: string, id: string) {
  const prior = await env.DB.prepare("SELECT id FROM preference_snapshots WHERE id=? AND owner=?")
    .bind(id, owner)
    .first();
  if (!prior) {
    const memories = (await allMemories(env, owner, { enabled: true })).map(
      ({ id, text, version }) => ({ id, text, version }),
    );
    const cipher = await seal(memories, env.MASTER_KEY, `preferences:${owner}:${id}`);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO preference_snapshots(id,owner,thread_id,value,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ai_threads WHERE id=? AND user_id=? AND closed=0)",
    )
      .bind(id, owner, threadId, cipher, dbTime(Date.now()), threadId, owner)
      .run();
  }
  return readPreferences(env, owner, id);
}
export function checkPreferenceBudget(
  preferences: TaskPreference[],
  contextTokens: number,
  outputTokens: number,
  otherInput: unknown,
) {
  if (
    preferences.length &&
    estimateTokens(JSON.stringify({ preferences, otherInput })) + outputTokens + 1024 >
      contextTokens
  )
    throw Error("PREFERENCES_TOO_LARGE");
}
