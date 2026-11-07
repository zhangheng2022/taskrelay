/** 通过真实离线命令和隔离数据库验证预检拒绝、幂等导出与容量报告，所有密钥均为合成夹具。 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  inspectSource,
  preflightSource,
  convertDatabase,
  verifyArchive,
} from "../scripts/db/convert";
import { seal } from "../apps/cloud/src/crypto";

const key = Buffer.alloc(32, 17).toString("base64");
function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "taskrelay-storage-entry-"));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  const source = path.join(directory, "source.sqlite"),
    db = new DatabaseSync(source);
  for (const file of readdirSync(new URL("../scripts/db/legacy-schema/", import.meta.url)).sort())
    db.exec(readFileSync(new URL("../scripts/db/legacy-schema/" + file, import.meta.url), "utf8"));
  return { directory, source, db };
}
function cli(args: string[], masterKey = key) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/db/convert.mjs", ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    env: { ...process.env, MASTER_KEY: masterKey },
  });
}

test("离线 CLI 检查、转换、重试和导出走同一生产入口，错误只返回固定分类", (t) => {
  const { directory, source, db } = fixture(t);
  db.close();
  const target = path.join(directory, "target.sqlite"),
    archive = path.join(directory, "archive.enc"),
    output = path.join(directory, "import.sql"),
    bindings = path.join(directory, "bindings.json");
  writeFileSync(bindings, "{}");
  assert.equal(cli([]).stderr.trim(), "SOURCE_REQUIRED");
  assert.match(cli(["--source", source]).stderr, /TARGET_AND_ARCHIVE_REQUIRED/);
  assert.match(cli(["--source", source, "--export"]).stderr, /TARGET_REQUIRED/);
  assert.match(cli(["--source", source, "--inspect"], "").stderr, /ENCRYPTION_KEY_NOT_CONFIGURED/);
  const inspected = cli(["--source", source, "--inspect"]);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).ownershipVerified, true);
  const args = [
    "--source",
    source,
    "--target",
    target,
    "--archive",
    archive,
    "--owner-bindings",
    bindings,
  ];
  for (let i = 0; i < 2; i++) assert.equal(cli(args).status, 0);
  assert.equal(cli(["--source", target, "--target", output, "--export"]).status, 0);
  const imported = new DatabaseSync(":memory:");
  try {
    imported.exec(
      readFileSync(
        new URL("../apps/cloud/migrations/0001_storage_v2.sql", import.meta.url),
        "utf8",
      ),
    );
    imported.exec("BEGIN");
    imported.exec(readFileSync(output, "utf8"));
    imported.exec("COMMIT");
    assert.deepEqual(imported.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(imported.prepare("SELECT version FROM storage_meta").get()!.version, 2);
  } finally {
    imported.close();
  }
  const broken = path.join(directory, "broken.sqlite");
  writeFileSync(broken, "not a database");
  assert.match(cli(["--source", broken, "--inspect"]).stderr, /STORAGE_CONVERSION_FAILED/);
});

test("只读预检拒绝额外表、额外列、丢失身份和外键错误，不静默丢弃数据", async (t) => {
  const cases = [
    ["CREATE TABLE unexpected(id TEXT)", "SOURCE_TABLES_UNSUPPORTED"],
    ["ALTER TABLE tasks ADD COLUMN unexpected TEXT", "SOURCE_COLUMNS_UNSUPPORTED"],
    [
      "INSERT INTO tasks(id,version,definition,status,created_at,updated_at) VALUES(NULL,1,'{}','paused','2026-01-01','2026-01-01')",
      "SOURCE_IDENTITY_MISSING",
    ],
    [
      "PRAGMA foreign_keys=OFF; INSERT INTO auth_session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES('session',1,'fixture',1,1,'missing')",
      "SOURCE_FOREIGN_KEYS_INVALID",
    ],
  ];
  for (const [sql, error] of cases) {
    const f = fixture(t);
    try {
      f.db.exec(sql);
      assert.throws(() => inspectSource(f.db), new RegExp(error));
    } finally {
      f.db.close();
    }
  }
  const f = fixture(t);
  try {
    await assert.rejects(preflightSource(f.db, ""), /ENCRYPTION_KEY_NOT_CONFIGURED/);
  } finally {
    f.db.close();
  }
});

test("转换路径、活跃 WAL 和损坏归档在目标发布前阻断", async (t) => {
  const { directory, source, db } = fixture(t);
  const target = path.join(directory, "target.sqlite"),
    archive = path.join(directory, "archive.enc");
  await assert.rejects(
    convertDatabase({ source, target: source, archive, masterKey: key }),
    /CONVERSION_PATH_CONFLICT/,
  );
  await assert.rejects(
    convertDatabase({ source, target, archive, masterKey: "" }),
    /ENCRYPTION_KEY_NOT_CONFIGURED/,
  );
  db.exec("PRAGMA journal_mode=WAL; INSERT INTO settings VALUES('wal-fixture','1')");
  try {
    await assert.rejects(
      convertDatabase({ source, target, archive, masterKey: key }),
      /SOURCE_WAL_REQUIRES_CHECKPOINT/,
    );
  } finally {
    db.close();
  }
  assert.equal(existsSync(target), false);
  writeFileSync(archive, "broken archive without header newline");
  await assert.rejects(verifyArchive(archive, key, "source"), /ARCHIVE_INVALID/);
  writeFileSync(
    archive,
    JSON.stringify({ version: 2, sourceDigest: "other" }) + "\n" + "x".repeat(32),
  );
  await assert.rejects(verifyArchive(archive, key, "source"), /ARCHIVE_SOURCE_CONFLICT/);
});

test("退休检查点及 pending write 分块仍验证完整 GCM、顺序与 token，缺片和错上下文不得通过", async (t) => {
  const { db } = fixture(t);
  try {
    const cipher = await seal(
      { type: "json", bytes: [123, 125] },
      key,
      "ai-checkpoint:legacy_owner",
    );
    const cut = Math.floor(cipher.length / 2),
      chunks = [cipher.slice(0, cut), cipher.slice(cut)];
    const marker = JSON.stringify({ v: 2, token: "pieces", parts: 2 });
    db.prepare(
      "INSERT INTO ai_checkpoints(owner,thread,ns,id,checkpoint,metadata,at) VALUES('legacy_owner','retired','','checkpoint',?,?,?)",
    ).run(marker, cipher, "2026-11-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO ai_writes(owner,thread,ns,checkpoint,task,path,idx,channel,value) VALUES('legacy_owner','retired','','checkpoint','task','',0,'channel',?)",
    ).run(marker);
    for (let part = 0; part < chunks.length; part++) {
      db.prepare(
        "INSERT INTO ai_checkpoint_chunks(owner,thread,ns,checkpoint,field,token,part,value) VALUES('legacy_owner','retired','','checkpoint','checkpoint','pieces',?,?)",
      ).run(part, chunks[part]);
      db.prepare(
        "INSERT INTO ai_write_chunks(owner,thread,ns,checkpoint,task,idx,token,part,value) VALUES('legacy_owner','retired','','checkpoint','task',0,'pieces',?,?)",
      ).run(part, chunks[part]);
    }
    db.prepare(
      "INSERT INTO ai_memories(owner,namespace,key,value,created_at,updated_at) VALUES('legacy_owner','preferences','fixture',?,'2026-11-01','2026-11-01')",
    ).run(await seal({ preference: "synthetic" }, key, "memory:legacy_owner:preferences:fixture"));
    assert.equal((await preflightSource(db, key)).encryptedValues, 4);
    db.exec("UPDATE ai_write_chunks SET token='unrelated' WHERE part=1");
    await assert.rejects(preflightSource(db, key), /SOURCE_CHECKPOINT_CHUNKS_MISSING/);
    db.exec("UPDATE ai_write_chunks SET token='pieces',part=3 WHERE part=1");
    await assert.rejects(preflightSource(db, key), /SOURCE_CHECKPOINT_CHUNKS_MISSING/);
    db.exec("UPDATE ai_write_chunks SET part=1 WHERE part=3");
    db.prepare("UPDATE ai_checkpoints SET checkpoint=?").run(
      JSON.stringify({ v: 2, token: "pieces", parts: 0 }),
    );
    await assert.rejects(preflightSource(db, key), /SOURCE_CHECKPOINT_CHUNKS_MISSING/);
    db.prepare("UPDATE ai_checkpoints SET checkpoint=?").run(
      JSON.stringify({ v: 2, token: "pieces", parts: "2" }),
    );
    await assert.rejects(preflightSource(db, key), /SOURCE_CHECKPOINT_CHUNKS_MISSING/);
    db.prepare("UPDATE ai_checkpoints SET checkpoint=?").run(marker);
    db.prepare("UPDATE ai_memories SET value=?").run(
      await seal({}, key, "memory:other:preferences:fixture"),
    );
    await assert.rejects(preflightSource(db, key));
  } finally {
    db.close();
  }
});

for (const file of ["benchmark.mjs", "d1-benchmark.mjs"]) {
  test(`容量命令 ${file} 生成可核验的两版隔离报告，非法规模拒绝运行`, () => {
    for (const scales of ["0", "1000,10", "bad", "1000001"]) {
      const bad = spawnSync(process.execPath, [`scripts/db/${file}`, "--scales", scales], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
      });
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /BENCHMARK_SCALES_INVALID/);
    }
    const result = spawnSync(process.execPath, [`scripts/db/${file}`, "--scales", "1000"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 90000,
    });
    assert.equal(result.status, 0, result.stderr);
    const location = result.stdout.trim().split(/\r?\n/).at(-1)!;
    assert.ok(path.resolve(location).startsWith(path.resolve(".cache/db-capacity") + path.sep));
    const report = JSON.parse(readFileSync(location, "utf8"));
    assert.equal(report.results.length, 2);
    for (const row of report.results) {
      assert.ok(row.bytes > 0);
      assert.ok(Object.keys(row.queries).length >= 6);
      if (file === "d1-benchmark.mjs") {
        assert.ok(row.loadRowsWritten > 0);
        for (const query of Object.values(row.queries) as { rowsRead: number }[])
          assert.ok(query.rowsRead >= 0);
      }
    }
  });
}

test("凭据版本是预检权威，协助密文按原运行与记录 AAD 校验，公开问题可不带密文字段", async (t) => {
  const { db } = fixture(t);
  try {
    const credentials = await seal(
      { username: "fixture", password: "synthetic" },
      key,
      "account:account",
    );
    db.prepare(
      "INSERT INTO accounts(id,name,origin,username_hint,secret,created_at) VALUES('account','fixture','https://fixture.invalid','f',?,'2026-11-01')",
    ).run(credentials);
    db.prepare(
      "INSERT INTO account_credential_versions(account_id,version,secret,login_origins,created_at) VALUES('account',1,?,'[]','2026-11-01')",
    ).run(credentials);
    db.exec(
      "INSERT INTO tasks(id,version,definition,status,created_at,updated_at) VALUES('task',1,'{}','paused','2026-11-01','2026-11-01'); INSERT INTO runs(id,task_id,task_snapshot,status,scheduled_for,deadline,account_key,idempotency_key,created_at,updated_at) VALUES('run','task','{}','succeeded','2026-11-01','2026-11-01','task:task','fixture','2026-11-01','2026-11-01'); INSERT INTO ai_threads(id,user_id,kind,model_id,model_version,created_at,updated_at) VALUES('thread','legacy_owner','compose','fixture',1,'2026-11-01','2026-11-01')",
    );
    db.prepare(
      "INSERT INTO execution_help(id,run_id,thread_id,epoch,request,response,created_at) VALUES('help','run','thread',0,?,?,'2026-11-01')",
    ).run(
      JSON.stringify({
        encryptedMessage: await seal("synthetic question", key, "help-request:run:help"),
      }),
      JSON.stringify({ encrypted: await seal("synthetic reply", key, "help:run:help") }),
    );
    assert.equal((await preflightSource(db, key)).encryptedValues, 3);
    db.prepare("UPDATE accounts SET secret=? WHERE id='account'").run(
      await seal({ username: "different" }, key, "account:account"),
    );
    await assert.rejects(preflightSource(db, key), /SOURCE_CREDENTIAL_VERSION_CONFLICT/);
    db.prepare("UPDATE accounts SET secret=? WHERE id='account'").run(credentials);
    db.exec(
      `UPDATE execution_help SET request='{"message":"public question"}',response='{"message":"public answer"}'`,
    );
    assert.equal((await preflightSource(db, key)).encryptedValues, 1);
    db.exec("UPDATE execution_help SET request='[]'");
    await assert.rejects(preflightSource(db, key), /SOURCE_JSON_INVALID/);
  } finally {
    db.close();
  }
});
