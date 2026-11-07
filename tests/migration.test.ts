import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

test("多人迁移保留已有数据、密文、ID，并拒绝不存在的归属", () => {
  const sql = new DatabaseSync(":memory:");
  const migrate = (name: string) =>
    sql.exec(readFileSync(new URL(`../scripts/db/legacy-schema/${name}`, import.meta.url), "utf8"));
  for (const file of [
    "0001_initial.sql",
    "0002_conversations.sql",
    "0003_reconciliation.sql",
    "0004_write_recovery.sql",
  ])
    migrate(file);
  sql.exec(`
    INSERT INTO accounts VALUES('old-account','Account','https://example.com','user','unchanged-ciphertext','2026-01-01');
    INSERT INTO tasks VALUES('old-task',1,'{}','paused',NULL,'2026-01-01','2026-01-01');
    INSERT INTO runs(id,task_id,task_snapshot,status,scheduled_for,deadline,account_key,idempotency_key,created_at,updated_at)
    VALUES('old-run','old-task','{"accountId":"old-account"}','succeeded','2026-01-01','2026-01-01','old-account','old-key','2026-01-01','2026-01-01');
    INSERT INTO model_usage VALUES('old-usage','old-run','old-model',1,10,20,'2026-01-01');
  `);
  migrate("0005_multiuser.sql");
  for (const table of ["tasks", "accounts", "runs", "model_usage"]) {
    assert.equal(sql.prepare(`SELECT user_id FROM ${table}`).get()!.user_id, "legacy_owner");
    assert.throws(() => sql.exec(`UPDATE ${table} SET user_id='missing'`), /USER_NOT_FOUND/);
  }
  assert.equal(sql.prepare("SELECT secret FROM accounts").get()!.secret, "unchanged-ciphertext");
  assert.equal(sql.prepare("SELECT profile_id FROM accounts").get()!.profile_id, "old-account");
  assert.equal(sql.prepare("SELECT profile_id FROM runs").get()!.profile_id, "old-account");
  assert.throws(() => sql.exec("DELETE FROM members WHERE id='legacy_owner'"), /USER_HAS_DATA/);
  assert.throws(
    () => sql.exec("UPDATE members SET id='other' WHERE id='legacy_owner'"),
    /USER_HAS_DATA/,
  );
  assert.deepEqual(sql.prepare("PRAGMA foreign_key_check").all(), []);
  sql.close();
});
