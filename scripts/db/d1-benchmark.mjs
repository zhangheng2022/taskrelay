/** 实际本机 workerd/D1 的隔离容量与读写行数对照；只使用合成数据，不连接 Cloudflare 账号或模型。
 * 本机 RPC 时延含 Miniflare 桥接，不等于部署延迟、计费量或生产并发保证。 */
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";
const output = path.resolve(
  ".cache/db-capacity",
  "workerd-" + new Date().toISOString().replaceAll(":", "-"),
);
mkdirSync(output, { recursive: true });
const results = [],
  at = 1793491200000;
const numbers = (from, to) =>
  `WITH RECURSIVE n(x) AS(SELECT ${from} UNION ALL SELECT x+1 FROM n WHERE x<${to})`;
const text = "'合成执行记录：" + "x".repeat(240) + "'",
  parts = JSON.stringify([
    { type: "tool", name: "observe", result: "synthetic feedback" },
  ]).replaceAll("'", "''");
for (const version of ["v1", "v2"]) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
      workers: [
        {
          name: "isolated-capacity",
          modules: true,
          script: 'export default{fetch(){return new Response("fixture")}}',
          compatibilityDate: "2026-11-03",
          d1Databases: ["DB"],
        },
      ],
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    const schema =
      version === "v2"
        ? readFileSync(
            new URL("../../apps/cloud/migrations/0001_storage_v2.sql", import.meta.url),
            "utf8",
          )
        : readdirSync(new URL("./legacy-schema/", import.meta.url))
            .sort()
            .map((n) => readFileSync(new URL("./legacy-schema/" + n, import.meta.url), "utf8"))
            .join("\n");
    await db.exec(schema.replace(/--[^\n]*/g, "").replace(/\r?\n/g, " "));
    const time = (expr) =>
      version === "v2"
        ? `${at}+${expr}`
        : `strftime('%Y-%m-%dT%H:%M:%fZ',(${at}+${expr})/1000.0,'unixepoch')`;
    const model = version === "v2" ? "model_profile_versions" : "model_profiles";
    await db
      .prepare(
        `${numbers(0, 999)} INSERT INTO members(id,email) SELECT 'user_'||x,'synthetic_'||x||'@example.invalid' FROM n`,
      )
      .run();
    await db
      .prepare(
        `${numbers(0, 99)} INSERT INTO devices(id,name,token_hash,protocol_version) SELECT 'device_'||x,'synthetic','hash_'||x,${version === "v2" ? 18 : 17} FROM n`,
      )
      .run();
    await db
      .prepare(`INSERT INTO ${model} VALUES('model',1,'{}','synthetic-cipher','{}',${time(0)})`)
      .run();
    const task =
      version === "v2"
        ? `INSERT INTO tasks(id,version,title,schedule_kind,status,user_id,created_at,updated_at) SELECT 'task_'||x,1,'synthetic','manual','paused','user_'||CASE WHEN x<1000 THEN x ELSE 0 END,${time("x")},${time("x")} FROM n`
        : `INSERT INTO tasks(id,version,definition,status,user_id,created_at,updated_at) SELECT 'task_'||x,1,'{}','paused','user_'||CASE WHEN x<1000 THEN x ELSE 0 END,${time("x")},${time("x")} FROM n`;
    await db.batch([
      db.prepare(numbers(0, 1059) + " " + task),
      db.prepare(
        numbers(0, 1059) +
          (version === "v2"
            ? " INSERT INTO task_versions(task_id,version,definition,user_id,model_id,model_version) SELECT 'task_'||x,1,'{}','user_'||CASE WHEN x<1000 THEN x ELSE 0 END,'model',1 FROM n"
            : " INSERT INTO task_versions SELECT 'task_'||x,1,'{}' FROM n"),
      ),
    ]);
    await db
      .prepare(
        `${numbers(0, 1059)} INSERT INTO ai_threads(id,user_id,task_id,kind,model_id,model_version,created_at,updated_at) SELECT 'thread_'||x,'user_'||CASE WHEN x<1000 THEN x ELSE 0 END,'task_'||x,'chat','model',1,${time("x")},${time("x")} FROM n`,
      )
      .run();
    await db
      .prepare(
        `${numbers(0, 1059)} INSERT INTO runs(id,task_id,${version === "v2" ? "task_version" : "task_snapshot"},status,scheduled_for,deadline,account_key,idempotency_key,created_at,updated_at,user_id,thread_id) SELECT 'run_'||x,'task_'||x,${version === "v2" ? 1 : "'{}'"},'succeeded',${time("x")},${time("x")},'task:task_'||x,'request_'||x,${time("x")},${time("x")},'user_'||CASE WHEN x<1000 THEN x ELSE 0 END,'thread_'||x FROM n`,
      )
      .run();
    let inserted = 0;
    for (const scale of [1_000, 100_000, 1_000_000]) {
      let rowsRead = 0,
        rowsWritten = 0;
      const start = performance.now();
      for (let from = inserted + 1; from <= scale; from += 10_000) {
        const n = numbers(from, Math.min(from + 9999, scale)),
          entity = "((x-1)%1000)",
          seq = "CAST((x-1)/1000 AS INTEGER)+1";
        const statements = [
          version === "v2"
            ? `${n} INSERT INTO ai_messages(id,thread_id,seq,role,turn_id,at,source,run_id) SELECT 'msg_'||x,'thread_'||${entity},${seq},'assistant','turn',${time("x")},'executor','run_'||${entity} FROM n`
            : `${n} INSERT INTO ai_messages(id,thread_id,seq,role,content,turn_id,at,source,parts,run_id) SELECT 'msg_'||x,'thread_'||${entity},${seq},'assistant',${text},'turn',${time("x")},'executor','${parts}','run_'||${entity} FROM n`,
        ];
        if (version === "v2")
          statements.push(
            `${n} INSERT INTO message_bodies(id,content,parts) SELECT 'msg_'||x,${text},'${parts}' FROM n`,
          );
        statements.push(
          `${n} INSERT INTO model_usage(id,run_id,model_id,model_version,input_tokens,output_tokens,at,user_id) SELECT 'usage_'||x,'run_'||${entity},'model',1,100,20,${time("x")},'user_'||${entity} FROM n WHERE x%10=0`,
          `${n} INSERT INTO artifacts(id,run_id,thread_id,object_key,content_type,expires_at) SELECT 'image_'||x,'run_'||${entity},'thread_'||${entity},'object_'||x,'image/png',${time("x")} FROM n WHERE x%20=0`,
          `${n} INSERT INTO ai_graph_inputs(owner,id,digest,parent_thread,created_at,active) SELECT 'user_'||${entity},'graph_'||x,'digest','thread_'||${entity},${time("x")},0 FROM n WHERE x%20=1`,
        );
        for (const result of await db.batch(statements.map((sql) => db.prepare(sql)))) {
          rowsRead += result.meta.rows_read;
          rowsWritten += result.meta.rows_written;
        }
      }
      const loadMs = performance.now() - start;
      inserted = scale;
      const queries = {};
      /** @type {Array<[string,string,Array<string|number>]>} */
      const cases = [
        [
          "tasks",
          "SELECT id FROM tasks WHERE user_id=? AND deleted=0 ORDER BY created_at DESC,id DESC LIMIT 50",
          ["user_0"],
        ],
        [
          "threads",
          "SELECT id FROM ai_threads WHERE user_id=? AND closed=0 ORDER BY updated_at DESC,id DESC LIMIT 50",
          ["user_0"],
        ],
        [
          "messages",
          "SELECT id,seq FROM ai_messages WHERE thread_id=? AND seq<? ORDER BY seq DESC LIMIT 50",
          ["thread_0", Number.MAX_SAFE_INTEGER],
        ],
        [
          "usage",
          "SELECT id,input_tokens,output_tokens FROM model_usage WHERE run_id=?",
          ["run_9"],
        ],
        [
          "artifacts",
          "SELECT id,object_key FROM artifacts WHERE thread_id=? LIMIT 10",
          ["thread_19"],
        ],
        ["graphs", "SELECT id FROM ai_graph_inputs WHERE parent_thread=?", ["thread_0"]],
      ];
      for (const [name, sql, params] of cases) {
        const samples = [];
        let meta;
        for (let i = 0; i < 24; i++) {
          const began = performance.now(),
            r = await db
              .prepare(sql)
              .bind(...params)
              .all();
          if (i >= 4) samples.push(performance.now() - began);
          meta = r.meta;
        }
        samples.sort((a, b) => a - b);
        queries[name] = {
          p50Ms: samples[10],
          p95Ms: samples[19],
          rowsRead: meta.rows_read,
          rowsWritten: meta.rows_written,
          sizeAfter: meta.size_after,
          plan: (
            await db
              .prepare("EXPLAIN QUERY PLAN " + sql)
              .bind(...params)
              .all()
          ).results,
        };
      }
      const result = {
        version,
        messages: scale,
        users: version === "v1" ? 1001 : 1000,
        devices: 100,
        bytes: queries.graphs.sizeAfter ?? null,
        loadMs,
        loadRowsRead: rowsRead,
        loadRowsWritten: rowsWritten,
        queries,
      };
      results.push(result);
      console.log(JSON.stringify({ version, scale, bytes: result.bytes, rowsWritten }));
      writeFileSync(
        path.join(output, "report.json"),
        JSON.stringify(
          {
            scope:
              "isolated local workerd/D1; synthetic; not deployed concurrency/latency/billing evidence",
            results,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    await mf.dispose();
  }
}
console.log(path.join(output, "report.json"));
