/** 应用路由与维护入口：统一请求大小、来源、身份和错误响应；定时清理委托给队列与聊天生命周期模块。 */
import {drainHistoryCleanups} from './history-cleanup';
import {deleteEvidence} from './evidence';
import {notifyUser,notifyDevices} from './notifications';
import {retainHistory} from './ai/lifecycle';
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z,ZodError } from "zod";
import { auth } from "./auth";
import { pairing } from "./pairing";
import { user } from "./user";
import { admin } from "./admin";
import { authHandler } from "./identity";
import { PROTOCOL_VERSION, HISTORY_EPOCH } from "../../../packages/contracts/src/index";
import { quotaReset } from "./tenancy";
import { runner } from "./runner";
import { conversations } from './ai/conversations';
import { tick, now, type Row } from "./store";
import {advanceDispatchGroups} from './account-dispatch';
import {cleanupAccountCards} from './account-cards';
import type { AppEnv, Variables } from "./env";
const app = new Hono<{ Bindings: AppEnv; Variables: Variables }>();
app.use(
  "/api/*",
  bodyLimit({
    maxSize: 2_100_000,
    onError: (c) => c.json({ error: "BODY_TOO_LARGE" }, 413),
  }),
);
app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  if (
    !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
    !c.req.path.startsWith("/api/runner/") &&
    !c.req.path.startsWith("/api/device/")
  ) {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin)
      return c.json({ error: "ORIGIN_MISMATCH" }, 403);
  }
  await next();
});
app.use("/api/*", auth);
app.use('/api/*',async(c,next)=>{
 await next();
 if(c.req.method==='GET'||c.res.status>=400)return;
 if(c.get('userId'))await notifyUser(c.env,c.get('userId'));
 if(c.req.path.startsWith('/api/user/tasks')||c.req.path.startsWith('/api/admin/')||/^\/api\/user\/(runs\/[^/]+\/cancel|threads\/[^/]+\/messages)$/.test(c.req.path))await notifyDevices(c.env);
 if(c.get('deviceId')&&c.env.NOTIFICATIONS){
   const run=/^\/api\/runner\/runs\/([^/]+)/.exec(c.req.path);
   if(run&&/\/(finish|account-card|account-status|browser-closed)$/.test(c.req.path)){
     const owner=await c.env.DB.prepare('SELECT user_id FROM runs WHERE id=?').bind(run[1]).first<{user_id:string}>();
     if(owner)await notifyUser(c.env,owner.user_id);
   }
 }
});
app.use('/api/*',async(c,next)=>{
 if(c.req.method!=='GET' && !c.req.path.startsWith('/api/runner/') && !c.req.path.startsWith('/api/device/') && !c.req.path.startsWith('/api/admin/')) {
  if((await c.env.DB.prepare("SELECT value FROM settings WHERE key='maintenance'").first<{value:string}>())?.value==='1')return c.json({error:'MAINTENANCE'},503);
 }
 await next();
});
app.get("/api/health", (c) =>
  c.json({ service: "TaskRelay", protocolVersion: PROTOCOL_VERSION }),
);
app.route("/api/pair", pairing);
app.get('/api/user/events',async c=>{
 if(c.req.header('upgrade')?.toLowerCase()!=='websocket'||c.req.header('origin')!==new URL(c.req.url).origin)return c.json({error:'ORIGIN_MISMATCH'},403);
 return c.env.NOTIFICATIONS.getByName('user:'+c.get('userId')).fetch(new Request('https://notification.internal/',{headers:{Upgrade:'websocket','x-subscriber':JSON.stringify({owner:c.get('userId'),session:c.get('sessionId'),expires:Date.now()+3600000})}}));
});
app.get('/api/device/events',async c=>{
 if(c.req.header('upgrade')?.toLowerCase()!=='websocket')return c.json({error:'WEBSOCKET_REQUIRED'},400);
 return c.env.NOTIFICATIONS.getByName('device:'+c.get('deviceId')).fetch(new Request('https://notification.internal/',{headers:{Upgrade:'websocket','x-subscriber':JSON.stringify({device:c.get('deviceId'),expires:Date.now()+3600000})}}));
});
app.route("/api/user", user);
app.route('/api/user',conversations);
app.route("/api/admin", admin);
app.get('/api/auth/config',c=>c.json({registrationOpen:c.env.REGISTRATION_OPEN==='1',siteKey:c.env.TURNSTILE_SITE_KEY||''}));
app.all('/api/auth/*',c=>authHandler(c.req.raw,c.env));
app.post('/api/device/upgrade',async c=>{
 z.object({protocolVersion:z.literal(PROTOCOL_VERSION),localReady:z.literal(true)}).strict().parse(await c.req.json());
 const result=await c.env.DB.prepare(`UPDATE devices SET protocol_version=${PROTOCOL_VERSION},cutover_ready_at=? WHERE id=? AND revoked=0 AND (EXISTS(SELECT 1 FROM settings WHERE key='historyEpoch' AND value='${HISTORY_EPOCH}') OR (EXISTS(SELECT 1 FROM settings WHERE key='maintenance' AND value='1') AND EXISTS(SELECT 1 FROM settings WHERE key='claimsEnabled' AND value='0'))) AND NOT EXISTS(SELECT 1 FROM runs WHERE device_id=? AND status IN ('running','waiting_user','verifying'))`).bind(now(),c.get('deviceId'),c.get('deviceId')).run();
 if(!result.meta.changes)throw new Error('CUTOVER_NOT_READY');
 const epoch=await c.env.DB.prepare("SELECT value FROM settings WHERE key='historyEpoch'").first<{value:string}>();
 return c.json({protocolVersion:PROTOCOL_VERSION,historyEpoch:Number(epoch?.value??0)});
});
app.get('/api/device/status',async c=>{
 const rows=await c.env.DB.prepare("SELECT key,value FROM settings WHERE key IN ('maintenance','historyEpoch')").all<{key:string;value:string}>();
 const s=Object.fromEntries(rows.results.map(r=>[r.key,r.value]));
 return c.json({deviceId:c.get('deviceId'),protocolVersion:PROTOCOL_VERSION,maintenance:s.maintenance==='1',historyEpoch:Number(s.historyEpoch??0)});
});
app.post('/api/device/readiness',async c=>{
 const b=z.object({ready:z.boolean()}).parse(await c.req.json());
 await c.env.DB.prepare('UPDATE devices SET claim_ready=?,last_seen=? WHERE id=? AND revoked=0').bind(b.ready?1:0,now(),c.get('deviceId')).run();
 return c.json({ok:true});
});
app.route("/api/runner", runner);
app.notFound((c) => c.json({ error: "NOT_FOUND" }, 404));
app.onError((error, c) => {
  const code =
    error instanceof ZodError
      ? "INVALID_INPUT"
      : /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : /(?:MEMORY_LIMIT|QUEUE_LIMIT|CLAIM_BUSY|RUN_QUOTA_EXCEEDED|SCHEDULE_QUOTA_EXCEEDED|USER_DISABLED|ACCOUNT_DEVICE_MISMATCH)/.exec(error.message)?.[0] ?? "INTERNAL_ERROR";
  return c.json(
    { error: code, ...(code.includes("QUOTA")||code==="QUEUE_LIMIT"?{resetAt:quotaReset()}: {}) },
    code.includes("QUOTA")||code==="QUEUE_LIMIT"||code==="RATE_LIMITED" ? 429 : code==="USER_DISABLED" ? 403 : code === "INTERNAL_ERROR"
      ? 500
      : code.includes("NOT_FOUND")
        ? 404
        : code.includes("EXPIRED") ||
            code.includes("STALE") ||
            code.includes("CONFLICT")
          ? 409
          : 400,
  );
});
export default {
  fetch: app.fetch,
  async scheduled(
    _event: ScheduledController,
    env: AppEnv,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(
      (async () => {
        await maintenance(env);
      })(),
    );
  },
};
export { app };

export async function maintenance(env: AppEnv) {
        await drainHistoryCleanups(env);
        await tick(env.DB);
        await cleanupAccountCards(env);
        await advanceDispatchGroups(env.DB);
        const expired = await env.DB.prepare(
          "SELECT * FROM artifacts WHERE expires_at<=? LIMIT 100",
        )
          .bind(now())
          .all<Row>();
        for (const row of expired.results) {
          await deleteEvidence(env,row.object_key);
          await env.DB.prepare("DELETE FROM artifacts WHERE id=?")
            .bind(row.id)
            .run();
        }
        const days = Number(
          (
            await env.DB.prepare(
              "SELECT value FROM settings WHERE key='retentionDays'",
            ).first<{ value: string }>()
          )?.value ?? 30,
        );
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();
        await retainHistory(env,cutoff);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM batch_progress WHERE updated_at<? AND run_id IN (SELECT id FROM runs WHERE status IN ('succeeded','failed','cancelled','expired'))").bind(cutoff),
          env.DB.prepare(
            "DELETE FROM run_events WHERE at<? AND run_id IN (SELECT id FROM runs WHERE status IN ('succeeded','failed','cancelled','expired'))",
          ).bind(cutoff),
          env.DB.prepare("DELETE FROM conversations WHERE at<?").bind(cutoff),
        ]);
}
