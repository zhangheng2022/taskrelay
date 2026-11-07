/** v1 → v2 离线转换：只读冻结的旧 SQLite，写独立目标、加密原库归档和无秘密清单。
 * 生产代码不导入本模块。异常/未映射数据阻断切换；保留 ID、MASTER_KEY、unknown 和对象键。 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { Writable } from "node:stream";
import { packCallCipher } from "../../apps/cloud/src/call-cache";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { seal, unseal } from "../../apps/cloud/src/crypto";

type Row = Record<string, SQLInputValue>;
function scalarText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint")
    return String(value);
  throw Error("SOURCE_FIELD_INVALID");
}
type Options = {
  source: string;
  target: string;
  archive: string;
  masterKey: string;
  ownerBindings?: Record<string, string>;
};
const retired = new Set([
  "conversations",
  "run_events",
  "challenges",
  "assistance_replies",
  "batch_progress",
  "ai_cutovers",
  "ai_plan_steps",
  "ai_checkpoints",
  "ai_writes",
  "ai_checkpoint_chunks",
  "ai_write_chunks",
]);
const omitted: Record<string, string[]> = {
  account_cards: ["superseded_by"],
  tasks: ["definition"],
  runs: ["task_snapshot", "result"],
  accounts: ["secret", "login_origins"],
  ai_messages: ["content", "private_content", "parts"],
  ai_calls: ["result"],
  actions: ["fingerprint", "batch_item_id", "batch_terminal", "authentication"],
  devices: ["cutover_ready_at"],
};
const times = new Set([
  "at",
  "created_at",
  "updated_at",
  "next_run_at",
  "scheduled_for",
  "deadline",
  "last_seen",
  "last_claim_at",
  "expires_at",
  "lease_expires_at",
  "lease_until",
  "daily_quota_paused_until",
  "confirmed_at",
  "retired_at",
  "egress_started_at",
  "inference_started_at",
  "provider_started_at",
]);
function time(v: SQLInputValue) {
  if (v === null) return null;
  const n = typeof v === "number" ? v : Date.parse(scalarText(v));
  if (!Number.isSafeInteger(n)) throw Error("SOURCE_TIME_INVALID");
  return n;
}
function json(v: SQLInputValue) {
  const data = JSON.parse(scalarText(v));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw Error("SOURCE_JSON_INVALID");
  return data as Record<string, unknown>;
}
async function digest(file: string) {
  const h = createHash("sha256");
  for await (const bytes of createReadStream(file)) h.update(bytes);
  return h.digest("hex");
}
/** 归档可流式验证和恢复，不把整个旧库或明文数据装入内存。 */
export async function verifyArchive(file: string, masterKey: string, sourceDigest: string) {
  const fd = openSync(file, "r");
  let header: Buffer, tag: Buffer, start: number;
  try {
    const first = Buffer.alloc(1024),
      read = readSync(fd, first, 0, first.length, 0);
    start = first.subarray(0, read).indexOf(10) + 1;
    if (start < 2) throw Error("ARCHIVE_INVALID");
    header = first.subarray(0, start - 1);
    tag = Buffer.alloc(16);
    if (readSync(fd, tag, 0, 16, statSync(file).size - 16) !== 16) throw Error("ARCHIVE_INVALID");
  } finally {
    closeSync(fd);
  }
  const meta = JSON.parse(header.toString("utf8"));
  if (meta.version !== 1 || meta.sourceDigest !== sourceDigest)
    throw Error("ARCHIVE_SOURCE_CONFLICT");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(masterKey, "base64"),
    Buffer.from(meta.iv, "base64"),
  );
  decipher.setAAD(Buffer.from(`taskrelay-storage-v2:${sourceDigest}`));
  decipher.setAuthTag(tag);
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(file, { start, end: statSync(file).size - 17 }),
    decipher,
    new Writable({
      write(chunk, _encoding, done) {
        hash.update(chunk);
        done();
      },
    }),
  );
  if (hash.digest("hex") !== sourceDigest) throw Error("ARCHIVE_CONTENT_INVALID");
}
function tables(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => scalarText(r.name));
}
function columns(db: DatabaseSync, table: string) {
  return db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((r) => scalarText(r.name));
}
function insert(db: DatabaseSync, table: string, row: Row) {
  const keys = Object.keys(row);
  const result = db
    .prepare(
      `INSERT INTO "${table}"(${keys.map((k) => `"${k}"`).join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
    )
    .run(...keys.map((k) => row[k]));
  if (Number(result.changes) !== 1) throw Error("TARGET_ROW_IGNORED");
}
function version(def: Record<string, unknown>, user: SQLInputValue) {
  return {
    definition: JSON.stringify(def),
    user_id: user,
    model_id: typeof def.modelId === "string" ? def.modelId : null,
    model_version: typeof def.modelVersion === "number" ? def.modelVersion : null,
  };
}

export function inspectSource(source: DatabaseSync) {
  const expected = new DatabaseSync(":memory:");
  try {
    for (const f of readdirSync(new URL("./legacy-schema/", import.meta.url))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      expected.exec(readFileSync(new URL("./legacy-schema/" + f, import.meta.url), "utf8"));
    const inventory = tables(source).filter((t) => !t.startsWith("_cf_") && t !== "d1_migrations");
    if (JSON.stringify(inventory) !== JSON.stringify(tables(expected)))
      throw Error("SOURCE_TABLES_UNSUPPORTED");
    for (const t of inventory) {
      if (JSON.stringify(columns(source, t)) !== JSON.stringify(columns(expected, t)))
        throw Error("SOURCE_COLUMNS_UNSUPPORTED");
      const primary = source
        .prepare(`PRAGMA table_info("${t}")`)
        .all()
        .filter((c) => c.pk)
        .map((c) => scalarText(c.name));
      if (
        primary.length &&
        source
          .prepare(
            `SELECT 1 FROM "${t}" WHERE ${primary.map((c) => '"' + c + '" IS NULL').join(" OR ")} LIMIT 1`,
          )
          .get()
      )
        throw Error("SOURCE_IDENTITY_MISSING");
    }
    const blocking = [
      "SELECT id FROM runs WHERE status IN ('queued','running','waiting_user','verifying') OR cleanup_pending=1 LIMIT 1",
      "SELECT id FROM ai_calls WHERE status IN ('reserved','running') LIMIT 1",
      "SELECT id FROM ai_dispatch WHERE state IN ('pending','running') LIMIT 1",
      "SELECT id FROM conversation_inbox WHERE status IN ('pending','processing') LIMIT 1",
      "SELECT id FROM conversation_commands WHERE state IN ('pending','committed') LIMIT 1",
      "SELECT id FROM history_cleanup_jobs WHERE status<>'done' LIMIT 1",
    ];
    if (blocking.some((q) => source.prepare(q).get())) throw Error("SOURCE_NOT_DRAINED");
    if (source.prepare("PRAGMA foreign_key_check").all().length)
      throw Error("SOURCE_FOREIGN_KEYS_INVALID");
    return inventory.map((table) => ({
      table,
      rows: Number(source.prepare(`SELECT count(*) n FROM "${table}"`).get()!.n),
      target: retired.has(table)
        ? "converted-history-or-encrypted-archive"
        : table === "model_profiles"
          ? "model_profile_versions"
          : table,
    }));
  } finally {
    expected.close();
  }
}

/** 只读预检：验证当前权威凭据、密文上下文及跨域归属；不输出明文或实际对象键。 */
export async function preflightSource(source: DatabaseSync, masterKey: string) {
  const inventory = inspectSource(source);
  if (Buffer.from(masterKey, "base64").length !== 32) throw Error("ENCRYPTION_KEY_NOT_CONFIGURED");
  const invalid = [
    "SELECT 1 FROM runs r LEFT JOIN tasks t ON t.id=r.task_id WHERE t.id IS NULL OR r.user_id<>t.user_id LIMIT 1",
    "SELECT 1 FROM runs r JOIN ai_threads t ON t.id=r.thread_id WHERE r.user_id<>t.user_id LIMIT 1",
    "SELECT 1 FROM ai_threads t JOIN tasks p ON p.id=t.task_id WHERE t.user_id<>p.user_id LIMIT 1",
    "SELECT 1 FROM account_cards c JOIN runs r ON r.id=c.run_id JOIN ai_threads t ON t.id=c.thread_id WHERE c.user_id<>r.user_id OR c.user_id<>t.user_id LIMIT 1",
    "SELECT 1 FROM accounts a LEFT JOIN account_credential_versions v ON v.account_id=a.id AND v.version=a.credential_version WHERE v.account_id IS NULL LIMIT 1",
  ];
  if (invalid.some((q) => source.prepare(q).get())) throw Error("SOURCE_OWNERSHIP_INVALID");
  let encryptedValues = 0;
  const verify = async (value: SQLInputValue, aad: string) => {
    if (value === null) return;
    await unseal(scalarText(value), masterKey, aad);
    encryptedValues++;
  };
  for (const r of source.prepare("SELECT * FROM model_profiles").iterate())
    await verify(r.secret, `model:${scalarText(r.id)}:${scalarText(r.version)}`);
  for (const r of source.prepare("SELECT * FROM account_credential_versions").iterate())
    await verify(r.secret, `account:${scalarText(r.account_id)}`);
  for (const r of source
    .prepare(
      "SELECT a.id,a.secret,v.secret version_secret FROM accounts a JOIN account_credential_versions v ON v.account_id=a.id AND v.version=a.credential_version",
    )
    .iterate()) {
    const head = await unseal(scalarText(r.secret), masterKey, `account:${scalarText(r.id)}`),
      version = await unseal(
        scalarText(r.version_secret),
        masterKey,
        `account:${scalarText(r.id)}`,
      );
    if (JSON.stringify(head) !== JSON.stringify(version))
      throw Error("SOURCE_CREDENTIAL_VERSION_CONFLICT");
  }
  for (const r of source
    .prepare(
      "SELECT id,thread_id,private_content FROM ai_messages WHERE private_content IS NOT NULL",
    )
    .iterate())
    await verify(r.private_content, `message:${scalarText(r.thread_id)}:${scalarText(r.id)}`);
  for (const r of source
    .prepare("SELECT id,result FROM ai_calls WHERE result IS NOT NULL")
    .iterate())
    await verify(r.result, `ai-call:${scalarText(r.id)}`);
  for (const r of source
    .prepare("SELECT id,secret FROM account_cards WHERE secret IS NOT NULL")
    .iterate())
    await verify(r.secret, `account-card:${scalarText(r.id)}`);
  for (const r of source
    .prepare("SELECT id,token_secret FROM pairings WHERE token_secret IS NOT NULL")
    .iterate())
    await verify(r.token_secret, `pair:${scalarText(r.id)}`);
  for (const r of source.prepare("SELECT * FROM assistance_replies").iterate())
    await verify(r.content_secret, `assistance:${scalarText(r.challenge_id)}`);
  for (const r of source.prepare("SELECT * FROM ai_memories").iterate())
    await verify(
      r.value,
      `memory:${scalarText(r.owner)}:${scalarText(r.namespace)}:${scalarText(r.key)}`,
    );
  // 退休状态仍验证 GCM 与分块完整性，但不调用旧序列化器或恢复图执行。
  const graphCipher = async (row: Row, value: SQLInputValue, field?: string) => {
    let cipher = scalarText(value);
    const marker = JSON.parse(cipher);
    if (marker.v === 2) {
      const chunks = source
        .prepare(
          field
            ? "SELECT token,part,value FROM ai_checkpoint_chunks WHERE owner=? AND thread=? AND ns=? AND checkpoint=? AND field=? ORDER BY part"
            : "SELECT token,part,value FROM ai_write_chunks WHERE owner=? AND thread=? AND ns=? AND checkpoint=? AND task=? AND idx=? ORDER BY part",
        )
        .all(
          row.owner,
          row.thread,
          row.ns,
          field ? row.id : row.checkpoint,
          ...(field ? [field] : [row.task, row.idx]),
        )
        .filter((c) => c.token === marker.token);
      if (
        !Number.isSafeInteger(marker.parts) ||
        marker.parts < 1 ||
        chunks.length !== marker.parts ||
        chunks.some((c, i) => c.part !== i)
      )
        throw Error("SOURCE_CHECKPOINT_CHUNKS_MISSING");
      cipher = chunks.map((c) => scalarText(c.value)).join("");
    }
    await verify(cipher, `ai-checkpoint:${scalarText(row.owner)}`);
  };
  for (const row of source.prepare("SELECT * FROM ai_checkpoints").iterate()) {
    await graphCipher(row, row.checkpoint, "checkpoint");
    await graphCipher(row, row.metadata, "metadata");
  }
  for (const row of source.prepare("SELECT * FROM ai_writes").iterate())
    await graphCipher(row, row.value);
  for (const row of source.prepare("SELECT * FROM execution_help").iterate()) {
    const request = json(row.request);
    if (request.encryptedMessage !== undefined)
      await verify(
        scalarText(request.encryptedMessage),
        `help-request:${scalarText(row.run_id)}:${scalarText(row.id)}`,
      );
    if (row.response !== null) {
      const response = json(row.response);
      if (response.encrypted !== undefined)
        await verify(
          scalarText(response.encrypted),
          `help:${scalarText(row.run_id)}:${scalarText(row.id)}`,
        );
    }
  }
  const objectReferences = Number(
    source
      .prepare(
        "SELECT count(*) n FROM (SELECT object_key FROM artifacts UNION SELECT state_object_key FROM accounts WHERE state_object_key IS NOT NULL UNION SELECT previous_state_object_key FROM accounts WHERE previous_state_object_key IS NOT NULL UNION SELECT object_key FROM browser_state_candidates WHERE retired=0)",
      )
      .get()!.n,
  );
  const owners = source
    .prepare(
      `SELECT m.id,m.auth_id IS NOT NULL authLinked,
   (SELECT count(*) FROM tasks WHERE user_id=m.id) tasks,(SELECT count(*) FROM runs WHERE user_id=m.id) runs,
   (SELECT count(*) FROM ai_threads WHERE user_id=m.id) threads,(SELECT count(*) FROM accounts WHERE user_id=m.id) accounts FROM members m ORDER BY m.id`,
    )
    .all();
  return {
    inventory,
    owners,
    encryptedValues,
    objectReferences,
    ownershipVerified: true,
    retiredCipherPolicy: "原库整体加密归档；退休 checkpoint 不恢复执行",
    objectsVerified: false,
  };
}

export async function convertDatabase(options: Options) {
  const sourceFile = path.resolve(options.source),
    target = path.resolve(options.target),
    archive = path.resolve(options.archive),
    partial = target + ".partial";
  if (
    new Set(
      [
        sourceFile,
        target,
        archive,
        partial,
        archive + ".partial",
        target + ".conversion.json",
        target + ".conversion.json.partial",
        partial + ".json",
      ].map((file) => (process.platform === "win32" ? file.toLowerCase() : file)),
    ).size !== 8
  )
    throw Error("CONVERSION_PATH_CONFLICT");
  const key = Buffer.from(options.masterKey, "base64");
  if (key.length !== 32) throw Error("ENCRYPTION_KEY_NOT_CONFIGURED");
  if (existsSync(sourceFile + "-wal") && statSync(sourceFile + "-wal").size)
    throw Error("SOURCE_WAL_REQUIRES_CHECKPOINT");
  const sourceDigest = await digest(sourceFile),
    manifest = target + ".conversion.json";
  if (existsSync(target)) {
    if (!existsSync(manifest) && existsSync(manifest + ".partial")) {
      const pending = JSON.parse(readFileSync(manifest + ".partial", "utf8"));
      if (pending.sourceDigest !== sourceDigest || pending.targetDigest !== (await digest(target)))
        throw Error("TARGET_EXISTS");
      await verifyArchive(archive, options.masterKey, sourceDigest);
      renameSync(manifest + ".partial", manifest);
    }
    if (!existsSync(manifest)) throw Error("TARGET_EXISTS");
    const prior = JSON.parse(readFileSync(manifest, "utf8"));
    if (
      prior.sourceDigest !== sourceDigest ||
      prior.targetDigest !== (await digest(target)) ||
      prior.archiveDigest !== (await digest(archive))
    )
      throw Error("TARGET_CHANGED");
    await verifyArchive(archive, options.masterKey, sourceDigest);
    return { ...prior, reused: true };
  }
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  let next: DatabaseSync | undefined;
  try {
    const preflight = await preflightSource(source, options.masterKey),
      inventory = preflight.inventory;
    const partialMarker = partial + ".json";
    if (
      existsSync(partialMarker) &&
      JSON.parse(readFileSync(partialMarker, "utf8")).sourceDigest !== sourceDigest
    )
      throw Error("PARTIAL_SOURCE_CONFLICT");
    if (existsSync(partial)) {
      if (!existsSync(partialMarker)) {
        const check = new DatabaseSync(partial, { readOnly: true });
        try {
          if (
            check.prepare("SELECT source_digest FROM storage_meta").get()?.source_digest !==
            sourceDigest
          )
            throw Error("PARTIAL_SOURCE_CONFLICT");
        } finally {
          check.close();
        }
      }
      unlinkSync(partial);
    }
    writeFileSync(partialMarker, JSON.stringify({ version: 2, sourceDigest }), { mode: 0o600 });
    next = new DatabaseSync(partial);
    next.exec(
      readFileSync(
        new URL("../../apps/cloud/migrations/0001_storage_v2.sql", import.meta.url),
        "utf8",
      ),
    );
    next.prepare("UPDATE storage_meta SET source_digest=?").run(sourceDigest);
    next.exec("BEGIN IMMEDIATE;PRAGMA defer_foreign_keys=ON;DELETE FROM settings");
    const mapped = new Map<string, number>();
    const copy = async (table: string) => {
      const targetTable = table === "model_profiles" ? "model_profile_versions" : table;
      for (const original of source.prepare(`SELECT * FROM "${table}"`).iterate()) {
        const row: Row = {};
        for (const [k, v] of Object.entries(original))
          if (!omitted[table]?.includes(k)) row[k] = times.has(k) ? time(v) : v;
        if (
          table === "settings" &&
          ["historyEpoch", "chatInputProtectionBackfillV1"].includes(scalarText(row.key))
        )
          continue;
        if (table === "settings" && ["claimsEnabled", "maintenance"].includes(scalarText(row.key)))
          row.value = row.key === "maintenance" ? "1" : "0";
        if (table === "members" && options.ownerBindings?.[scalarText(row.id)]) {
          const auth = options.ownerBindings[scalarText(row.id)];
          if (!source.prepare("SELECT id FROM auth_user WHERE id=? AND emailVerified=1").get(auth))
            throw Error("OWNER_BINDING_INVALID");
          if (row.auth_id !== null && row.auth_id !== auth) throw Error("OWNER_BINDING_CONFLICT");
          row.auth_id = auth;
        }
        if (table === "tasks") {
          const def = json(original.definition);
          row.title = scalarText(def.title ?? "");
          row.schedule_kind = scalarText(
            (def.schedule as { kind?: string } | undefined)?.kind ?? "manual",
          );
        }
        if (table === "task_versions") {
          const task = source.prepare("SELECT user_id FROM tasks WHERE id=?").get(original.task_id);
          if (!task) throw Error("TASK_OWNER_MISSING");
          Object.assign(row, version(json(original.definition), task.user_id));
        }
        if (table === "runs") {
          const def = json(original.task_snapshot);
          row.task_version = typeof def.version === "number" ? def.version : null;
          if (row.task_version === null && row.history_deleted !== 1)
            throw Error("RUN_VERSION_MISSING");
          if (
            typeof def.version === "number" &&
            !next!
              .prepare("SELECT task_id FROM task_versions WHERE task_id=? AND version=?")
              .get(row.task_id, def.version)
          )
            insert(next!, "task_versions", {
              task_id: row.task_id,
              version: def.version,
              ...version(def, row.user_id),
            });
        }
        if (table === "account_dispatch_groups")
          row.member_count = Number(
            source
              .prepare("SELECT count(*) n FROM account_dispatch_members WHERE group_id=?")
              .get(row.id)!.n,
          );
        if (table === "ai_graph_inputs") {
          row.active = 0;
          row.generation = Number(row.generation) + 1;
          row.status = "cancelled";
          row.error = "STORAGE_CONVERTED";
        }
        if (table === "ai_turns" && row.status === "running") {
          row.status = "unknown";
          row.error = "STORAGE_CONVERTED";
        }
        if (table === "ai_dispatch") {
          row.state = "retired";
          row.lease_until = null;
          if (row.kind === "legacy") row.kind = "chat";
        }
        if (table === "account_cards" && row.status === "pending") {
          row.status = "expired";
          row.secret = null;
        }
        insert(next!, targetTable, row);
        mapped.set(targetTable, (mapped.get(targetTable) ?? 0) + 1);
        if (table === "runs") {
          if (original.task_snapshot !== "{}")
            insert(next!, "run_snapshots", {
              run_id: row.id,
              task_snapshot: original.task_snapshot,
            });
          if (original.result !== null)
            insert(next!, "run_results", { run_id: row.id, result: original.result });
        }
        if (table === "ai_messages") {
          let content = scalarText(original.content),
            cipher = original.private_content,
            parts = scalarText(original.parts);
          // 未加密的旧运行补充只在离线转换时修复；正常运行不保留 backfill 路径。
          if (original.role === "user" && original.run_id !== null && cipher === null) {
            cipher = await seal(
              content,
              options.masterKey,
              `message:${scalarText(row.thread_id)}:${scalarText(row.id)}`,
            );
            content = "[用户已提供私密信息]";
          }
          if (original.role === "assistant") {
            const secrets = source
              .prepare(
                "SELECT content FROM ai_messages WHERE thread_id=? AND role='user' AND run_id IS NOT NULL AND private_content IS NULL AND seq<?",
              )
              .all(original.thread_id, original.seq)
              .map((r) => scalarText(r.content))
              .filter(Boolean);
            if (cipher === null && secrets.some((secret) => content.includes(secret))) {
              cipher = await seal(
                content,
                options.masterKey,
                `message:${scalarText(row.thread_id)}:${scalarText(row.id)}`,
              );
              content = "[用户已提供私密信息]";
            }
            const redact = (value: unknown): unknown =>
              typeof value === "string"
                ? secrets.reduce((text, secret) => text.split(secret).join("[已隐藏]"), value)
                : Array.isArray(value)
                  ? value.map(redact)
                  : value && typeof value === "object"
                    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]))
                    : value;
            parts = JSON.stringify(redact(JSON.parse(parts)));
          }
          if (cipher !== null)
            await unseal(
              scalarText(cipher),
              options.masterKey,
              `message:${scalarText(row.thread_id)}:${scalarText(row.id)}`,
            );
          insert(next!, "message_bodies", { id: row.id, content, private_content: cipher, parts });
        }
        if (table === "ai_calls" && original.result !== null) {
          await unseal(
            scalarText(original.result),
            options.masterKey,
            `ai-call:${scalarText(row.id)}`,
          );
          const packed = packCallCipher(scalarText(original.result));
          insert(next!, "call_results", { id: row.id, result: packed.value });
          packed.chunks.forEach((value, part) =>
            insert(next!, "call_result_chunks", { id: row.id, token: packed.token, part, value }),
          );
        }
        if (table === "model_profiles")
          await unseal(
            scalarText(original.secret),
            options.masterKey,
            `model:${scalarText(row.id)}:${scalarText(row.version)}`,
          );
        if (table === "account_credential_versions")
          await unseal(
            scalarText(original.secret),
            options.masterKey,
            `account:${scalarText(row.account_id)}`,
          );
      }
    };
    // 关系写入在同一离线事务中校验；顺序同时兼顾触发器及任务版本缺失补全。
    const priority = [
      "auth_user",
      "auth_session",
      "auth_account",
      "auth_verification",
      "auth_rate_limit",
      "members",
      "model_profiles",
      "devices",
      "accounts",
      "account_credential_versions",
      "tasks",
      "task_versions",
      "ai_threads",
      "runs",
    ];
    for (const table of [
      ...priority,
      ...inventory.map((x) => x.table).filter((t) => !priority.includes(t)),
    ])
      if (!retired.has(table)) await copy(table);
    next
      .prepare(
        "INSERT INTO settings(key,value) VALUES('storageFrozen','1') ON CONFLICT(key) DO UPDATE SET value='1'",
      )
      .run();
    for (const t of source.prepare("SELECT * FROM tasks").iterate())
      if (
        !next
          .prepare("SELECT task_id FROM task_versions WHERE task_id=? AND version=?")
          .get(t.id, t.version)
      )
        insert(next, "task_versions", {
          task_id: t.id,
          version: t.version,
          ...version(json(t.definition), t.user_id),
        });
    // 将退休流程的可见历史转为同一消息流；技术状态完整保留在加密原库归档中。
    const history: {
      id: string;
      thread: string;
      role: string;
      content: string;
      at: number;
      run: string | null;
    }[] = [];
    const threadForTask = (task: SQLInputValue) => {
      const existing = next!
        .prepare("SELECT id FROM ai_threads WHERE task_id=? ORDER BY closed,created_at,id LIMIT 1")
        .get(task)?.id;
      if (existing) return existing;
      const t = next!
        .prepare(
          "SELECT t.*,v.model_id,v.model_version FROM tasks t JOIN task_versions v ON v.task_id=t.id AND v.version=t.version WHERE t.id=?",
        )
        .get(task);
      if (!t || t.model_id === null || t.model_version === null)
        throw Error("VISIBLE_HISTORY_THREAD_MISSING");
      const id =
        "history_thread_" +
        createHash("sha256")
          .update(`${scalarText(t.user_id)}:${scalarText(task)}`)
          .digest("hex")
          .slice(0, 40);
      insert(next!, "ai_threads", {
        id,
        user_id: t.user_id,
        task_id: task,
        kind: "chat",
        model_id: t.model_id,
        model_version: t.model_version,
        created_at: t.created_at,
        updated_at: t.updated_at,
      });
      return id;
    };
    for (const r of source.prepare("SELECT * FROM conversations").iterate()) {
      const thread = threadForTask(r.task_id);
      if (!thread) throw Error("VISIBLE_HISTORY_THREAD_MISSING");
      history.push({
        id: `history_conversation_${scalarText(r.id)}`,
        thread: scalarText(thread),
        role: r.role === "user" ? "user" : "assistant",
        content: scalarText(r.content),
        at: Number(time(r.at)),
        run: null,
      });
    }
    for (const r of source
      .prepare("SELECT e.*,r.thread_id,r.task_id FROM run_events e JOIN runs r ON r.id=e.run_id")
      .iterate()) {
      const thread = r.thread_id ?? threadForTask(r.task_id);
      if (!thread) throw Error("VISIBLE_HISTORY_THREAD_MISSING");
      history.push({
        id: `history_event_${scalarText(r.run_id)}_${scalarText(r.id)}`,
        thread: scalarText(thread),
        role: "assistant",
        content: scalarText(r.message),
        at: Number(time(r.at)),
        run: scalarText(r.run_id),
      });
    }
    for (const r of source
      .prepare(
        "SELECT a.*,c.run_id AS challenge_run FROM assistance_replies a JOIN challenges c ON c.id=a.challenge_id",
      )
      .iterate()) {
      const run = source.prepare("SELECT thread_id,task_id FROM runs WHERE id=?").get(r.run_id);
      const thread = r.thread_id ?? run?.thread_id ?? (run && threadForTask(run.task_id));
      if (!thread) throw Error("VISIBLE_HISTORY_THREAD_MISSING");
      const content = await unseal<string>(
        scalarText(r.content_secret),
        options.masterKey,
        `assistance:${scalarText(r.challenge_id)}`,
      );
      history.push({
        id: `assistance_${scalarText(r.id)}`,
        thread: scalarText(thread),
        role: "user",
        content,
        at: Number(time(r.created_at)),
        run: scalarText(r.run_id),
      });
    }
    for (const h of history.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) {
      const seq = Number(
        next
          .prepare("SELECT COALESCE(MAX(seq),0)+1 n FROM ai_messages WHERE thread_id=?")
          .get(h.thread)!.n,
      );
      insert(next, "ai_messages", {
        id: h.id,
        thread_id: h.thread,
        seq,
        role: h.role,
        turn_id: h.id,
        at: h.at,
        source: h.role === "user" ? "user" : "cloud",
        run_id: h.run,
        reply_to: null,
        context_withdrawn: 0,
      });
      insert(next, "message_bodies", {
        id: h.id,
        content: h.role === "user" ? "[历史私密回复]" : h.content,
        private_content:
          h.role === "user"
            ? await seal(h.content, options.masterKey, `message:${h.thread}:${h.id}`)
            : null,
        parts: "[]",
      });
    }
    // 跨旧消息流统一时间顺序；原消息 ID 保持不变，同时间的原消息按原 seq 稳定排列。
    for (const t of next.prepare("SELECT id FROM ai_threads").all()) {
      const ids = next
        .prepare("SELECT id FROM ai_messages WHERE thread_id=? ORDER BY at,seq,id")
        .all(t.id);
      next.prepare("UPDATE ai_messages SET seq=-seq WHERE thread_id=?").run(t.id);
      ids.forEach((r, i) =>
        next!.prepare("UPDATE ai_messages SET seq=? WHERE id=?").run(i + 1, r.id),
      );
    }
    const objectReferences = next
      .prepare(
        "SELECT 'evidence' kind,object_key FROM artifacts UNION SELECT 'browser-state',state_object_key FROM accounts WHERE state_object_key IS NOT NULL UNION SELECT 'browser-state',previous_state_object_key FROM accounts WHERE previous_state_object_key IS NOT NULL UNION SELECT 'browser-state',object_key FROM browser_state_candidates WHERE retired=0",
      )
      .all();
    if (next.prepare("PRAGMA foreign_key_check").all().length)
      throw Error("TARGET_FOREIGN_KEYS_INVALID");
    next.exec("COMMIT");
    if (next.prepare("PRAGMA integrity_check").get()!.integrity_check !== "ok")
      throw Error("TARGET_INTEGRITY_INVALID");
    const counts = tables(next).map((table) => ({
      table,
      rows: Number(next!.prepare(`SELECT count(*) n FROM "${table}"`).get()!.n),
    }));
    next.close();
    next = undefined;
    if (!existsSync(archive)) {
      const archivePartial = archive + ".partial",
        iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(`taskrelay-storage-v2:${sourceDigest}`));
      if (existsSync(archivePartial)) {
        // 同源、长度明确不足的临时归档可从头重做；完整文件必须通过 GCM 验证，错误密钥不能覆盖它。
        const fd = openSync(archivePartial, "r"),
          header = Buffer.alloc(1024);
        let count: number;
        try {
          count = readSync(fd, header, 0, header.length, 0);
        } finally {
          closeSync(fd);
        }
        const end = header.subarray(0, count).indexOf(10),
          meta = JSON.parse(header.subarray(0, end).toString("utf8"));
        if (end < 0 || meta.version !== 1 || meta.sourceDigest !== sourceDigest)
          throw Error("ARCHIVE_SOURCE_CONFLICT");
        if (statSync(archivePartial).size < statSync(sourceFile).size + end + 1 + 16)
          unlinkSync(archivePartial);
        else {
          await verifyArchive(archivePartial, options.masterKey, sourceDigest);
          renameSync(archivePartial, archive);
        }
      }
      if (!existsSync(archive)) {
        const stream = createWriteStream(archivePartial, { flags: "wx", mode: 0o600 });
        stream.write(
          Buffer.from(
            JSON.stringify({ version: 1, sourceDigest, iv: iv.toString("base64") }) + "\n",
          ),
        );
        await pipeline(createReadStream(sourceFile), cipher, stream);
        const fd = await import("node:fs/promises").then((fs) => fs.open(archivePartial, "a"));
        try {
          await fd.write(cipher.getAuthTag());
          await fd.sync();
        } finally {
          await fd.close();
        }
        renameSync(archivePartial, archive);
      }
    }
    await verifyArchive(archive, options.masterKey, sourceDigest);
    if (
      (await digest(sourceFile)) !== sourceDigest ||
      (existsSync(sourceFile + "-wal") && statSync(sourceFile + "-wal").size)
    )
      throw Error("SOURCE_CHANGED");
    const result = {
      version: 2,
      sourceDigest,
      targetDigest: await digest(partial),
      archiveDigest: await digest(archive),
      preflight,
      inventory,
      counts,
      objectReferences,
      visibleHistoryConverted: history.length,
      readyForCutover: false,
      capacity: {
        targetBytes: statSync(partial).size,
        freeDatabaseLimitBytes: 500_000_000,
        storageFitsFree: statSync(partial).size <= 500_000_000,
        dailyImportBudgetVerified: false,
      },
    };
    if (
      existsSync(manifest + ".partial") &&
      JSON.parse(readFileSync(manifest + ".partial", "utf8")).sourceDigest !== sourceDigest
    )
      throw Error("MANIFEST_SOURCE_CONFLICT");
    writeFileSync(manifest + ".partial", JSON.stringify(result, null, 2), { mode: 0o600 });
    renameSync(partial, target);
    renameSync(manifest + ".partial", manifest);
    unlinkSync(partialMarker);
    return { ...result, reused: false };
  } catch (error) {
    if (next) {
      try {
        next.exec("ROLLBACK");
      } catch {}
      next.close();
    }
    throw error;
  } finally {
    source.close();
    key.fill(0);
  }
}
