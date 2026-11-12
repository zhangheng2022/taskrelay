import { applicationDb } from "../apps/cloud/src/database";
import { dbTime } from "../apps/cloud/src/database";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import type { TaskDefinition } from "../packages/contracts/src/index";
import { seal } from "../apps/cloud/src/crypto";
export function testDb(beforeMigration?: string) {
  const sql = new DatabaseSync(":memory:");
  const migrations = new URL("../apps/cloud/migrations/", import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql") && (!beforeMigration || name < beforeMigration))
    .sort())
    sql.exec(readFileSync(new URL(file, migrations), "utf8"));
  sql.exec(
    "INSERT INTO members(id,email,role) VALUES('fixture_owner','fixture@example.com','admin')",
  );
  sql.exec(
    "INSERT INTO model_connections(id,name,kind,provider,key_alias,default_region,binding_verified) VALUES('conn_test','fixture','provider','openai','fixture-key','us',1)",
  );
  // 旧业务夹具显式使用非流式；流式生产入口套件单独打开并供应真实分块响应。
  sql.exec("INSERT OR REPLACE INTO settings(key,value) VALUES('modelStreamingEnabled','0')");
  class Statement {
    args: any[] = [];
    constructor(readonly query: string) {}
    bind(...args: any[]) {
      this.args = args;
      return this;
    }
    async first<T>(column?: string): Promise<T | null> {
      const row = sql.prepare(this.query).get(...this.args) as any;
      return row ? (column ? row[column] : row) : null;
    }
    async raw() {
      const stmt = sql.prepare(this.query);
      stmt.setReturnArrays(true);
      return stmt.all(...this.args);
    }
    execute() {
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(this.query) || /RETURNING/i.test(this.query))
        return {
          success: true,
          results: sql.prepare(this.query).all(...this.args),
          meta: { changes: 0 },
        };
      const r = sql.prepare(this.query).run(...this.args);
      return {
        success: true,
        results: [],
        meta: { changes: Number(r.changes) },
      };
    }
    async all() {
      return this.execute();
    }
    async run() {
      return this.execute();
    }
  }
  const db = {
    prepare: (q: string) => new Statement(q),
    batch: async (statements: Statement[]) => {
      sql.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((s) => s.execute());
        sql.exec("COMMIT");
        return results;
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { db: applicationDb(db as unknown as D1Database), sql };
}
export function task(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: "task_test",
    version: 1,
    title: "测试查询",
    goal: "查询状态",
    entryUrl: "https://example.com/",
    accountId: "account_test",
    modelId: "model_test",
    modelVersion: 1,
    allowedActions: ["read", "navigate", "fill", "submit"],
    verification: { kind: "goal", value: "成功" },
    schedule: { kind: "manual" },
    status: "active",
    createdAt: new Date().toISOString(),
    nextRunAt: null,
    ...overrides,
  };
}
export async function insertTask(db: D1Database, t = task(), userId = "fixture_owner") {
  // 协议 16 领取必须引用真实归属账号。只补测试所需缺失账号，不覆盖调用方已配置的账号/密文。
  if (
    t.accountId &&
    !(await db.prepare("SELECT id FROM accounts WHERE id=?").bind(t.accountId).first())
  ) {
    const origin = new URL(t.entryUrl).origin;
    const secret = await seal(
      { username: "fixture", password: "fixture-password" },
      Buffer.alloc(32, 9).toString("base64"),
      `account:${t.accountId}`,
    );
    await db.batch([
      db
        .prepare(
          `INSERT INTO accounts(id,name,origin,username_hint,created_at,profile_id,business_domains,user_id)
        VALUES(?,?,?,?,?,?,?,?)`,
        )
        .bind(
          t.accountId,
          "测试账号",
          origin,
          "fi***",
          dbTime(t.createdAt),
          t.accountId,
          JSON.stringify([new URL(origin).hostname]),
          userId,
        ),
      db
        .prepare(
          "INSERT INTO account_credential_versions(account_id,version,secret,login_origins,created_at) VALUES(?,1,?,?,?)",
        )
        .bind(t.accountId, secret, JSON.stringify([origin]), dbTime(t.createdAt)),
    ]);
  }
  await db
    .prepare(
      "INSERT OR IGNORE INTO model_connections(id,name,kind,provider,key_alias,default_region,binding_verified) VALUES('conn_test','fixture','provider','openai','fixture-key','us',1)",
    )
    .run();
  if (
    !(await db
      .prepare("SELECT id FROM model_profile_versions WHERE id=? AND version=?")
      .bind(t.modelId, t.modelVersion)
      .first())
  )
    await db
      .prepare(
        "INSERT INTO model_profile_versions(id,version,config,connection_id,effective_region,capabilities,created_at) VALUES(?,?,?,'conn_test','us',?,?)",
      )
      .bind(t.modelId, t.modelVersion, '{"protocol":"responses"}', "{}", dbTime(t.createdAt))
      .run();
  await db.batch([
    db
      .prepare(
        "INSERT INTO tasks(id,version,title,schedule_kind,status,next_run_at,created_at,updated_at,user_id) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        t.id,
        t.version,
        t.title,
        t.schedule.kind,
        t.status,
        dbTime(t.nextRunAt),
        dbTime(t.createdAt),
        dbTime(t.createdAt),
        userId,
      ),
    db
      .prepare(
        "INSERT INTO task_versions(task_id,version,definition,user_id,model_id,model_version) VALUES(?,?,?,?,?,?)",
      )
      .bind(t.id, t.version, JSON.stringify(t), userId, t.modelId, t.modelVersion),
  ]);
  return t;
}

/** 测试仅通过新结构写入完整消息；元数据与正文同事务，不建立旧表兼容入口。 */
export function seedMessage(
  sql: DatabaseSync,
  row: Record<string, import("node:sqlite").SQLInputValue>,
) {
  const body = { content: "", private_content: null, parts: "[]", ...row };
  const metadata = Object.fromEntries(
    Object.entries(row).filter(([k]) => !["content", "private_content", "parts"].includes(k)),
  );
  if (typeof row.at !== "number" && typeof row.at !== "string")
    throw Error("TEST_MESSAGE_TIME_REQUIRED");
  metadata.at = dbTime(row.at);
  const keys = Object.keys(metadata);
  sql.exec("SAVEPOINT seed_message");
  try {
    const result = sql
      .prepare(
        `INSERT INTO ai_messages(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
      )
      .run(...keys.map((k) => metadata[k]));
    sql
      .prepare("INSERT INTO message_bodies(id,content,private_content,parts) VALUES(?,?,?,?)")
      .run(row.id, body.content, body.private_content, body.parts);
    sql.exec("RELEASE seed_message");
    return result;
  } catch (error) {
    sql.exec("ROLLBACK TO seed_message;RELEASE seed_message");
    throw error;
  }
}
