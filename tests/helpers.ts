import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { TaskDefinition } from "../packages/contracts/src/index";
export function testDb() {
  const sql = new DatabaseSync(":memory:");
  for (const f of [
    "0001_initial.sql",
    "0002_conversations.sql",
    "0003_reconciliation.sql",
    "0004_write_recovery.sql",
    "0005_multiuser.sql",
    "0006_ai.sql",
    "0007_free_runtime.sql",
    "0008_report_run.sql",
    "0009_batch.sql",
    "0010_personal_quota_pause.sql",
    "0011_manual_quota_pause.sql",
    "0012_conversation_execution.sql",
    "0013_remove_platform_budget.sql",
    "0014_remove_site_authorization.sql",
    "0015_assistance_history.sql",
    "0016_private_messages.sql",
    "0017_authentication_effects.sql",
    "0018_action_ledger.sql",
    "0019_chat_execution.sql",
  ])
    sql.exec(
      readFileSync(
        new URL(`../apps/cloud/migrations/${f}`, import.meta.url),
        "utf8",
      ),
    );
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
      const stmt=sql.prepare(this.query);stmt.setReturnArrays(true);
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
  return { db: db as unknown as D1Database, sql };
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
export async function insertTask(db: D1Database, t = task()) {
  await db
    .prepare(
      "INSERT INTO tasks(id,version,definition,status,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(
      t.id,
      t.version,
      JSON.stringify(t),
      t.status,
      t.nextRunAt,
      t.createdAt,
      t.createdAt,
    )
    .run();
  return t;
}
