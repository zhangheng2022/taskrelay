/** 离线转换旧 Main SQLite；只读源库，写入独立 schema 4 文件，原库永久保留。
 * 必须持有应用单实例锁且尚未启动执行器；转换只保留事实，不恢复浏览器或清空 unknown。 */
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  renameSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { journalSchema } from "./journal-schema";

export function convertJournal(directory: string) {
  const source = path.resolve(directory, "taskrelay.sqlite"),
    target = path.resolve(directory, "taskrelay-v4.sqlite"),
    partial = target + ".partial";
  if (!existsSync(source)) throw Error("LOCAL_SOURCE_NOT_FOUND");
  if (existsSync(source + "-wal") && statSync(source + "-wal").size)
    throw Error("LOCAL_SOURCE_WAL_REQUIRES_CHECKPOINT");
  const digest = () => {
    const hash = createHash("sha256"),
      fd = openSync(source, "r"),
      buffer = Buffer.alloc(1024 * 1024);
    try {
      let count: number;
      while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0)
        hash.update(buffer.subarray(0, count));
      return hash.digest("hex");
    } finally {
      closeSync(fd);
    }
  };
  const sourceDigest = digest(),
    marker = partial + ".json";
  const old = new DatabaseSync(source, { readOnly: true });
  let next: DatabaseSync | undefined;
  try {
    const version = Number(old.prepare("PRAGMA user_version").get()!.user_version);
    if (version < 1 || version > 3)
      throw Error(version > 4 ? "CLIENT_UPGRADE_REQUIRED" : "LOCAL_SOURCE_VERSION_UNSUPPORTED");
    if (existsSync(target)) {
      const check = new DatabaseSync(target, { readOnly: true });
      try {
        if (Number(check.prepare("PRAGMA user_version").get()!.user_version) !== 4)
          throw Error("LOCAL_TARGET_CONFLICT");
        for (const table of ["config", "journal", "outbox"]) {
          const where = table === "config" ? " WHERE key<>'historyEpoch'" : "",
            primary = { config: "key", journal: "run_id", outbox: "id" }[table];
          if (
            old.prepare(`SELECT count(*) n FROM ${table}${where}`).get()!.n !==
            check.prepare(`SELECT count(*) n FROM ${table}`).get()!.n
          )
            throw Error("LOCAL_TARGET_CONFLICT");
          const find = check.prepare(`SELECT * FROM ${table} WHERE ${primary}=?`);
          // 本地索引逐条比较，避免重复转换以全量数组两两查找而退化为 O(n²)。
          for (const row of old.prepare(`SELECT * FROM ${table}${where}`).iterate()) {
            const actual = find.get(row[primary!]);
            if (
              !actual ||
              !Object.entries(row).every(
                ([k, v]) =>
                  actual[k] ===
                  (k === "created_at" || k === "updated_at" ? Date.parse(String(v)) : v),
              )
            )
              throw Error("LOCAL_TARGET_CONFLICT");
          }
        }
        return { converted: false, version: 4 };
      } finally {
        check.close();
      }
    }
    if (existsSync(partial) || existsSync(marker)) {
      if (
        !existsSync(marker) ||
        JSON.parse(readFileSync(marker, "utf8")).sourceDigest !== sourceDigest
      )
        throw Error("LOCAL_CONVERSION_SOURCE_CONFLICT");
      if (existsSync(partial)) unlinkSync(partial);
    }
    writeFileSync(marker, JSON.stringify({ version: 4, sourceDigest }), { mode: 0o600 });
    next = new DatabaseSync(partial);
    next.exec(journalSchema);
    next.exec("BEGIN IMMEDIATE");
    for (const table of ["config", "journal", "outbox"]) {
      for (const row of old.prepare(`SELECT * FROM ${table}`).iterate()) {
        if (table === "config" && row.key === "historyEpoch") continue;
        const columns = Object.keys(row),
          values = columns.map((k) => {
            const v = row[k];
            if (k !== "updated_at" && k !== "created_at") return v;
            const n = Date.parse(String(v));
            if (!Number.isSafeInteger(n)) throw Error("LOCAL_TIME_INVALID");
            return n;
          });
        next
          .prepare(
            `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
          )
          .run(...values);
      }
    }
    next.exec("COMMIT");
    if (next.prepare("PRAGMA integrity_check").get()!.integrity_check !== "ok")
      throw Error("LOCAL_CONVERSION_INVALID");
    next.close();
    next = undefined;
    if (
      digest() !== sourceDigest ||
      (existsSync(source + "-wal") && statSync(source + "-wal").size)
    )
      throw Error("LOCAL_SOURCE_CHANGED");
    renameSync(partial, target);
    unlinkSync(marker);
    return { converted: true, version: 4 };
  } catch (error) {
    if (next) {
      next.close();
      next = undefined;
      unlinkSync(partial);
    }
    throw error;
  } finally {
    old.close();
  }
}
