import { applicationDb } from "./database";
/** 休眠 WebSocket 分发变化、设备版本通知与可选正文草稿；短期加密快照供断线恢复。
 * 每次推送复查身份，草稿串行仲裁；正式消息和任务状态仍由鉴权 API 与业务事务拥有。 */
import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "./env";
import { seal, unseal } from "./crypto";
import { allowedDraft, type DraftPublication } from "./chat-drafts";
import type { ChatDraft, DraftEvent } from "../../../packages/contracts/src/streaming";
import type { UpdateEvent } from "../../../packages/contracts/src/updates";
type Subscriber = {
  owner?: string;
  session?: string;
  device?: string;
  expires: number;
  protocol?: number;
  pendingDraft?: boolean;
  draftChanged?: boolean;
};
type SavedDraft = { parts: number; expires: number };
export class NotificationHub extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, { ...env, DB: applicationDb(env.DB) });
  }
  async fetch(request: Request) {
    const subscriber = JSON.parse(request.headers.get("x-subscriber") ?? "null") as Subscriber;
    if (!subscriber || request.headers.get("upgrade") !== "websocket")
      return new Response(null, { status: 400 });
    if (this.ctx.getWebSockets().length >= 8) return new Response(null, { status: 429 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(subscriber);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async publish(event?: DraftEvent | UpdateEvent) {
    const update = event?.type === "update.available";
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Subscriber;
      const allowed =
        s.expires > Date.now() &&
        (s.device
          ? await this.env.DB.prepare("SELECT id FROM devices WHERE id=? AND revoked=0")
              .bind(s.device)
              .first()
          : await this.env.DB.prepare(
              "SELECT s.id FROM auth_session s JOIN members m ON m.auth_id=s.userId WHERE s.id=? AND s.expiresAt>? AND m.id=? AND m.disabled=0",
            )
              .bind(s.session, Date.now(), s.owner)
              .first());
      if (!allowed) {
        ws.close(1008, "Session expired");
        continue;
      }
      try {
        if (update && !s.device) continue;
        if (event && !update && (s.protocol !== 2 || s.device)) continue;
        // 每连接最多一帧未确认正文，慢客户端跳过中间帧并通过快照追赶。
        if (event && !update && s.pendingDraft) {
          ws.serializeAttachment({ ...s, draftChanged: true });
          continue;
        }
        ws.send(event ? JSON.stringify(event) : "changed");
        if (event && !update)
          ws.serializeAttachment({ ...s, pendingDraft: true, draftChanged: false });
      } catch {
        ws.close();
      }
    }
  }
  private async readDraft(key: string, saved: SavedDraft) {
    const keys = Array.from({ length: saved.parts }, (_, i) => `body:${key}:${i}`);
    const parts = await this.ctx.storage.get<string>(keys);
    const cipher = keys
      .map((k) => {
        const part = parts.get(k);
        if (part === undefined) throw Error("DRAFT_SNAPSHOT_MISSING");
        return part;
      })
      .join("");
    return unseal<DraftPublication>(cipher, this.env.MASTER_KEY, key);
  }
  private async deleteDraft(key: string, saved: SavedDraft) {
    await this.ctx.storage.delete([
      key,
      ...Array.from({ length: saved.parts }, (_, i) => `body:${key}:${i}`),
    ]);
  }
  /** 草稿更新在同一对象串行仲裁；删除 tombstone 阻止已经排队的迟到批次重新落盘。 */
  async publishDraft(publication: DraftPublication) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const { owner, target, draft } = publication;
      if (
        (await this.ctx.storage.get(`closed:${target.threadId}`)) ||
        !(await allowedDraft(this.env, owner, target))
      )
        return;
      if (
        await this.env.DB.prepare(
          "SELECT id FROM ai_messages WHERE thread_id=? AND (id=? OR source_call_id=?)",
        )
          .bind(target.threadId, draft.id, draft.callId)
          .first()
      )
        return;
      const key = `draft:${target.threadId}:${target.id}`;
      const saved = await this.ctx.storage.get<SavedDraft>(key);
      const prior = saved ? await this.readDraft(key, saved) : undefined;
      if (
        prior &&
        (prior.draft.version > draft.version ||
          (prior.draft.version === draft.version &&
            prior.draft.callId === draft.callId &&
            prior.draft.seq >= draft.seq))
      )
        return;
      const expires = Date.now() + 600_000;
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > Date.now() + 60_000)
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
      const cipher = await seal(publication, this.env.MASTER_KEY, key);
      const parts = Math.ceil(cipher.length / 60000);
      const values: Record<string, unknown> = { [key]: { expires, parts } };
      for (let i = 0; i < parts; i++)
        values[`body:${key}:${i}`] = cipher.slice(i * 60000, (i + 1) * 60000);
      await this.ctx.storage.put(values);
      if (saved && saved.parts > parts)
        await this.ctx.storage.delete(
          Array.from({ length: saved.parts - parts }, (_, i) => `body:${key}:${i + parts}`),
        );
      await this.publish({ protocol: 2, type: prior ? "draft.update" : "draft.start", draft });
    });
  }
  async drafts(owner: string, threadId: string): Promise<ChatDraft[]> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const rows = await this.ctx.storage.list<SavedDraft>({ prefix: `draft:${threadId}:` });
      const result: ChatDraft[] = [];
      for (const [key, saved] of rows) {
        if (saved.expires <= Date.now()) {
          await this.deleteDraft(key, saved);
          continue;
        }
        const value = await this.readDraft(key, saved);
        if (value.owner !== owner) continue;
        if (
          !(await this.env.DB.prepare(
            "SELECT id FROM ai_threads WHERE id=? AND user_id=? AND closed=0",
          )
            .bind(threadId, owner)
            .first())
        )
          continue;
        const live = await allowedDraft(this.env, owner, value.target);
        if (
          await this.env.DB.prepare(
            "SELECT id FROM ai_messages WHERE thread_id=? AND (id=? OR source_call_id=?)",
          )
            .bind(threadId, value.draft.id, value.draft.callId)
            .first()
        ) {
          await this.deleteDraft(key, saved);
          continue;
        }
        const call = await this.env.DB.prepare(
          "SELECT status FROM ai_calls WHERE id=? AND user_id=?",
        )
          .bind(value.draft.callId, owner)
          .first<{ status: string }>();
        result.push({
          ...value.draft,
          status:
            !live || (call && ["failed", "unknown"].includes(call.status))
              ? "interrupted"
              : value.draft.status,
        });
      }
      return result;
    });
  }
  async closeDrafts(threadId: string, callId?: string, messageId?: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!callId && !messageId) await this.ctx.storage.put(`closed:${threadId}`, true);
      const rows = await this.ctx.storage.list<SavedDraft>({ prefix: `draft:${threadId}:` });
      for (const [key, saved] of rows) {
        const value = await this.readDraft(key, saved);
        if ((callId || messageId) && value.draft.callId !== callId && value.draft.id !== messageId)
          continue;
        await this.deleteDraft(key, saved);
        await this.publish({
          protocol: 2,
          type: "draft.end",
          reason: messageId ? "committed" : "discarded",
          draft: { ...value.draft, seq: value.draft.seq + 1 },
        });
      }
    });
  }
  async alarm() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const rows = await this.ctx.storage.list<SavedDraft>({ prefix: "draft:" });
      let remain = false;
      for (const [key, row] of rows) {
        if (row.expires <= Date.now()) await this.deleteDraft(key, row);
        else remain = true;
      }
      if (remain) await this.ctx.storage.setAlarm(Date.now() + 60_000);
    });
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const subscriber = ws.deserializeAttachment() as Subscriber;
    if (message === "draft.ack" && subscriber.protocol === 2 && subscriber.pendingDraft) {
      ws.serializeAttachment({ ...subscriber, pendingDraft: false, draftChanged: false });
      if (subscriber.draftChanged) ws.send("changed");
      return;
    }
    ws.close(1008, "Read only");
  }
  webSocketClose(ws: WebSocket) {
    ws.close();
  }
}
