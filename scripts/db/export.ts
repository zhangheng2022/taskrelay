/** 将已核验的冻结 v2 库导出为新 D1 基线的数据导入文件。
 * 只接受空的新基线；D1 import 事务内暂停触发器、延迟外键并核对行数，结束前恢复触发器。
 * 大文本拆为小于 SQL 长度上限的连续片段；文件含密文和用户数据，按源库同等权限保存，禁止提交。 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  openSync,
  closeSync,
  writeSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const identifier = (s: string) => '"' + s.replaceAll('"', '""') + '"';
function literal(value: SQLInputValue): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return "'" + value.replaceAll("'", "''") + "'";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "X'" + Buffer.from(value).toString("hex") + "'";
}
function pieces(value: string) {
  const result: string[] = [];
  for (let at = 0; at < value.length;) {
    let end = Math.min(at + 4_000, value.length);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
    result.push(value.slice(at, end));
    at = end;
  }
  return result;
}
export function exportDatabase(sourcePath: string, outputPath: string) {
  const source = path.resolve(sourcePath),
    output = path.resolve(outputPath),
    partial = output + ".partial";
  if (source === output || source === partial) throw Error("EXPORT_PATH_CONFLICT");
  if (existsSync(source + "-wal") && statSync(source + "-wal").size)
    throw Error("SOURCE_WAL_REQUIRES_CHECKPOINT");
  const db = new DatabaseSync(source, { readOnly: true });
  let fd: number | undefined;
  try {
    if (
      db.prepare("SELECT version FROM storage_meta").get()?.version !== 2 ||
      db.prepare("SELECT value FROM settings WHERE key='storageFrozen'").get()?.value !== "1"
    )
      throw Error("EXPORT_REQUIRES_FROZEN_V2");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw Error("TARGET_FOREIGN_KEYS_INVALID");
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name<>'d1_migrations' ORDER BY rowid",
      )
      .all()
      .map((r) => String(r.name));
    const triggers = db
      .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY rowid")
      .all();
    fd = openSync(partial, "wx", 0o600);
    const hash = createHash("sha256");
    const emit = (s: string) => {
      if (Buffer.byteLength(s) > 90_000) throw Error("EXPORT_STATEMENT_TOO_LARGE");
      writeSync(fd!, s + "\n");
      hash.update(s + "\n");
    };
    emit(
      "-- 私有离线导入文件；仅导入已应用 0001_storage_v2 的独立空 D1。禁止导入旧库或已开放写入的库。",
    );
    emit("PRAGMA defer_foreign_keys=ON;");
    // version=0 违反基线 CHECK，任何非空业务表都会中止整个 import。
    const empty = tables.filter((t) => !["storage_meta", "settings"].includes(t));
    emit(
      `INSERT INTO storage_meta(version) SELECT 0 WHERE ${empty.map((t) => "EXISTS(SELECT 1 FROM " + identifier(t) + ")").join(" OR ")};`,
    );
    for (const trigger of triggers) emit("DROP TRIGGER " + identifier(String(trigger.name)) + ";");
    emit("DELETE FROM settings;");
    emit("DELETE FROM storage_meta;");
    // 临时分块表仅存在于 import 事务中，拼接完成的值一次通过原表 JSON/CHECK 约束。
    emit(
      "CREATE TABLE _storage_import_chunks(token TEXT,part INTEGER,value TEXT,PRIMARY KEY(token,part));",
    );
    const counts: Record<string, number> = {};
    let insertRowsWrittenEstimate = 0,
      stagingRowsWrittenEstimate = 0;
    let serial = 0;
    for (const table of tables) {
      const cols = db.prepare("PRAGMA table_info(" + identifier(table) + ")").all(),
        primary = cols
          .filter((c) => c.pk)
          .sort((a, b) => Number(a.pk) - Number(b.pk))
          .map((c) => String(c.name));
      if (!primary.length) throw Error("EXPORT_PRIMARY_KEY_REQUIRED");
      let count = 0;
      for (const row of db.prepare("SELECT * FROM " + identifier(table)).iterate()) {
        const names = Object.keys(row),
          long = names.filter(
            (k) => typeof row[k] === "string" && Buffer.byteLength(String(row[k])) > 8_000,
          );
        const tokens = new Map(long.map((k) => [k, String(++serial)]));
        for (const [k, token] of tokens)
          pieces(String(row[k])).forEach((piece, part) => {
            stagingRowsWrittenEstimate += 4;
            emit(
              `INSERT INTO _storage_import_chunks VALUES(${literal(token)},${part},${literal(piece)});`,
            );
          });
        emit(
          `INSERT INTO ${identifier(table)}(${names.map(identifier).join(",")}) VALUES(${names.map((k) => (tokens.has(k) ? `(SELECT group_concat(value,'') FROM (SELECT value FROM _storage_import_chunks WHERE token=${literal(tokens.get(k)!)} ORDER BY part))` : literal(row[k]))).join(",")});`,
        );
        if (long.length) emit("DELETE FROM _storage_import_chunks;");
        count++;
      }
      counts[table] = count;
      insertRowsWrittenEstimate +=
        count * (1 + db.prepare("PRAGMA index_list(" + identifier(table) + ")").all().length);
    }
    emit("DROP TABLE _storage_import_chunks;");
    for (const trigger of triggers) emit(String(trigger.sql) + ";");
    emit(
      `INSERT INTO storage_meta(version) SELECT 0 WHERE ${Object.entries(counts)
        .map(([t, n]) => `(SELECT count(*) FROM ${identifier(t)})<>${n}`)
        .join(" OR ")};`,
    );
    emit("PRAGMA defer_foreign_keys=OFF;");
    closeSync(fd);
    fd = undefined;
    const digest = hash.digest("hex");
    if (existsSync(output)) {
      if (createHash("sha256").update(readFileSync(output)).digest("hex") !== digest)
        throw Error("EXPORT_TARGET_CHANGED");
      unlinkSync(partial);
    } else renameSync(partial, output);
    return {
      tables: tables.length,
      counts,
      digest,
      capacity: {
        sourceBytes: statSync(source).size,
        storageFitsFree: statSync(source).size <= 500_000_000,
        insertRowsWrittenEstimate,
        stagingRowsWrittenEstimate,
        dailyFreeWriteLimit: 100_000,
        dailyImportBudgetVerified: false,
      },
    };
  } catch (error) {
    if (fd !== undefined) {
      closeSync(fd);
      unlinkSync(partial);
    }
    throw error;
  } finally {
    db.close();
  }
}
