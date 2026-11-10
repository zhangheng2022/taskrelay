/** 正文草稿的授权与发布 adapter。目标只由云端业务入口构造；每批核对原会话、回合或租约。
 * 密文快照归 NotificationHub，正式聊天与执行状态仍由原事务拥有。 */
import type { AppEnv } from "./env";
import { graphWriteFence } from "./ai/fence";
import { dbTime } from "./database";
import { previewText } from "../../../packages/model/src/preview";
import type { ChatDraft } from "../../../packages/contracts/src/streaming";

export type DraftTarget = {
  threadId: string;
  id: string;
  mode: "text" | "reply" | "question";
  source: "cloud" | "executor";
  version?: number;
  graphId?: string;
  generation?: number;
  turnId?: string;
  runId?: string;
  epoch?: number;
  deviceId?: string;
  userSeq?: number;
};
export type DraftPublication = { owner: string; target: DraftTarget; draft: ChatDraft };
export async function allowedDraft(env: AppEnv, owner: string, target: DraftTarget) {
  const graph = target.graphId
    ? graphWriteFence(owner, target.graphId, target.generation)
    : undefined;
  return !!(await env.DB.prepare(
    `SELECT id FROM ai_threads WHERE id=? AND user_id=? AND closed=0
    AND EXISTS(SELECT 1 FROM members WHERE id=ai_threads.user_id AND disabled=0)
    ${target.turnId ? "AND active_turn=?" : ""}
    ${graph ? `AND ${graph.sql}` : ""}
    ${target.runId ? `AND EXISTS(SELECT 1 FROM runs r WHERE r.id=? AND r.thread_id=ai_threads.id AND r.user_id=ai_threads.user_id AND r.history_deleted=0 AND r.cancel_requested=0 AND r.status IN ('running','waiting_user','verifying') AND r.lease_epoch=? AND r.device_id=? AND r.lease_expires_at>? AND EXISTS(SELECT 1 FROM devices d WHERE d.id=r.device_id AND d.revoked=0))` : ""}
    ${target.userSeq !== undefined ? "AND (SELECT COALESCE(MAX(seq),0) FROM ai_messages WHERE thread_id=ai_threads.id AND role='user')=?" : ""}`,
  )
    .bind(
      target.threadId,
      owner,
      ...(target.turnId ? [target.turnId] : []),
      ...(graph?.values ?? []),
      ...(target.runId
        ? [
            target.runId,
            target.epoch ?? -1,
            target.deviceId ?? "",
            dbTime(new Date().toISOString()),
          ]
        : []),
      ...(target.userSeq !== undefined ? [target.userSeq] : []),
    )
    .first());
}
export async function closeDrafts(env: AppEnv, owner: string, threadId: string, callId?: string) {
  await env.NOTIFICATIONS?.getByName("user:" + owner)
    .closeDrafts(threadId, callId)
    .catch(() => {});
}
export function draftPublisher(env: AppEnv, owner: string, callId: string, target?: DraftTarget) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  let last = 0,
    seq = 0,
    text = "",
    published = "";
  const at = new Date().toISOString();
  const send = async (status: ChatDraft["status"], force = false) => {
    if (
      !target ||
      !env.NOTIFICATIONS ||
      (!force && (Date.now() - last < 250 || text === published))
    )
      return;
    if (!text && !published && status !== "interrupted") return;
    last = Date.now();
    published = text;
    const draft: ChatDraft = {
      id: target.id,
      threadId: target.threadId,
      callId,
      version: target.version ?? 0,
      seq: ++seq,
      content: text,
      at,
      source: target.source,
      status,
    };
    // 预览传输失败不重发模型，不把 UI 断线解释为业务失败。
    await env.NOTIFICATIONS.getByName("user:" + owner)
      .publishDraft({ owner, target, draft })
      .catch(() => {});
  };
  return {
    async text(value: string) {
      text = target ? previewText(value, target.mode) : "";
      if (!target || text === published) return;
      if (Date.now() - last >= 250) {
        pending = pending.then(() => send("streaming"));
        await pending;
      } else if (timer === undefined) {
        timer = setTimeout(
          () => {
            timer = undefined;
            pending = pending.then(() => send("streaming"));
          },
          Math.max(0, 250 - (Date.now() - last)),
        );
      }
    },
    async end(failed = false) {
      clearTimeout(timer);
      await pending;
      await send(failed ? "interrupted" : "pending", true);
    },
  };
}
