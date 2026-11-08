import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { SQL } from "drizzle-orm";
import * as mappings from "../apps/cloud/src/schema";
import { applicationDb } from "../apps/cloud/src/database";
import { testDb, insertTask, task } from "./helpers";
import { enqueue, claim } from "../apps/cloud/src/store";
import { PROTOCOL_VERSION } from "../packages/contracts/src/index";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const baseline = readFileSync(
  new URL("../apps/cloud/migrations/0001_storage_v2.sql", import.meta.url),
  "utf8",
);
const migrations = readdirSync(new URL("../apps/cloud/migrations/", import.meta.url))
  .filter((name) => name.endsWith(".sql") && name !== "0001_storage_v2.sql")
  .sort()
  .map((name) => readFileSync(new URL("../apps/cloud/migrations/" + name, import.meta.url), "utf8"))
  .join("\n");
test("当前迁移的全部表/列/主键/外键与 Drizzle 对齐，并完整声明中文表字段及索引注释", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(baseline + "\n" + migrations);
    const configs = Object.values(mappings).map(getTableConfig),
      names = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name<>'sqlite_sequence' ORDER BY name",
        )
        .all()
        .map((r) => r.name);
    assert.deepEqual(configs.map((c) => c.name).sort(), names);
    for (const config of configs) {
      const cols = db.prepare(`PRAGMA table_info(${config.name})`).all();
      assert.deepEqual(
        config.columns.map((c) => c.name).sort(),
        cols.map((c) => String(c.name)).sort(),
        config.name,
      );
      for (const c of config.columns) {
        const actual = cols.find((r) => r.name === c.name)!;
        assert.equal(c.getSQLType().toUpperCase(), actual.type, `${config.name}.${c.name}`);
        assert.equal(
          c.notNull,
          !!actual.notnull || !!actual.pk,
          `${config.name}.${c.name} nullable`,
        );
      }
      const primary = [
        ...config.columns.filter((c) => c.primary).map((c) => c.name),
        ...config.primaryKeys.flatMap((p) => p.columns.map((c) => c.name)),
      ];
      assert.deepEqual(
        primary,
        cols
          .filter((c) => c.pk)
          .sort((a, b) => Number(a.pk) - Number(b.pk))
          .map((c) => c.name),
        config.name + " PK",
      );
      const expected = db
        .prepare(`PRAGMA foreign_key_list(${config.name})`)
        .all()
        .map(
          (r) =>
            `${r.from as string}->${r.table as string}.${r.to as string}:${r.on_delete as string}`,
        )
        .sort();
      const actual = config.foreignKeys
        .flatMap((fk) => {
          const r = fk.reference();
          return r.columns.map(
            (c, i) =>
              `${c.name}->${getTableConfig(r.foreignTable).name}.${r.foreignColumns[i].name}:${(fk.onDelete ?? "no action").toUpperCase()}`,
          );
        })
        .sort();
      assert.deepEqual(actual, expected, config.name + " FK");
      const dialect = new SQLiteSyncDialect(),
        normalize = (value: string) =>
          value
            .replace(/["`]/g, "")
            .replace(/\b\w+\./g, "")
            .replace(/\s+/g, "")
            .toLowerCase();
      const expectedIndexes = db
        .prepare(`PRAGMA index_list(${config.name})`)
        .all()
        .filter((i) => i.origin !== "pk")
        .map((i) => {
          const columns = db
            .prepare(`PRAGMA index_xinfo("${i.name as string}")`)
            .all()
            .filter((c) => c.key && Number(c.cid) >= 0)
            .map((c) => normalize(String(c.name) + (c.desc ? "desc" : "")));
          const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(i.name as string)
            ?.sql as string | undefined;
          return JSON.stringify({
            unique: !!i.unique,
            columns,
            where: normalize(ddl?.match(/ WHERE ([\s\S]+)$/)?.[1] ?? ""),
          });
        })
        .sort();
      const actualIndexes = config.indexes
        .map((i) =>
          JSON.stringify({
            unique: !!i.config.unique,
            columns: i.config.columns.map((c) =>
              normalize(c instanceof SQL ? dialect.sqlToQuery(c).sql : c.name),
            ),
            where: normalize(i.config.where ? dialect.sqlToQuery(i.config.where).sql : ""),
          }),
        )
        .sort();
      assert.deepEqual(actualIndexes, expectedIndexes, config.name + " indexes");
      const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(config.name)!
        .sql as string;
      const checks = ddl.replace(/--[^\n]*/g, "");
      assert.equal(
        config.checks.length,
        [...checks.matchAll(/\bCHECK\(/g)].length,
        config.name + " CHECK count",
      );
      for (const check of config.checks)
        assert.ok(
          normalize(checks).includes(
            "check(" + normalize(dialect.sqlToQuery(check.value).sql) + ")",
          ),
          config.name + " CHECK expression",
        );
      const table = new RegExp(
        `-- ([^\\n]+)\\nCREATE TABLE ${config.name} \\(([\\s\\S]*?)\\n\\);`,
      ).exec(baseline);
      assert.ok(table && /[\u4e00-\u9fff]/.test(table[1]), config.name + " 表注释");
      for (const c of cols)
        assert.match(
          table![2] + "\n" + migrations.replaceAll(`ALTER TABLE ${config.name} ADD COLUMN `, ""),
          new RegExp(
            `-- [^\\n]*[\\u4e00-\\u9fff][^\\n]*\\n\\s*${c.name as string} (?:TEXT|INTEGER)`,
          ),
          config.name + "." + c.name + " 字段注释",
        );
    }
    for (const m of baseline.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+)/g))
      assert.match(
        baseline.slice(0, m.index).split("\n").at(-2)!,
        /-- .*?[\u4e00-\u9fff]/,
        m[1] + " 索引说明",
      );
    for (const name of [
      "challenges",
      "conversations",
      "run_events",
      "assistance_replies",
      "batch_progress",
      "ai_plan_steps",
      "ai_cutovers",
    ])
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(name), undefined);
  } finally {
    db.close();
  }
});

test("状态来源增量迁移保留既有账号、凭据密文和版本，不扩大旧账号范围", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec(baseline);
    sql.exec("BEGIN;PRAGMA defer_foreign_keys=ON");
    sql.prepare("INSERT INTO members(id) VALUES('migration_owner')").run();
    sql
      .prepare(
        "INSERT INTO accounts(id,name,origin,username_hint,created_at,user_id,credential_version,state_epoch) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        "legacy_account",
        "原有账号",
        "https://example.com",
        "us***",
        1,
        "migration_owner",
        3,
        7,
      );
    sql
      .prepare(
        "INSERT INTO account_credential_versions(account_id,version,secret,login_origins,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        "legacy_account",
        3,
        "existing-encrypted-credentials",
        '["https://login.example.com"]',
        1,
      );
    sql.exec("COMMIT");
    sql.exec(migrations);
    const row = sql.prepare("SELECT * FROM account_details WHERE id='legacy_account'").get()!;
    assert.equal(row.name, "原有账号");
    assert.equal(row.secret, "existing-encrypted-credentials");
    assert.equal(row.credential_version, 3);
    assert.equal(row.state_epoch, 7);
    assert.equal(row.state_origins, "[]");
    assert.equal(row.login_origins, '["https://login.example.com"]');
    assert.deepEqual(sql.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    sql.close();
  }
});

test("同用户外键和活动占用约束守卫真实入队/并发领取", async (t) => {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  const definition = await insertTask(db, task({ accountId: null }));
  sql.prepare("INSERT INTO members(id) VALUES('other')").run();
  assert.throws(
    () => sql.prepare("UPDATE tasks SET user_id='other' WHERE id=?").run(definition.id),
    /FOREIGN KEY/,
  );
  for (const id of ["d1", "d2"])
    await db
      .prepare("INSERT INTO devices(id,name,token_hash,protocol_version) VALUES(?,?,?,?)")
      .bind(id, id, id, PROTOCOL_VERSION)
      .run();
  await enqueue(db, definition, "first");
  await enqueue(db, definition, "second");
  const claimed = await Promise.all([claim(db, "d1", "one"), claim(db, "d2", "two")]);
  assert.equal(claimed.filter(Boolean).length, 1);
  assert.equal(sql.prepare("SELECT count(*) n FROM run_snapshots").get()!.n, 2);
  assert.equal(sql.prepare("SELECT typeof(created_at) t FROM runs LIMIT 1").get()!.t, "integer");
});

test(
  "实际 workerd D1 支持新基线循环版本约束、原子领取和分页索引，并返回真实隔离读写元数据",
  { timeout: 60_000 },
  async (t) => {
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        telemetry: { enabled: false },
        workers: [
          {
            name: "storage-schema",
            modules: true,
            script: "export default {fetch(){return new Response('fixture')}}",
            compatibilityDate: "2026-11-03",
            compatibilityFlags: ["nodejs_compat"],
            d1Databases: ["DB"],
          },
        ],
      }),
    );
    t.after(() => mf.dispose());
    const raw = await mf.getD1Database("DB");
    await raw.exec(baseline.replace(/--[^\n]*/g, "").replace(/\r?\n/g, " "));
    if (migrations) await raw.exec(migrations.replace(/--[^\n]*/g, "").replace(/\r?\n/g, " "));
    await raw
      .prepare(
        "INSERT INTO members(id,email,role) VALUES('fixture_owner','fixture@example.com','admin')",
      )
      .run();
    const db = applicationDb(raw),
      definition = await insertTask(db, task({ accountId: null }));
    for (const id of ["device", "second"])
      await db
        .prepare("INSERT INTO devices(id,name,token_hash,protocol_version) VALUES(?,?,?,?)")
        .bind(id, id, id, PROTOCOL_VERSION)
        .run();
    await enqueue(db, definition, "workerd");
    await enqueue(db, definition, "workerd-second");
    const claims = await Promise.all([
      claim(db, "device", "claim"),
      claim(db, "second", "claim-second"),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const read = await raw
      .prepare(
        "SELECT id FROM tasks WHERE user_id='fixture_owner' AND deleted=0 ORDER BY created_at DESC,id DESC LIMIT 50",
      )
      .all();
    assert.equal(read.results.length, 1);
    assert.equal(typeof read.meta.rows_read, "number");
    assert.ok(read.meta.rows_read < 100);
    assert.deepEqual((await raw.prepare("PRAGMA foreign_key_check").all()).results, []);
    const plan = await raw
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE user_id='fixture_owner' AND deleted=0 ORDER BY created_at DESC,id DESC LIMIT 50",
      )
      .all<{ detail: string }>();
    assert.ok(plan.results.some((r) => r.detail.includes("tasks_visible")));
    assert.ok(!plan.results.some((r) => r.detail.includes("TEMP B-TREE")));
  },
);
