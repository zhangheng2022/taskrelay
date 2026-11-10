import { dbTime } from "./database";
/**
 * 统一聊天消息的幂等写入、敏感正文加密与执行上下文读取，供交办和执行协助共用。
 * 消息绑定原会话，关闭的会话拒绝新写入；运行上下文解密前校验任务与会话归属。
 */
import type { AppEnv } from "./env";
import { now, type Row } from "./store";
import { seal, unseal } from "./crypto";
import type { ChatPart } from "../../../packages/contracts/src/execution";
import { notifyUser } from "./notifications";

interface ContextRow {
  id: string;
  seq: number;
  role: string;
  content: string;
  source: string;
  parts: string;
  reply_to: string | null;
  run_id: string | null;
  private_content: string | null;
  context_withdrawn: number;
  origin: string | null;
  accountId: string | null;
}

export async function runThread(env: AppEnv, runId: string) {
  const row = await env.DB.prepare(
    "SELECT t.* FROM ai_threads t JOIN runs r ON r.thread_id=t.id WHERE r.id=? AND t.user_id=r.user_id AND t.closed=0",
  )
    .bind(runId)
    .first<Row>();
  if (!row) throw Error("THREAD_NOT_FOUND");
  return row;
}
export interface ChatMessageWrite {
  id: string;
  turnId?: string;
  role?: "user" | "assistant";
  source: "user" | "cloud" | "executor";
  content: string;
  parts?: ChatPart[];
  runId?: string;
  replyTo?: string;
  private?: boolean;
  at?: string;
  sourceCallId?: string;
}

/** Compose encrypted chat publication with a domain transaction without copying its storage rules. */
export async function messageStatement(
  env: AppEnv,
  threadId: string,
  message: ChatMessageWrite,
  fence?: { sql: string; values: (string | number | null)[] },
) {
  const secret =
    message.private || (message.role === "user" && message.runId !== undefined)
      ? await seal(message.content, env.MASTER_KEY, `message:${threadId}:${message.id}`)
      : null;
  // 元数据与正文一同交给调用方事务；重复发布只能读取既有正文，不能覆盖。
  return [
    env.DB.prepare(
      `INSERT OR IGNORE INTO ai_messages(id,thread_id,seq,role,turn_id,at,source,run_id,reply_to,source_call_id,context_withdrawn)
    SELECT ?,id,(SELECT COALESCE(MAX(seq),0)+1 FROM ai_messages WHERE thread_id=?),?,?,?,?,?,?,?,
      CASE WHEN EXISTS(SELECT 1 FROM runs WHERE id=? AND context_withdrawn=1) THEN 1 ELSE 0 END
      FROM ai_threads WHERE id=? AND closed=0 ${fence ? `AND (${fence.sql})` : ""}`,
    ).bind(
      message.id,
      threadId,
      message.role ?? "assistant",
      message.turnId ?? message.id,
      dbTime(message.at ?? now()),
      message.source,
      message.runId ?? null,
      message.replyTo ?? null,
      message.sourceCallId ?? null,
      message.role === "user" ? null : (message.runId ?? null),
      threadId,
      ...(fence?.values ?? []),
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO message_bodies(id,content,private_content,parts)
     SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM ai_messages WHERE id=? AND thread_id=?)`,
    ).bind(
      message.id,
      secret ? "[用户已提供私密信息]" : message.content,
      secret,
      JSON.stringify(message.parts ?? []),
      message.id,
      threadId,
    ),
  ];
}
export async function appendMessage(env: AppEnv, threadId: string, message: ChatMessageWrite) {
  const insert = await messageStatement(env, threadId, message);
  await env.DB.batch([
    ...insert,
    ...(message.role === "user" && message.replyTo
      ? [
          env.DB.prepare(
            "UPDATE execution_help SET reply_message_id=? WHERE id=? AND thread_id=? AND reply_message_id IS NULL AND EXISTS(SELECT 1 FROM ai_messages WHERE id=? AND thread_id=?)",
          ).bind(message.id, message.replyTo, threadId, message.id, threadId),
        ]
      : []),
  ]);
  const t = await env.DB.prepare("SELECT user_id FROM ai_threads WHERE id=?")
    .bind(threadId)
    .first<{ user_id: string }>();
  if (t) {
    await env.NOTIFICATIONS?.getByName("user:" + t.user_id)
      .closeDrafts(threadId, message.sourceCallId, message.id)
      .catch(() => {});
    await notifyUser(env, t.user_id).catch(() => {});
  }
}
export async function conversationContext(
  env: AppEnv,
  threadId: string,
  after = 0,
  options?: { runId: string },
) {
  // Only an owning task may opt into the user's encrypted conversation context.
  // Other readers retain placeholders; the user's history is decrypted by threadPage.
  if (
    options &&
    !(await env.DB.prepare(
      "SELECT r.id FROM runs r JOIN ai_threads t ON t.id=r.thread_id AND t.user_id=r.user_id WHERE r.id=? AND t.id=? AND t.closed=0",
    )
      .bind(options.runId, threadId)
      .first())
  )
    throw Error("THREAD_NOT_FOUND");
  const rows = await env.DB.prepare(
    `SELECT m.id,m.seq,m.role,m.content,m.source,m.parts,m.reply_to,m.run_id,m.private_content,m.context_withdrawn,
    (SELECT json_extract(h.request,'$.origin') FROM execution_help h WHERE h.thread_id=m.thread_id AND (h.id=m.reply_to OR h.id||'_request'=m.reply_to) LIMIT 1) AS origin,
    (SELECT account_id FROM runs WHERE id=m.run_id) AS accountId
    FROM message_details m WHERE m.thread_id=? AND m.seq>? ORDER BY m.seq`,
  )
    .bind(threadId, after)
    .all<ContextRow>();
  return Promise.all(
    rows.results.map(async ({ private_content, context_withdrawn, ...r }) => ({
      ...r,
      private: !!private_content,
      // 撤回与加密不是同一状态；本人历史可解密，任何后续任务上下文只保留占位。
      content: context_withdrawn
        ? "[用户已将这条内容设为仅本人可见]"
        : private_content
          ? options
            ? await unseal<string>(private_content, env.MASTER_KEY, `message:${threadId}:${r.id}`)
            : "[私密回复已提供，请通过协助通道使用]"
          : r.content,
      parts: context_withdrawn ? [] : JSON.parse(r.parts),
    })),
  );
}
