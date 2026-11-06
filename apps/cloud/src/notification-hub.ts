/** 休眠 WebSocket 仅通知“数据已变化”；每次推送重新检查会话或设备，业务数据仍由鉴权 API 读取。 */
import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "./env";
type Subscriber = { owner?: string; session?: string; device?: string; expires: number };
export class NotificationHub extends DurableObject<AppEnv> {
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
  async publish() {
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
        ws.send("changed");
      } catch {
        ws.close();
      }
    }
  }
  webSocketMessage(ws: WebSocket) {
    ws.close(1008, "Read only");
  }
  webSocketClose(ws: WebSocket) {
    ws.close();
  }
}
