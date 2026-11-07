import { journalSchema } from "./journal-schema";
import { executionTimingSchema } from "../shared/execution-timing";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
/** Main 的本地持久化边界：config/cache 保存配置与缓存，journal 记录执行检查点，
 * outbox 暂存待确认的终态事实。恢复只回传事实，不把检查点当作浏览器重放脚本。
 */
export class Journal {
  private db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "taskrelay-v4.sqlite");
    if (!existsSync(file) && existsSync(path.join(directory, "taskrelay.sqlite")))
      throw Error("LOCAL_STORAGE_CONVERSION_REQUIRED");
    this.db = new DatabaseSync(file);
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    if (version > 4) {
      this.db.close();
      throw new Error("CLIENT_UPGRADE_REQUIRED");
    }
    if (version !== 0 && version !== 4) {
      this.db.close();
      throw new Error("LOCAL_STORAGE_CONVERSION_REQUIRED");
    }
    if (
      version === 0 &&
      this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").get()
    ) {
      this.db.close();
      throw Error("LOCAL_STORAGE_CONVERSION_REQUIRED");
    }
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    if (version === 0) this.db.exec(journalSchema);
  }
  get<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM config WHERE key=?").get(key) as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  cached<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM cache WHERE key=?").get(key) as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  cache(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO cache(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  checkpoint(runId: string, generation: string, epoch: number, state: string, payload: unknown) {
    this.db
      .prepare(
        "INSERT INTO journal(run_id,generation,epoch,state,payload,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET generation=excluded.generation,epoch=excluded.epoch,state=excluded.state,payload=excluded.payload,updated_at=excluded.updated_at",
      )
      .run(runId, generation, epoch, state, JSON.stringify(payload), Date.now());
  }
  incomplete() {
    return this.db
      .prepare("SELECT * FROM journal WHERE state NOT IN ('finished','abandoned')")
      .all() as {
      run_id: string;
      generation: string;
      epoch: number;
      state: string;
      payload: string;
    }[];
  }
  queue(id: string, p: string, body: unknown) {
    this.db
      // 序号在同一 SQL 写入中从索引尾部取得；重复幂等 ID 不改变原回执的位置。
      .prepare(
        "INSERT OR IGNORE INTO outbox(id,path,body,created_at,ordinal) SELECT ?,?,?,?,COALESCE(MAX(ordinal),0)+1 FROM outbox",
      )
      .run(id, p, JSON.stringify(body), Date.now());
  }
  pending() {
    return this.db.prepare("SELECT id,path,body FROM outbox ORDER BY ordinal LIMIT 100").all() as {
      id: string;
      path: string;
      body: string;
    }[];
  }
  remove(id: string) {
    this.db.prepare("DELETE FROM outbox WHERE id=?").run(id);
  }
  clearHistory() {
    if (this.pending().length || this.incomplete().length)
      throw new Error("LOCAL_HISTORY_UNRESOLVED");
    this.db.exec("BEGIN IMMEDIATE;DELETE FROM cache;DELETE FROM journal;COMMIT;");
  }
  diagnostic() {
    // 只取计时子对象；最新检查点可能只涵盖运行的一部分。
    const rows = this.db
      .prepare(
        `SELECT run_id,state,updated_at,
      CASE WHEN json_type(payload,'$.timing')='object'
           THEN json_extract(payload,'$.timing') END AS timing
      FROM journal ORDER BY updated_at DESC,run_id DESC LIMIT 30`,
      )
      .all() as { run_id: string; state: string; updated_at: number; timing: string | null }[];
    return {
      schema: 4,
      journal: rows.map(({ timing, ...row }) => {
        const parsed =
          typeof timing === "string" && executionTimingSchema.safeParse(JSON.parse(timing));
        return {
          ...row,
          updated_at: new Date(row.updated_at).toISOString(),
          ...(parsed && parsed.success ? { timing: parsed.data } : {}),
        };
      }),
      outboxCount: this.db.prepare("SELECT COUNT(*) count FROM outbox").get(),
    };
  }
  close() {
    this.db.close();
  }
}
