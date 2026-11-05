/**
 * 将云端交办决策转为任务快照与待投递命令，在同一事务中保存二者。
 * 后续投递以回合标识去重，使中断后的补投不会重复创建执行批次。
 */
import { z } from "zod";
import type { AppEnv } from "../env";
import { enqueue, now, taskFrom, type Row } from "../store";
import { getModelProfile } from "../models";
import { hash, publicUrl } from "../../../../packages/contracts/src/security";
import {
  taskInputSchema,
  type TaskDefinition,
  type TaskInput,
} from "../../../../packages/contracts/src/index";

export const conditionsSchema = z.object({
  goal: z.string().min(1).max(2000),
  scope: z.string().min(1).max(2000),
  prerequisites: z.array(z.string().max(500)).max(10),
  completion: z.string().min(1).max(2000),
  assistance: z.array(z.string().max(500)).max(10),
});

/** Commit the current handoff and its outbox together; retries never start twice. */
export async function commitDecision(
  env: AppEnv,
  t: Row,
  turnId: string,
  input: Omit<TaskInput, "modelId">,
  plan: Pick<TaskDefinition, "executionOutline" | "graphVersion"> = {},
) {
  if (
    await env.DB.prepare("SELECT id FROM conversation_commands WHERE id=?")
      .bind(turnId)
      .first()
  ) {
    await drainCommands(env, turnId);
    return;
  }
  const existing = t.task_id
    ? await env.DB.prepare("SELECT * FROM tasks WHERE id=? AND user_id=?")
        .bind(t.task_id, t.user_id)
        .first<Row>()
    : null;
  const base = existing ? taskFrom(existing) : null;
  if (
    base &&
    (await env.DB.prepare(
      "SELECT id FROM runs WHERE task_id=? AND status IN ('queued','running','waiting_user','verifying','unknown')",
    )
      .bind(base.id)
      .first())
  )
    throw Error("RUN_ALREADY_ACTIVE");
  const parsed = taskInputSchema.parse({ ...input, modelId: t.model_id });
  if (parsed.schedule.kind !== "manual") throw Error("SCHEDULE_NOT_SUPPORTED");
  const origin = publicUrl(parsed.entryUrl).origin;
  const { profile } = await getModelProfile(env, t.model_id, t.model_version);
  if (
    !profile.capabilities.connection ||
    !profile.capabilities.tools ||
    profile.capabilities.structured === "none"
  )
    throw Error("MODEL_CAPABILITIES_REQUIRED");
  if (parsed.accountId) {
    const account = await env.DB.prepare(
      "SELECT origin FROM accounts WHERE id=? AND user_id=?",
    )
      .bind(parsed.accountId, t.user_id)
      .first<{ origin: string }>();
    if (!account || account.origin !== origin)
      throw Error("ACCOUNT_ORIGIN_MISMATCH");
  }
  const definition: TaskDefinition = {
    ...parsed,
    ...plan,
    id: base?.id ?? `task_${(await hash(turnId)).slice(0, 40)}`,
    version: (base?.version ?? 0) + 1,
    modelVersion: t.model_version,
    status: "pending_validation",
    createdAt: base?.createdAt ?? now(),
    nextRunAt: null,
  };
  const fence =
    "EXISTS(SELECT 1 FROM conversation_commands WHERE id=? AND state='pending')";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO conversation_commands(id,thread_id,task_id,run_task,created_at)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ai_threads WHERE id=? AND active_turn=? AND version=? AND closed=0)`,
    ).bind(
      turnId,
      t.id,
      definition.id,
      JSON.stringify(definition),
      now(),
      t.id,
      turnId,
      t.version,
    ),
    env.DB.prepare(
      `INSERT INTO tasks(id,version,definition,status,next_run_at,created_at,updated_at,user_id)
      SELECT ?,?,?,?,NULL,?,?,? WHERE ${fence} ON CONFLICT(id) DO UPDATE SET version=excluded.version,definition=excluded.definition,status=excluded.status,next_run_at=NULL,confirmed_condition=NULL,updated_at=excluded.updated_at`,
    ).bind(
      definition.id,
      definition.version,
      JSON.stringify(definition),
      definition.status,
      definition.createdAt,
      now(),
      t.user_id,
      turnId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO task_versions(task_id,version,definition) SELECT ?,?,? WHERE ${fence}`,
    ).bind(
      definition.id,
      definition.version,
      JSON.stringify(definition),
      turnId,
    ),
    env.DB.prepare(
      `UPDATE ai_threads SET task_id=? WHERE id=? AND ${fence}`,
    ).bind(definition.id, t.id, turnId),
    env.DB.prepare(
      "UPDATE conversation_commands SET state='committed' WHERE id=? AND state='pending'",
    ).bind(turnId),
  ]);
  if (
    !(await env.DB.prepare("SELECT id FROM conversation_commands WHERE id=?")
      .bind(turnId)
      .first())
  )
    throw Error("TURN_STALE");
  await drainCommands(env, turnId);
}

export async function drainCommands(env: AppEnv, id?: string) {
  const rows = await env.DB.prepare(
    "SELECT * FROM conversation_commands WHERE state='committed'" +
      (id ? " AND id=?" : "") +
      " LIMIT 20",
  )
    .bind(...(id ? [id] : []))
    .all<Row>();
  for (const row of rows.results) {
    if (row.run_task)
      await enqueue(
        env.DB,
        JSON.parse(row.run_task),
        `manual:conversation:${row.id}`,
      );
    await env.DB.prepare(
      "UPDATE conversation_commands SET state='done' WHERE id=? AND state='committed'",
    )
      .bind(row.id)
      .run();
  }
}
