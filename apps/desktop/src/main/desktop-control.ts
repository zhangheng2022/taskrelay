/** 同一 Windows 用户的桌面与开机进程在 userData 内协调。
 * 单独的 SQLite 写锁由操作系统在进程退出时释放，只有持锁者可打开执行 Journal。
 * 控制请求仅发给当时的持锁者，过期或进程更换后不重放。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

export function tryAcquireExecutor(directory: string) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, "executor-owner.sqlite"));
  try {
    db.exec("BEGIN IMMEDIATE");
    return db;
  } catch (error) {
    db.close();
    if ((error as { errcode?: number }).errcode === 5) return null;
    throw error;
  }
}

const timeout = 45_000;
type Command = { id: string; method: string; input: string };
type Reply = { ok: true; value?: unknown } | { ok: false; error: string };

export class DesktopControl {
  private readonly db: DatabaseSync;
  private timer?: ReturnType<typeof setInterval>;
  private generation?: string;
  private closed = false;

  constructor(directory: string) {
    this.db = new DatabaseSync(path.join(directory, "executor-control.sqlite"));
    this.db.exec(`
      PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK (id=1), generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS command (
        id TEXT PRIMARY KEY, generation TEXT NOT NULL, method TEXT NOT NULL, input TEXT NOT NULL,
        deadline INTEGER NOT NULL, reply TEXT, started INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  serve(
    execute: (method: string, input: unknown) => unknown,
    failed: () => void,
    afterReply: (method: string) => void,
  ) {
    const generation = (this.generation = randomUUID());
    this.db.exec("BEGIN IMMEDIATE");
    this.db.prepare("INSERT OR REPLACE INTO owner VALUES (1, ?)").run(generation);
    this.db.exec("DELETE FROM command; COMMIT");
    this.timer = setInterval(() => {
      try {
        const now = Date.now();
        this.db.prepare("DELETE FROM command WHERE deadline <= ?").run(now);
        const batch = this.db
          .prepare(
            `UPDATE command SET started=1 WHERE id IN (
            SELECT id FROM command WHERE generation=? AND deadline>? AND started=0
            ORDER BY rowid LIMIT 16
          ) RETURNING id, method, input`,
          )
          .all(generation, now) as Command[];
        for (const command of batch) void this.respond(command, execute, afterReply).catch(failed);
      } catch {
        failed();
      }
    }, 200);
  }

  private async respond(
    command: Command,
    execute: (method: string, input: unknown) => unknown,
    afterReply: (method: string) => void,
  ) {
    let reply: Reply;
    try {
      reply = { ok: true, value: await execute(command.method, JSON.parse(command.input)) };
    } catch (error) {
      reply = {
        ok: false,
        error: error instanceof Error ? error.message : "EXECUTOR_COMMAND_FAILED",
      };
    }
    if (this.closed) return;
    try {
      this.db
        .prepare("UPDATE command SET reply=? WHERE id=?")
        .run(JSON.stringify(reply), command.id);
    } finally {
      if (reply.ok) afterReply(command.method);
    }
  }

  async call(method: string, input?: unknown): Promise<unknown> {
    const generation = this.db.prepare("SELECT generation FROM owner WHERE id=1").get()?.generation;
    if (typeof generation !== "string") throw Error("后台执行器正在启动，请稍后重试。");
    const id = randomUUID();
    const deadline = Date.now() + (method === "status" ? 3000 : timeout);
    this.db
      .prepare("INSERT INTO command(id,generation,method,input,deadline) VALUES(?,?,?,?,?)")
      .run(id, generation, method, JSON.stringify(input ?? null), deadline);
    try {
      while (Date.now() < deadline) {
        await delay(100);
        if (this.closed) break;
        const row = this.db.prepare("SELECT reply FROM command WHERE id=?").get(id);
        if (!row) break;
        if (typeof row.reply !== "string") continue;
        const reply = JSON.parse(row.reply) as Reply;
        if (!reply.ok) throw Error(reply.error);
        return reply.value;
      }
      throw Error("后台执行器未响应，请稍后重试。");
    } finally {
      if (!this.closed) this.db.prepare("DELETE FROM command WHERE id=?").run(id);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    if (this.generation)
      this.db.prepare("DELETE FROM owner WHERE id=1 AND generation=?").run(this.generation);
    this.db.close();
  }
}
