/**
 * LangGraph 的 D1 存储适配：加密保存检查点及未合并写入，并按用户和图隔离读取。
 * 生产写入同时校验会话、图代次和执行租约，阻止失效回合重新写入已清理的上下文。
 * 大密文与索引在同一事务分块保存，避免摘要节点运行前的完整输入超过 D1 行限制。
 */
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  writesSortKey,
  type Checkpoint,
  type CheckpointTuple,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { seal, unseal } from "../crypto";
import { Buffer } from "node:buffer";
import { graphWriteFence } from "./fence";

type Saved = {
  id: string;
  parent: string | null;
  checkpoint: string;
  metadata: string;
  thread: string;
  ns: string;
};
type Write = {
  task: string;
  path: string;
  idx: number;
  channel: string;
  value: string;
};
type Chunk = { token: string; part: number; value: string };
type CheckpointChunk = Chunk & { field: "checkpoint" | "metadata" };
type WriteChunk = Chunk & { task: string; idx: number };
// 两个内联字段合计仍远低于 D1 的 2 MB 行上限；调用方无需裁剪原始消息。
const CHUNK_SIZE = 500_000;
type Location = { thread: string; ns: string; checkpoint: string } & (
  | { field: "checkpoint" | "metadata" }
  | { task: string; idx: number }
);
type Packed = { value: string; token?: string; parts: string[] };
/** Uses LangGraph's serializer, including pending writes, rather than JSON-cloning messages. */
export class D1Checkpointer extends BaseCheckpointSaver {
  constructor(
    private db: D1Database,
    private owner: string,
    private key: string,
    private guard: () => Promise<void> = async () => {},
    private fenced = false,
    private generation?: number,
  ) {
    super();
  }
  private fence(thread: string) {
    return this.fenced
      ? graphWriteFence(this.owner, thread, this.generation)
      : { sql: "1", values: [] };
  }
  private scope(c: RunnableConfig) {
    const thread = c.configurable?.thread_id;
    if (typeof thread !== "string" || !thread || thread.length > 200)
      throw new Error("AI_THREAD_REQUIRED");
    return { thread, ns: String(c.configurable?.checkpoint_ns ?? "") };
  }
  private async encode(value: unknown) {
    const [type, bytes] = await this.serde.dumpsTyped(value);
    const encrypted = await seal(
      {
        type,
        bytes: Buffer.from(bytes).toString("base64"),
        encoding: "base64",
      },
      this.key,
      `ai-checkpoint:${this.owner}`,
    );
    if (encrypted.length <= CHUNK_SIZE) return { value: encrypted, parts: [] } satisfies Packed;
    const token = crypto.randomUUID(), parts: string[] = [];
    for (let offset = 0; offset < encrypted.length; offset += CHUNK_SIZE)
      parts.push(encrypted.slice(offset, offset + CHUNK_SIZE));
    return { value: JSON.stringify({ v: 2, token, parts: parts.length }), token, parts } satisfies Packed;
  }
  private chunkScope(location: Location) {
    const prefix = [this.owner, location.thread, location.ns, location.checkpoint];
    return "field" in location
      ? { table: "ai_checkpoint_chunks", columns: "owner,thread,ns,checkpoint,field", values: [...prefix, location.field] }
      : { table: "ai_write_chunks", columns: "owner,thread,ns,checkpoint,task,idx", values: [...prefix, location.task, location.idx] };
  }
  private chunkWrites(location: Location, packed: Packed) {
    const scope = this.chunkScope(location), columns = scope.columns.split(",");
    // OR IGNORE 的重复 pending write 不能把新密文碎片覆盖到已存在的旧值上。
    const parent = "field" in location
      ? { table: "ai_checkpoints", where: "owner=? AND thread=? AND ns=? AND id=?", column: location.field,
          values: [this.owner, location.thread, location.ns, location.checkpoint] }
      : { table: "ai_writes", where: "owner=? AND thread=? AND ns=? AND checkpoint=? AND task=? AND idx=?", column: "value",
          values: scope.values };
    return packed.parts.map((part, i) => this.db.prepare(
      `INSERT INTO ${scope.table}(${scope.columns},token,part,value) SELECT ${columns.map(() => "?").join(",")},?,?,? WHERE EXISTS(SELECT 1 FROM ${parent.table} WHERE ${parent.where} AND ${parent.column}=?)`,
    ).bind(...scope.values, packed.token!, i, part, ...parent.values, packed.value));
  }
  private async decode<T>(value: string, savedChunks: Chunk[]): Promise<T> {
    const marker = JSON.parse(value);
    if (marker.v === 2) {
      if (typeof marker.token !== "string" || !Number.isSafeInteger(marker.parts) || marker.parts < 1)
        throw Error("CHECKPOINT_CHUNKS_INVALID");
      const chunks = savedChunks.filter(c => c.token === marker.token).sort((a, b) => a.part - b.part);
      if (chunks.length !== marker.parts || chunks.some((c, i) => c.part !== i))
        throw Error("CHECKPOINT_CHUNKS_MISSING");
      value = chunks.map(c => c.value).join("");
    }
    const data = await unseal<{
      type: string;
      bytes: number[] | string;
      encoding?: "base64";
    }>(value, this.key, `ai-checkpoint:${this.owner}`);
    let bytes: Uint8Array;
    if (Array.isArray(data.bytes)) bytes = new Uint8Array(data.bytes);
    else if (data.encoding === "base64")
      bytes = new Uint8Array(Buffer.from(data.bytes, "base64"));
    else throw new Error("UNKNOWN_CHECKPOINT_ENCODING");
    return (await this.serde.loadsTyped(data.type, bytes)) as T;
  }
  private async tuple(row: Saved, writes: Write[], checkpointChunks: CheckpointChunk[], writeChunks: WriteChunk[]): Promise<CheckpointTuple> {
    writes.sort((a, b) =>
      compareWritesSortKeys(
        writesSortKey(a.path, a.task, a.idx),
        writesSortKey(b.path, b.task, b.idx),
      ),
    );
    const config = {
      configurable: {
        thread_id: row.thread,
        checkpoint_ns: row.ns,
        checkpoint_id: row.id,
      },
    };
    return {
      config,
      checkpoint: await this.decode<Checkpoint>(row.checkpoint, checkpointChunks.filter(c => c.field === "checkpoint")),
      metadata: await this.decode<CheckpointMetadata>(row.metadata, checkpointChunks.filter(c => c.field === "metadata")),
      ...(row.parent
        ? {
            parentConfig: {
              configurable: {
                ...config.configurable,
                checkpoint_id: row.parent,
              },
            },
          }
        : {}),
      pendingWrites: await Promise.all(
        writes.map(
          async (w) =>
            [w.task, w.channel, await this.decode(w.value, writeChunks.filter(c => c.task === w.task && c.idx === w.idx))] as [
              string,
              string,
              unknown,
            ],
        ),
      ),
    };
  }
  async getTuple(config: RunnableConfig) {
    const { thread, ns } = this.scope(config),
      id = config.configurable?.checkpoint_id;
    const where = `owner=? AND thread=? AND ns=? ${id ? "AND id=?" : ""} ORDER BY id DESC LIMIT 1`;
    const values = [this.owner, thread, ns, ...(id ? [id] : [])];
    const selectedId = `SELECT id FROM ai_checkpoints WHERE ${where}`;
    // 父 marker、pending writes 与密文碎片必须来自同一个读取事务。
    // 同 id 重写会级联删除旧 token；事务结束后只解密本批内存数据，避免
    // 正常并发替换被误判为丢片，也不把大密文聚合成超过 D1 限制的一行。
    const [parents, writes, checkpointChunks, writeChunks] = await this.db.batch<Saved | Write | CheckpointChunk | WriteChunk>([
      this.db.prepare(`SELECT * FROM ai_checkpoints WHERE ${where}`).bind(...values),
      ...[
        ["ai_writes", "task,path,idx,channel,value"],
        ["ai_checkpoint_chunks", "field,token,part,value"],
        ["ai_write_chunks", "task,idx,token,part,value"],
      ].map(([table, columns]) => this.db.prepare(
        `SELECT ${columns} FROM ${table} WHERE owner=? AND thread=? AND ns=? AND checkpoint=(${selectedId})`,
      ).bind(this.owner, thread, ns, ...values)),
    ]);
    const row = parents.results[0] as Saved | undefined;
    return row ? this.tuple(row, writes.results as Write[], checkpointChunks.results as CheckpointChunk[], writeChunks.results as WriteChunk[]) : undefined;
  }
  async *list(config: RunnableConfig, options: CheckpointListOptions = {}) {
    const { thread, ns } = this.scope(config);
    const rows = await this.db
      .prepare(
        "SELECT id FROM ai_checkpoints WHERE owner=? AND thread=? AND ns=? AND id<? ORDER BY id DESC",
      )
      .bind(
        this.owner,
        thread,
        ns,
        options.before?.configurable?.checkpoint_id ?? "~",
      )
      .all<{ id: string }>();
    let n = 0;
    for (const row of rows.results) {
      // 列表索引之后允许删除/替换；每个条目重新取得完整事务快照。
      const t = await this.getTuple({ configurable: { thread_id: thread, checkpoint_ns: ns, checkpoint_id: row.id } });
      if (!t) continue;
      if (
        options.filter &&
        !Object.entries(options.filter).every(
          ([k, v]) =>
            JSON.stringify(
              (t.metadata as Record<string, unknown> | undefined)?.[k],
            ) === JSON.stringify(v),
        )
      )
        continue;
      if (n++ >= (options.limit ?? Infinity)) break;
      yield t;
    }
  }
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ) {
    const { thread, ns } = this.scope(config);
    const fence = this.fence(thread);
    const [data, meta] = await Promise.all([
      this.encode(checkpoint),
      this.encode(metadata),
    ]);
    await this.guard();
    const parent = this.db
      .prepare(
        `INSERT OR REPLACE INTO ai_checkpoints(owner,thread,ns,id,parent,checkpoint,metadata,at) SELECT ?,?,?,?,?,?,?,? WHERE ${fence.sql}`,
      )
      .bind(
        this.owner,
        thread,
        ns,
        checkpoint.id,
        config.configurable?.checkpoint_id ?? null,
        data.value,
        meta.value,
        new Date().toISOString(),
        ...fence.values,
      );
    const location = { thread, ns, checkpoint: checkpoint.id };
    const [saved] = await this.db.batch([
      parent,
      ...this.chunkWrites({ ...location, field: "checkpoint" }, data),
      ...this.chunkWrites({ ...location, field: "metadata" }, meta),
    ]);
    if (!saved.meta.changes) throw Error("GRAPH_STALE");
    return {
      configurable: {
        thread_id: thread,
        checkpoint_ns: ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath = "",
  ) {
    const { thread, ns } = this.scope(config),
      id = config.configurable?.checkpoint_id;
    if (!id) throw new Error("AI_CHECKPOINT_REQUIRED");
    const fence = this.fence(thread);
    const statements = await Promise.all(
      writes.map(async ([channel, value], i) => {
        const idx = WRITES_IDX_MAP[channel] ?? i;
        const packed = await this.encode(value);
        return [this.db
          .prepare(
            `INSERT ${idx < 0 ? "OR REPLACE" : "OR IGNORE"} INTO ai_writes(owner,thread,ns,checkpoint,task,path,idx,channel,value) SELECT ?,?,?,?,?,?,?,?,? WHERE ${fence.sql}`,
          )
          .bind(
            this.owner,
            thread,
            ns,
            id,
            taskId,
            taskPath,
            idx,
            channel,
            packed.value,
            ...fence.values,
          ), ...this.chunkWrites({ thread, ns, checkpoint: String(id), task: taskId, idx }, packed)];
      }),
    );
    await this.guard();
    if (statements.length) await this.db.batch(statements.flat());
    if (
      this.fenced &&
      !(await this.db
        .prepare(`SELECT 1 WHERE ${fence.sql}`)
        .bind(...fence.values)
        .first())
    )
      throw Error("GRAPH_STALE");
  }
  async deleteThread(thread: string) {
    await this.db.batch(
      ["ai_writes", "ai_checkpoints"].map((t) =>
        this.db
          .prepare(`DELETE FROM ${t} WHERE owner=? AND thread=?`)
          .bind(this.owner, thread),
      ),
    );
  }
}
