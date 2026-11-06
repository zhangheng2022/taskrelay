/**
 * 将云端交办决策转为任务快照与待投递命令，在同一事务中保存二者。
 * 后续投递以回合标识去重，使中断后的补投不会重复创建执行批次。
 */
import { z } from "zod";
import type { AppEnv } from "../env";
import { now, taskFrom, type Row } from "../store";
import { advanceDispatchGroups, ensureDispatchGroup } from "../account-dispatch";
import { accountMatchesDomain } from "../accounts";
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
  plan: Pick<TaskDefinition, "executionOutline" | "graphVersion" | "accountIds"> = {},
) {
  if (
    await env.DB.prepare("SELECT id FROM conversation_commands WHERE id=?").bind(turnId).first()
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
      "SELECT id FROM runs WHERE task_id=? AND (status IN ('queued','running','waiting_user','verifying','unknown') OR cleanup_pending=1) UNION ALL SELECT id FROM account_dispatch_groups WHERE task_id=? AND state IN ('active','paused')",
    )
      .bind(base.id, base.id)
      .first())
  )
    throw Error("RUN_ALREADY_ACTIVE");
  const parsed = taskInputSchema.parse({ ...input, modelId: t.model_id });
  if (parsed.schedule.kind !== "manual") throw Error("SCHEDULE_NOT_SUPPORTED");
  const entry = publicUrl(parsed.entryUrl);
  const { profile } = await getModelProfile(env, t.model_id, t.model_version);
  if (
    !profile.capabilities.connection ||
    !profile.capabilities.tools ||
    profile.capabilities.structured === "none"
  )
    throw Error("MODEL_CAPABILITIES_REQUIRED");
  const accountIds = [
    ...new Set(
      plan.accountIds?.length ? plan.accountIds : parsed.accountId ? [parsed.accountId] : [],
    ),
  ];
  for (const accountId of accountIds) {
    const account = await env.DB.prepare(
      "SELECT origin,business_domains FROM accounts WHERE id=? AND user_id=?",
    )
      .bind(accountId, t.user_id)
      .first<{ origin: string; business_domains: string }>();
    if (!account || !accountMatchesDomain(account, entry.href))
      throw Error("ACCOUNT_ORIGIN_MISMATCH");
  }
  const definition: TaskDefinition = {
    ...parsed,
    ...plan,
    accountId: accountIds[0] ?? null,
    accountIds,
    id: base?.id ?? `task_${(await hash(turnId)).slice(0, 40)}`,
    version: (base?.version ?? 0) + 1,
    modelVersion: t.model_version,
    status: "pending_validation",
    createdAt: base?.createdAt ?? now(),
    nextRunAt: null,
  };
  const fence = "EXISTS(SELECT 1 FROM conversation_commands WHERE id=? AND state='pending')";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO conversation_commands(id,thread_id,task_id,run_task,created_at)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ai_threads WHERE id=? AND active_turn=? AND version=? AND closed=0)`,
    ).bind(turnId, t.id, definition.id, JSON.stringify(definition), now(), t.id, turnId, t.version),
    env.DB.prepare(
      `INSERT INTO tasks(id,version,definition,status,next_run_at,created_at,updated_at,user_id)
      SELECT ?,?,?,?,NULL,?,?,? WHERE ${fence} ON CONFLICT(id) DO UPDATE SET version=excluded.version,definition=excluded.definition,status=excluded.status,next_run_at=NULL,confirmed_condition=NULL,context_withdrawn=0,updated_at=excluded.updated_at`,
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
    ).bind(definition.id, definition.version, JSON.stringify(definition), turnId),
    env.DB.prepare(`UPDATE ai_threads SET task_id=? WHERE id=? AND ${fence}`).bind(
      definition.id,
      t.id,
      turnId,
    ),
    env.DB.prepare(
      "UPDATE conversation_commands SET state='committed' WHERE id=? AND state='pending'",
    ).bind(turnId),
  ]);
  if (
    !(await env.DB.prepare("SELECT id FROM conversation_commands WHERE id=?").bind(turnId).first())
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
    if (row.run_task) {
      try {
        // 读取后聊天仍可能被删除或撤回；把原命令及原聊天的有效性放到
        // INSERT 内原子检查，不能让旧命令重新挂到同任务的新聊天。
        await ensureDispatchGroup(env.DB, row);
        await advanceDispatchGroups(env.DB, row.id);
      } catch (error) {
        if ((error as Error).message !== "COMMAND_RETIRED") throw error;
      }
    }
    await env.DB.prepare(
      "UPDATE conversation_commands SET state='done' WHERE id=? AND state='committed'",
    )
      .bind(row.id)
      .run();
  }
}
