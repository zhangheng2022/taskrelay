import type { AppEnv } from "./env";
import type { ExecutionHelp, HelpResponse } from "../../../packages/contracts/src/execution";
import type { TaskRun } from "../../../packages/contracts/src/index";
import { hash } from "../../../packages/contracts/src/security";
import { runThread } from "./chat-messages";
import { now, requireLease, type Row } from "./store";
import { seal, unseal } from "./crypto";
import { dispatchGraphEvent, wakeGraph } from "./ai/dispatch";

type StoredResponse = Omit<HelpResponse, "message"> & {
  encrypted?: string;
  message?: string;
};

/** Persist a reference to the encrypted original, never copy reply text into dispatch. */
export async function queueHelpReply(env: AppEnv, helpId: string, messageId: string) {
  const help = await env.DB.prepare(
    `SELECT h.*,r.user_id FROM execution_help h JOIN runs r ON r.id=h.run_id
    JOIN ai_threads t ON t.id=h.thread_id AND t.closed=0 WHERE h.id=? AND h.awaiting_user=1 AND h.graph_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM ai_messages m WHERE m.id=? AND m.thread_id=h.thread_id AND m.reply_to=h.id AND m.role='user')`,
  )
    .bind(helpId, messageId)
    .first<Row>();
  if (!help) return;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO ai_dispatch
    (id,graph_id,thread_id,owner,kind,run_id,help_id,message_id,interrupt_id,question_round,created_at)
    SELECT ?,?,?,?,'resume',?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ai_threads WHERE id=? AND closed=0)
      AND EXISTS(SELECT 1 FROM execution_help WHERE id=? AND graph_id=? AND awaiting_user=1 AND question_round=?)`,
  )
    .bind(
      `${help.graph_id}:reply:${messageId}`,
      help.graph_id,
      help.thread_id,
      help.user_id,
      help.run_id,
      help.id,
      messageId,
      help.interrupt_id,
      help.question_round,
      now(),
      help.thread_id,
      help.id,
      help.graph_id,
      help.question_round,
    )
    .run();
  await wakeGraph(env, help.graph_id);
}

/** Device polling reads a durable result. Only the alarm performs cloud assistance. */
export async function resolveHelp(
  env: AppEnv,
  run: TaskRun,
  help: ExecutionHelp,
): Promise<HelpResponse> {
  const thread = await runThread(env, run.id);
  const graphId = `help_${await hash(`${run.id}:${run.leaseEpoch}:${help.id}`)}`;
  const request = {
    id: help.id,
    origin: help.origin,
    encryptedMessage: await seal(help.message, env.MASTER_KEY, `help-request:${run.id}:${help.id}`),
  };
  await requireLease(env.DB, run.id, run.deviceId!, run.leaseEpoch);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO execution_help(id,run_id,thread_id,epoch,request,created_at,graph_id)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ai_threads WHERE id=? AND closed=0)`,
    ).bind(
      help.id,
      run.id,
      thread.id,
      run.leaseEpoch,
      JSON.stringify(request),
      now(),
      graphId,
      thread.id,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO ai_dispatch(id,graph_id,thread_id,owner,kind,run_id,help_id,created_at)
      SELECT ?,?,?,?,'help',?,?,? WHERE EXISTS(SELECT 1 FROM execution_help h JOIN ai_threads t ON t.id=h.thread_id AND t.closed=0 WHERE h.id=? AND run_id=? AND epoch=? AND graph_id=?)`,
    ).bind(
      `${graphId}:start`,
      graphId,
      thread.id,
      run.userId,
      run.id,
      help.id,
      now(),
      help.id,
      run.id,
      run.leaseEpoch,
      graphId,
    ),
  ]);
  const prior = await env.DB.prepare(
    "SELECT * FROM execution_help WHERE id=? AND run_id=? AND epoch=? AND graph_id=?",
  )
    .bind(help.id, run.id, run.leaseEpoch, graphId)
    .first<Row>();
  if (!prior) throw Error("HELP_STALE");
  const original = JSON.parse(prior.request) as typeof request;
  if (
    original.origin !== help.origin ||
    (await unseal<string>(
      original.encryptedMessage,
      env.MASTER_KEY,
      `help-request:${run.id}:${help.id}`,
    )) !== help.message
  )
    throw Error("HELP_INPUT_CONFLICT");
  // 执行器求助保留在加密 request 中；只有协助图确认缺少信息才发布用户问题。
  if (prior.awaiting_user && prior.reply_message_id)
    await queueHelpReply(env, help.id, prior.reply_message_id);
  await wakeGraph(env, graphId);
  if (!env.AI_TURNS && env.DEV_MODE === "1")
    await dispatchGraphEvent({ ...env, requestUserId: run.userId }, graphId);
  const saved = await env.DB.prepare(
    "SELECT response,awaiting_user,question_round FROM execution_help WHERE id=? AND run_id=? AND epoch=?",
  )
    .bind(help.id, run.id, run.leaseEpoch)
    .first<{ response: string | null; awaiting_user: number; question_round: number }>();
  if (saved?.response) {
    const { encrypted, ...references } = JSON.parse(saved.response) as StoredResponse;
    return encrypted
      ? {
          ...references,
          ...(await unseal<{ message?: string }>(
            encrypted,
            env.MASTER_KEY,
            `help:${run.id}:${help.id}`,
          )),
        }
      : references;
  }
  const failed = await env.DB.prepare(
    "SELECT error FROM ai_dispatch WHERE graph_id=? AND state='failed' ORDER BY created_at DESC LIMIT 1",
  )
    .bind(graphId)
    .first<{ error: string }>();
  if (failed) throw Error(failed.error);
  return { ready: false, ...(saved?.awaiting_user ? { questionRound: saved.question_round } : {}) };
}
