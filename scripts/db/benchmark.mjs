/** 隔离 SQLite 结构/查询容量比较；全部数据为合成夹具，不连接 Cloudflare 或真实模型。
 * 输出本机 p50/p95、空间和查询计划；本机 SQLite 不提供 D1 rows_read/written，不伪造平台指标。 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
const folder = path.resolve(".cache/db-capacity", new Date().toISOString().replaceAll(":", "-"));
mkdirSync(folder, { recursive: true });
const scales = [1_000, 100_000, 1_000_000],
  results = [];
function measure(db, sql, args) {
  const samples = [];
  for (let i = 0; i < 70; i++) {
    const start = performance.now();
    db.prepare(sql).all(...args);
    if (i >= 10) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    p50Ms: samples[Math.floor(samples.length * 0.5)],
    p95Ms: samples[Math.floor(samples.length * 0.95)],
    plan: db
      .prepare("EXPLAIN QUERY PLAN " + sql)
      .all(...args)
      .map((r) => r.detail),
  };
}
for (const variant of ["v1", "v2"]) {
  const db = new DatabaseSync(path.join(folder, variant + ".sqlite"));
  if (variant === "v1")
    for (const name of readdirSync(new URL("./legacy-schema/", import.meta.url)).sort())
      db.exec(readFileSync(new URL("./legacy-schema/" + name, import.meta.url), "utf8"));
  else
    db.exec(
      readFileSync(
        new URL("../../apps/cloud/migrations/0001_storage_v2.sql", import.meta.url),
        "utf8",
      ),
    );
  db.exec(
    "PRAGMA journal_mode=MEMORY;PRAGMA synchronous=OFF;BEGIN IMMEDIATE;PRAGMA defer_foreign_keys=ON",
  );
  const at = Date.parse("2026-11-01T00:00:00Z"),
    members = db.prepare("INSERT INTO members(id,email) VALUES(?,?)");
  for (let i = 0; i < 1000; i++) members.run("user_" + i, "fixture_" + i + "@example.com");
  for (let i = 0; i < 100; i++)
    db.prepare("INSERT INTO devices(id,name,token_hash,protocol_version) VALUES(?,?,?,?)").run(
      "device_" + i,
      "synthetic device " + i,
      "synthetic-hash-" + i,
      variant === "v1" ? 17 : 18,
    );
  const modelTable = variant === "v1" ? "model_profiles" : "model_profile_versions";
  db.prepare(
    `INSERT INTO ${modelTable}(id,version,config,secret,capabilities,created_at) VALUES('model',1,'{}','synthetic-cipher','{}',?)`,
  ).run(variant === "v1" ? new Date(at).toISOString() : at);
  for (let i = 0; i < 1060; i++) {
    const owner = i < 1000 ? "user_" + i : "user_0",
      id = "task_" + i,
      thread = "thread_" + i,
      time = variant === "v1" ? new Date(at + i).toISOString() : at + i;
    const def = JSON.stringify({
      id,
      version: 1,
      title: "Synthetic task",
      modelId: "model",
      modelVersion: 1,
      schedule: { kind: "manual" },
    });
    if (variant === "v1")
      db.prepare(
        "INSERT INTO tasks(id,version,definition,status,user_id,created_at,updated_at) VALUES(?,1,?,'paused',?,?,?)",
      ).run(id, def, owner, time, time);
    else
      db.prepare(
        "INSERT INTO tasks(id,version,title,schedule_kind,status,user_id,created_at,updated_at) VALUES(?,1,'Synthetic task','manual','paused',?,?,?)",
      ).run(id, owner, time, time);
    if (variant === "v1") db.prepare("INSERT INTO task_versions VALUES(?,1,?)").run(id, def);
    else
      db.prepare(
        "INSERT INTO task_versions(task_id,version,definition,user_id,model_id,model_version) VALUES(?,1,?,?,'model',1)",
      ).run(id, def, owner);
    db.prepare(
      "INSERT INTO ai_threads(id,user_id,task_id,kind,model_id,model_version,created_at,updated_at) VALUES(?,?,?,'chat','model',1,?,?)",
    ).run(thread, owner, id, time, time);
    if (variant === "v1")
      db.prepare(
        "INSERT INTO runs(id,task_id,task_snapshot,status,scheduled_for,deadline,account_key,idempotency_key,created_at,updated_at,user_id,thread_id) VALUES(?,?,?,'succeeded',?,?,?,?,?,?,?,?)",
      ).run(
        "run_" + i,
        id,
        def,
        time,
        time,
        "task:" + id,
        "run_request_" + i,
        time,
        time,
        owner,
        thread,
      );
    else {
      db.prepare(
        "INSERT INTO runs(id,task_id,task_version,status,scheduled_for,deadline,account_key,idempotency_key,created_at,updated_at,user_id,thread_id) VALUES(?,?,1,'succeeded',?,?,?,?,?,?,?,?)",
      ).run(
        "run_" + i,
        id,
        time,
        time,
        "task:" + id,
        "run_request_" + i,
        time,
        time,
        owner,
        thread,
      );
      db.prepare("INSERT INTO run_snapshots(run_id,task_snapshot) VALUES(?,?)").run(
        "run_" + i,
        def,
      );
    }
  }
  db.exec("COMMIT");
  const oldInsert =
    variant === "v1"
      ? db.prepare(
          "INSERT INTO ai_messages(id,thread_id,seq,role,content,turn_id,at,source,parts,run_id) VALUES(?,?,?,'assistant',?,'turn',?,'executor',?,?)",
        )
      : null;
  const meta =
    variant === "v2"
      ? db.prepare(
          "INSERT INTO ai_messages(id,thread_id,seq,role,turn_id,at,source,run_id) VALUES(?,?,?,'assistant','turn',?,'executor',?)",
        )
      : null;
  const body =
    variant === "v2"
      ? db.prepare("INSERT INTO message_bodies(id,content,parts) VALUES(?,?,?)")
      : null;
  const usage = db.prepare(
    "INSERT INTO model_usage(id,run_id,model_id,model_version,input_tokens,output_tokens,at,user_id) VALUES(?,?,'model',1,100,20,?,?)",
  );
  const artifact = db.prepare(
    "INSERT INTO artifacts(id,run_id,thread_id,object_key,content_type,expires_at) VALUES(?,?,?,?,'image/png',?)",
  );
  const graph = db.prepare(
    "INSERT INTO ai_graph_inputs(owner,id,digest,parent_thread,created_at,active) VALUES(?,?,'digest',?,?,0)",
  );
  const content = "合成执行记录：" + "x".repeat(240),
    parts = JSON.stringify([{ type: "tool", name: "observe", result: "synthetic feedback" }]);
  let inserted = 0;
  for (const scale of scales) {
    const start = performance.now();
    db.exec("BEGIN IMMEDIATE");
    for (let i = inserted; i < scale; i++) {
      const entity = i % 1000,
        id = "message_" + i,
        thread = "thread_" + entity,
        run = "run_" + entity,
        owner = "user_" + entity,
        seq = Math.floor(i / 1000) + 1,
        time = variant === "v1" ? new Date(at + i).toISOString() : at + i;
      if (oldInsert) oldInsert.run(id, thread, seq, content, time, parts, run);
      else {
        meta.run(id, thread, seq, time, run);
        body.run(id, content, parts);
      }
      if (i % 10 === 0) usage.run("usage_" + i, run, time, owner);
      if (i % 20 === 0) artifact.run("image_" + i, run, thread, "object_" + i, time);
      if (i % 20 === 1) graph.run(owner, "graph_" + i, thread, time);
    }
    db.exec("COMMIT");
    inserted = scale;
    const bytes =
      Number(db.prepare("PRAGMA page_count").get().page_count) *
      Number(db.prepare("PRAGMA page_size").get().page_size);
    const query = {
      tasks: measure(
        db,
        "SELECT id FROM tasks WHERE user_id=? AND deleted=0 ORDER BY created_at DESC,id DESC LIMIT 50",
        ["user_0"],
      ),
      threads: measure(
        db,
        "SELECT id FROM ai_threads WHERE user_id=? AND closed=0 ORDER BY updated_at DESC,id DESC LIMIT 50",
        ["user_0"],
      ),
      messages: measure(
        db,
        `SELECT id,seq FROM ai_messages WHERE thread_id=? AND seq<? ORDER BY seq DESC LIMIT 50`,
        ["thread_0", Number.MAX_SAFE_INTEGER],
      ),
      usage: measure(db, "SELECT id,input_tokens,output_tokens FROM model_usage WHERE run_id=?", [
        "run_0",
      ]),
      artifacts: measure(db, "SELECT id,object_key FROM artifacts WHERE thread_id=? LIMIT 10", [
        "thread_0",
      ]),
      graphs: measure(db, "SELECT id FROM ai_graph_inputs WHERE parent_thread=?", ["thread_1"]),
    };
    const pages = db
      .prepare("SELECT name,sum(pgsize) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC")
      .all();
    const indexBytes = pages
      .filter((p) =>
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(p.name),
      )
      .reduce((n, p) => n + p.bytes, 0);
    results.push({
      variant,
      messages: scale,
      users: Number(db.prepare("SELECT count(*) n FROM members").get().n),
      devices: Number(db.prepare("SELECT count(*) n FROM devices").get().n),
      bytes,
      indexBytes,
      tableBytes: bytes - indexBytes,
      freeSingleDatabaseExceeded: bytes > 500_000_000,
      loadMs: performance.now() - start,
      queries: query,
      rowsRead: null,
      rowsWritten: null,
      indexes: db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='index'").get().n,
    });
    console.log(JSON.stringify({ variant, messages: scale, bytes }));
  }
  db.close();
}
const report = {
  createdAt: new Date().toISOString(),
  schemaDigest: createHash("sha256")
    .update(
      readFileSync(new URL("../../apps/cloud/migrations/0001_storage_v2.sql", import.meta.url)),
    )
    .digest("hex"),
  environment: {
    node: process.version,
    platform: process.platform,
    scope: "local SQLite; synthetic data; not deployed D1 latency or daily throughput",
    loaderDurability:
      "MEMORY/OFF used only to generate synthetic data; loadMs is not production write performance",
  },
  results,
};
writeFileSync(path.join(folder, "report.json"), JSON.stringify(report, null, 2));
console.log(path.join(folder, "report.json"));
