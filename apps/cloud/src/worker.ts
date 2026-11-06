import { PROTOCOL_VERSION } from "../../../packages/contracts/src/index";
import type { AppEnv } from "./env";
import { serveUpdate } from "./updates";
export default {
  async fetch(request: Request, env: AppEnv) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/updates/")) return serveUpdate(request);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (url.pathname === "/api/health")
      return Response.json({ service: "TaskRelay", protocolVersion: PROTOCOL_VERSION });
    const credential =
      request.headers.get("authorization") ||
      request.headers.get("cookie") ||
      request.headers.get("cf-connecting-ip") ||
      "anonymous";
    if (credential.length > 16384) return new Response(null, { status: 431 });
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential)),
    );
    return env.REQUESTS.getByName(`session-${digest[0] % 8}`).fetch(request);
  },
  scheduled(_event: ScheduledController, env: AppEnv, ctx: ExecutionContext) {
    ctx.waitUntil(env.SCHEDULER.getByName("queue").wake());
  },
};
export { ModelEgress } from "./model-egress";
export { RequestCoordinator, Scheduler } from "./request-coordinator";
export { AiTurn } from "./ai/turn";
export { Evidence } from "./evidence-store";
export { BrowserStateStore } from "./browser-state-store";
export { NotificationHub } from "./notification-hub";
