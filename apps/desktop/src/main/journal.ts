import { HISTORY_EPOCH } from "../../../../packages/contracts/src/index";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
export class Journal {
  private db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, "taskrelay.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    const version = (
      this.db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (version > 3) { this.db.close(); throw new Error("CLIENT_UPGRADE_REQUIRED"); }
    if (version === 0)
      this.db.exec(
        `BEGIN;CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE journal(run_id TEXT PRIMARY KEY,generation TEXT NOT NULL,epoch INTEGER NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE outbox(id TEXT PRIMARY KEY,path TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);PRAGMA user_version=1;COMMIT;`,
      );
    if(version<2) this.db.exec("BEGIN;DELETE FROM cache;PRAGMA user_version=2;COMMIT;");
    if(version<3)this.db.exec("PRAGMA user_version=3;");
  }
  get<T>(key: string): T | null {
    const row = this.db
      .prepare("SELECT value FROM config WHERE key=?")
      .get(key) as { value: string } | undefined;
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
    const row = this.db
      .prepare("SELECT value FROM cache WHERE key=?")
      .get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  cache(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO cache(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  checkpoint(
    runId: string,
    generation: string,
    epoch: number,
    state: string,
    payload: unknown,
  ) {
    this.db
      .prepare(
        "INSERT INTO journal(run_id,generation,epoch,state,payload,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET generation=excluded.generation,epoch=excluded.epoch,state=excluded.state,payload=excluded.payload,updated_at=excluded.updated_at",
      )
      .run(
        runId,
        generation,
        epoch,
        state,
        JSON.stringify(payload),
        new Date().toISOString(),
      );
  }
  incomplete() {
    return this.db
      .prepare(
        "SELECT * FROM journal WHERE state NOT IN ('finished','abandoned')",
      )
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
      .prepare(
        "INSERT OR IGNORE INTO outbox(id,path,body,created_at) VALUES(?,?,?,?)",
      )
      .run(id, p, JSON.stringify(body), new Date().toISOString());
  }
  pending() {
    return this.db
      .prepare("SELECT id,path,body FROM outbox ORDER BY created_at LIMIT 100")
      .all() as { id: string; path: string; body: string }[];
  }
  remove(id: string) {
    this.db.prepare("DELETE FROM outbox WHERE id=?").run(id);
  }
  clearHistory() {
    if(this.pending().length||this.incomplete().length)throw new Error('LOCAL_HISTORY_UNRESOLVED');
    this.db.exec("BEGIN IMMEDIATE;DELETE FROM cache;DELETE FROM journal;COMMIT;");
    this.set('historyEpoch',HISTORY_EPOCH);
  }
  diagnostic() {
    return {
      schema: 3,
      journal: this.db
        .prepare(
          "SELECT run_id,state,updated_at FROM journal ORDER BY updated_at DESC LIMIT 30",
        )
        .all(),
      outboxCount: this.db.prepare("SELECT COUNT(*) count FROM outbox").get(),
    };
  }
  close() {
    this.db.close();
  }
}
