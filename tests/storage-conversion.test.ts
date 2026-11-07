import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { convertDatabase, inspectSource, verifyArchive } from "../scripts/db/convert";
import { seal, unseal } from "../apps/cloud/src/crypto";
import { convertJournal } from "../apps/desktop/src/main/convert-journal";
import { Journal } from "../apps/desktop/src/main/journal";
import { exportDatabase } from "../scripts/db/export";
import { createHash } from "node:crypto";

test("离线转换保留身份、密文、unknown 锁和可见历史，退休图归档，重复转换不覆盖", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "taskrelay-storage-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "old.sqlite"),
    target = path.join(directory, "new.sqlite"),
    archive = path.join(directory, "archive.enc"),
    masterKey = Buffer.alloc(32, 7).toString("base64");
  const old = new DatabaseSync(source);
  for (const name of readdirSync(new URL("../scripts/db/legacy-schema/", import.meta.url)).sort())
    old.exec(readFileSync(new URL("../scripts/db/legacy-schema/" + name, import.meta.url), "utf8"));
  const date = "2026-11-01T00:00:00.000Z",
    definition = JSON.stringify({
      id: "task",
      version: 1,
      title: "历史任务",
      goal: "测试",
      modelId: "model",
      modelVersion: 1,
      schedule: { kind: "manual" },
    });
  old
    .prepare("INSERT INTO model_profiles VALUES(?,?,?,?,?,?)")
    .run("model", 1, "{}", await seal("key", masterKey, "model:model:1"), "{}", date);
  old
    .prepare(
      "INSERT INTO tasks(id,version,definition,status,created_at,updated_at) VALUES('task',1,?,'paused',?,?)",
    )
    .run(definition, date, date);
  old.prepare("INSERT INTO task_versions VALUES('task',1,?)").run(definition);
  old
    .prepare(
      "INSERT INTO ai_threads(id,user_id,task_id,kind,model_id,model_version,created_at,updated_at) VALUES('thread','legacy_owner','task','chat','model',1,?,?)",
    )
    .run(date, date);
  old
    .prepare(
      "INSERT INTO runs(id,task_id,task_snapshot,status,scheduled_for,deadline,account_key,idempotency_key,created_at,updated_at,thread_id) VALUES('run','task',?,'unknown',?,?,'task:task','request',?,?,'thread')",
    )
    .run(definition, date, date, date, date);
  old.exec("INSERT INTO account_locks VALUES('task:task','run')");
  old
    .prepare(
      "INSERT INTO conversations(id,task_id,role,content,at) VALUES('early','task','user','早期消息',?)",
    )
    .run(date);
  old
    .prepare(
      "INSERT INTO ai_messages(id,thread_id,seq,role,content,turn_id,at,run_id) VALUES('reply','thread',1,'user','测试敏感原文','turn',?,'run')",
    )
    .run(date);
  old
    .prepare(
      "INSERT INTO ai_messages(id,thread_id,seq,role,content,turn_id,at,run_id,parts) VALUES('echo','thread',2,'assistant','正在填写测试敏感原文','turn',?,'run',?)",
    )
    .run(
      date,
      JSON.stringify([
        { type: "tool", name: "act", result: JSON.stringify({ value: "测试敏感原文" }) },
      ]),
    );
  old
    .prepare(
      "INSERT INTO ai_graph_inputs(owner,id,digest,parent_thread,created_at) VALUES('legacy_owner','graph','digest','thread',?)",
    )
    .run(date);
  old
    .prepare(
      "INSERT INTO ai_checkpoints(owner,thread,ns,id,checkpoint,metadata,at) VALUES('legacy_owner','graph','','checkpoint',?,?,?)",
    )
    .run(
      await seal({ type: "json", bytes: [123, 125] }, masterKey, "ai-checkpoint:legacy_owner"),
      await seal({ source: "legacy" }, masterKey, "ai-checkpoint:legacy_owner"),
      date,
    );
  assert.equal(inspectSource(old).length, 54);
  old.close();
  await assert.rejects(
    convertDatabase({ source, target, archive, masterKey: Buffer.alloc(32, 8).toString("base64") }),
  );
  assert.equal(existsSync(target), false);
  const sourceDigest = createHash("sha256").update(readFileSync(source)).digest("hex");
  writeFileSync(target + ".partial", "interrupted sqlite");
  writeFileSync(target + ".partial.json", JSON.stringify({ version: 2, sourceDigest }));
  writeFileSync(
    archive + ".partial",
    JSON.stringify({ version: 1, sourceDigest, iv: Buffer.alloc(12).toString("base64") }) +
      "\npartial",
  );
  const result = await convertDatabase({ source, target, archive, masterKey });
  assert.equal(result.version, 2);
  assert.equal(result.readyForCutover, false);
  await verifyArchive(archive, masterKey, result.sourceDigest);
  const fresh = new DatabaseSync(target, { readOnly: true });
  try {
    assert.equal(fresh.prepare("SELECT status FROM runs WHERE id='run'").get()!.status, "unknown");
    assert.equal(fresh.prepare("SELECT run_id FROM account_locks").get()!.run_id, "run");
    assert.equal(fresh.prepare("SELECT count(*) n FROM ai_checkpoints").get()!.n, 0);
    assert.equal(fresh.prepare("SELECT active FROM ai_graph_inputs").get()!.active, 0);
    const row = fresh.prepare("SELECT * FROM message_details WHERE id='reply'").get()!;
    assert.equal(
      await unseal(String(row.private_content), masterKey, "message:thread:reply"),
      "测试敏感原文",
    );
    assert.equal(fresh.prepare("SELECT count(*) n FROM ai_messages").get()!.n, 3);
    const echo = fresh.prepare("SELECT * FROM message_details WHERE id='echo'").get()!;
    assert.ok(echo.private_content);
    assert.ok(String(echo.parts).includes("[已隐藏]"));
    assert.ok(!JSON.stringify(echo).includes("测试敏感原文"));
    assert.equal(fresh.prepare("SELECT typeof(created_at) t FROM runs").get()!.t, "integer");
    assert.deepEqual(fresh.prepare("PRAGMA foreign_key_check").all(), []);
    for (const table of [
      "conversations",
      "challenges",
      "assistance_replies",
      "run_events",
      "batch_progress",
      "ai_plan_steps",
      "ai_cutovers",
    ])
      assert.equal(
        fresh.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),
        undefined,
      );
  } finally {
    fresh.close();
  }
  assert.equal((await convertDatabase({ source, target, archive, masterKey })).reused, true);
  await assert.rejects(
    convertDatabase({ source, target, archive, masterKey: Buffer.alloc(32, 8).toString("base64") }),
  );
  const exported = path.join(directory, "import.sql");
  exportDatabase(target, exported);
  const loaded = new DatabaseSync(":memory:");
  try {
    loaded.exec(
      readFileSync(
        new URL("../apps/cloud/migrations/0001_storage_v2.sql", import.meta.url),
        "utf8",
      ),
    );
    loaded.exec("BEGIN");
    loaded.exec(readFileSync(exported, "utf8"));
    loaded.exec("COMMIT");
    assert.deepEqual(loaded.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(loaded.prepare("SELECT count(*) n FROM ai_messages").get()!.n, 3);
    assert.throws(() => loaded.exec(readFileSync(exported, "utf8")), /CHECK/);
  } finally {
    loaded.close();
  }
});

test("导出分块还原长 JSON 和 Unicode，源/目标异常阻断导出，不修改原库", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "taskrelay-export-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source.sqlite"),
    file = path.join(dir, "import.sql");
  const db = new DatabaseSync(source);
  db.exec(
    readFileSync(new URL("../apps/cloud/migrations/0001_storage_v2.sql", import.meta.url), "utf8"),
  );
  const content = JSON.stringify({ text: "汉字𠮷😀'\n;".repeat(25_000) });
  db.prepare("INSERT INTO settings VALUES('storageFrozen','1')").run();
  db.prepare("INSERT INTO settings VALUES('fixture',?)").run(content);
  db.close();
  const report = exportDatabase(source, file);
  assert.equal(exportDatabase(source, file).digest, report.digest);
  const copy = new DatabaseSync(":memory:");
  try {
    copy.exec(
      readFileSync(
        new URL("../apps/cloud/migrations/0001_storage_v2.sql", import.meta.url),
        "utf8",
      ),
    );
    copy.exec("BEGIN");
    copy.exec(readFileSync(file, "utf8"));
    copy.exec("COMMIT");
    assert.equal(
      copy.prepare("SELECT value FROM settings WHERE key='fixture'").get()!.value,
      content,
    );
  } finally {
    copy.close();
  }
  writeFileSync(file, "changed");
  assert.throws(() => exportDatabase(source, file), /EXPORT_TARGET_CHANGED/);
});

test("转换拒绝未排空源库，不创建目标和归档", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "taskrelay-drain-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.sqlite"),
    target = path.join(directory, "target.sqlite"),
    archive = path.join(directory, "archive.enc"),
    db = new DatabaseSync(source);
  for (const name of readdirSync(new URL("../scripts/db/legacy-schema/", import.meta.url)).sort())
    db.exec(readFileSync(new URL("../scripts/db/legacy-schema/" + name, import.meta.url), "utf8"));
  db.exec(
    "INSERT INTO history_cleanup_jobs(id,user_id,request_id,scope,created_at,updated_at,status) VALUES('job','legacy_owner','req','all','2026-01-01','2026-01-01','pending')",
  );
  db.close();
  await assert.rejects(
    convertDatabase({ source, target, archive, masterKey: Buffer.alloc(32, 7).toString("base64") }),
    /SOURCE_NOT_DRAINED/,
  );
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(archive), false);
});

test("桌面离线转换保留配置、待确认回执和检查点，正常 Main 拒绝旧结构", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "taskrelay-journal-v4-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(directory, "taskrelay.sqlite"));
  db.exec(
    "CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE journal(run_id TEXT PRIMARY KEY,generation TEXT NOT NULL,epoch INTEGER NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE outbox(id TEXT PRIMARY KEY,path TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);PRAGMA user_version=3",
  );
  db.exec(
    `INSERT INTO config VALUES('token','"opaque-safeStorage"');INSERT INTO cache VALUES('old','{}');INSERT INTO journal VALUES('run','generation',2,'unknown','{}','2026-11-01T00:00:00.000Z');INSERT INTO outbox VALUES('receipt','/finish','{"epoch":2}','2026-11-01T00:00:00.000Z')`,
  );
  db.close();
  assert.throws(() => new Journal(directory), /LOCAL_STORAGE_CONVERSION_REQUIRED/);
  writeFileSync(path.join(directory, "taskrelay-v4.sqlite.partial"), "interrupted sqlite");
  writeFileSync(
    path.join(directory, "taskrelay-v4.sqlite.partial.json"),
    JSON.stringify({
      version: 4,
      sourceDigest: createHash("sha256")
        .update(readFileSync(path.join(directory, "taskrelay.sqlite")))
        .digest("hex"),
    }),
  );
  assert.deepEqual(convertJournal(directory), { converted: true, version: 4 });
  assert.deepEqual(convertJournal(directory), { converted: false, version: 4 });
  const journal = new Journal(directory);
  try {
    assert.equal(journal.get("token"), "opaque-safeStorage");
    assert.equal(journal.pending()[0].id, "receipt");
    assert.equal(journal.incomplete()[0].generation, "generation");
    assert.equal(journal.cached("old"), null);
    assert.equal(journal.diagnostic().schema, 4);
  } finally {
    journal.close();
  }
});
