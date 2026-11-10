/** D1 的时间存储适配：库内 UTC 毫秒整数，领域/HTTP 仍使用 ISO 时间。
 * 写入显式调用 dbTime，不按字符串内容猜测参数类型，也不改写 SQL 或兼容旧表。
 * 读取只转换声明的业务时间列；Better Auth 的 camelCase 毫秒字段保持原样。 */
const columns = new Set([
  "at",
  "created_at",
  "updated_at",
  "next_run_at",
  "scheduled_for",
  "deadline",
  "last_seen",
  "last_claim_at",
  "expires_at",
  "lease_expires_at",
  "lease_until",
  "daily_quota_paused_until",
  "confirmed_at",
  "retired_at",
  "egress_started_at",
  "inference_started_at",
  "provider_started_at",
  "first_delta_at",
]);
export function dbTime(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isSafeInteger(n)) throw Error("DATABASE_TIME_INVALID");
  return n;
}
function decode<T>(row: T): T {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      columns.has(k) && typeof v === "number" ? new Date(v).toISOString() : v,
    ]),
  ) as T;
}
const databases = new WeakMap<D1Database, D1Database>();
const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
const versions = new WeakMap<D1Database, Promise<void>>();
/** 结构版本在同一 isolate 内只检查一次；不在生产入口尝试迁移或回退旧表。 */
export function requireStorageVersion(db: D1Database) {
  const prior = versions.get(db);
  if (prior) return prior;
  const check = (async () => {
    const row = await db.prepare("SELECT version FROM storage_meta").first<{ version: number }>();
    if (row?.version !== 2) throw Error("STORAGE_CONVERSION_REQUIRED");
  })().catch(() => {
    versions.delete(db);
    throw Error("STORAGE_CONVERSION_REQUIRED");
  });
  versions.set(db, check);
  return check;
}
class Statement implements D1PreparedStatement {
  raw: D1PreparedStatement["raw"];
  constructor(private statement: D1PreparedStatement) {
    originals.set(this, statement);
    this.raw = statement.raw.bind(statement);
  }
  bind(...values: unknown[]) {
    const bound = this.statement.bind(...values);
    return bound === this.statement ? this : new Statement(bound);
  }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    if (column !== undefined) {
      const value = await this.statement.first<T>(column);
      return (
        columns.has(column) && typeof value === "number" ? new Date(value).toISOString() : value
      ) as T | null;
    }
    return decode(await this.statement.first<T>());
  }
  async all<T = Record<string, unknown>>() {
    const r = await this.statement.all<T>();
    return { ...r, results: r.results.map(decode) };
  }
  async run<T = Record<string, unknown>>() {
    const r = await this.statement.run<T>();
    return { ...r, results: r.results.map(decode) };
  }
}
export function applicationDb(db: D1Database): D1Database {
  const prior = databases.get(db);
  if (prior) return prior;
  const wrap = (value: Pick<D1Database, "prepare" | "batch">) => ({
    prepare: (sql: string) => new Statement(value.prepare(sql)),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      const results = await value.batch<T>(statements.map((s) => originals.get(s) ?? s));
      return results.map((r) => ({ ...r, results: r.results.map(decode) }));
    },
  });
  const wrapped: D1Database = {
    ...wrap(db),
    exec: (sql) => db.exec(sql),
    dump: () => db.dump(),
    withSession: (constraint) => {
      const session = db.withSession(constraint);
      return { ...wrap(session), getBookmark: () => session.getBookmark() };
    },
  };
  databases.set(db, wrapped);
  databases.set(wrapped, wrapped);
  return wrapped;
}
