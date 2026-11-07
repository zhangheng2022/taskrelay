/** 离线转换命令：路径由操作者显式指定；密钥只从既有 MASTER_KEY 环境读取，输出仅含固定状态。 */
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { convertDatabase, preflightSource } from "./convert.ts";
import { exportDatabase } from "./export.ts";
const { values } = parseArgs({
  options: {
    source: { type: "string" },
    target: { type: "string" },
    archive: { type: "string" },
    inspect: { type: "boolean" },
    export: { type: "boolean" },
    "owner-bindings": { type: "string" },
  },
});
try {
  if (!values.source) throw Error("SOURCE_REQUIRED");
  if (values.export) {
    if (!values.target) throw Error("TARGET_REQUIRED");
    console.log(JSON.stringify(exportDatabase(values.source, values.target)));
  } else if (values.inspect) {
    const db = new DatabaseSync(values.source, { readOnly: true });
    try {
      console.log(JSON.stringify(await preflightSource(db, process.env.MASTER_KEY ?? ""), null, 2));
    } finally {
      db.close();
    }
  } else {
    if (!values.target || !values.archive) throw Error("TARGET_AND_ARCHIVE_REQUIRED");
    await convertDatabase({
      source: values.source,
      target: values.target,
      archive: values.archive,
      masterKey: process.env.MASTER_KEY ?? "",
      ...(values["owner-bindings"]
        ? { ownerBindings: JSON.parse(readFileSync(values["owner-bindings"], "utf8")) }
        : {}),
    });
    console.log("STORAGE_CONVERTED_AND_VERIFIED");
  }
} catch (error) {
  console.error(
    error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "STORAGE_CONVERSION_FAILED",
  );
  process.exitCode = 1;
}
