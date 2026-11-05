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
    return seal(
      {
        type,
        bytes: Buffer.from(bytes).toString("base64"),
        encoding: "base64",
      },
      this.key,
      `ai-checkpoint:${this.owner}`,
    );
  }
  private async decode<T>(value: string): Promise<T> {
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
  private async tuple(row: Saved): Promise<CheckpointTuple> {
    const writes = await this.db
      .prepare(
        "SELECT task,path,idx,channel,value FROM ai_writes WHERE owner=? AND thread=? AND ns=? AND checkpoint=?",
      )
      .bind(this.owner, row.thread, row.ns, row.id)
      .all<Write>();
    writes.results.sort((a, b) =>
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
      checkpoint: await this.decode<Checkpoint>(row.checkpoint),
      metadata: await this.decode<CheckpointMetadata>(row.metadata),
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
        writes.results.map(
          async (w) =>
            [w.task, w.channel, await this.decode(w.value)] as [
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
    const row = await this.db
      .prepare(
        `SELECT * FROM ai_checkpoints WHERE owner=? AND thread=? AND ns=? ${id ? "AND id=?" : ""} ORDER BY id DESC LIMIT 1`,
      )
      .bind(this.owner, thread, ns, ...(id ? [id] : []))
      .first<Saved>();
    return row ? this.tuple(row) : undefined;
  }
  async *list(config: RunnableConfig, options: CheckpointListOptions = {}) {
    const { thread, ns } = this.scope(config);
    const rows = await this.db
      .prepare(
        "SELECT * FROM ai_checkpoints WHERE owner=? AND thread=? AND ns=? AND id<? ORDER BY id DESC",
      )
      .bind(
        this.owner,
        thread,
        ns,
        options.before?.configurable?.checkpoint_id ?? "~",
      )
      .all<Saved>();
    let n = 0;
    for (const row of rows.results) {
      const t = await this.tuple(row);
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
    const saved = await this.db
      .prepare(
        `INSERT OR REPLACE INTO ai_checkpoints(owner,thread,ns,id,parent,checkpoint,metadata,at) SELECT ?,?,?,?,?,?,?,? WHERE ${fence.sql}`,
      )
      .bind(
        this.owner,
        thread,
        ns,
        checkpoint.id,
        config.configurable?.checkpoint_id ?? null,
        data,
        meta,
        new Date().toISOString(),
        ...fence.values,
      )
      .run();
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
        return this.db
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
            await this.encode(value),
            ...fence.values,
          );
      }),
    );
    await this.guard();
    if (statements.length) await this.db.batch(statements);
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
