import { DurableObject } from "cloudflare:workers";
import { app, maintenance } from "./index";
import type { AppEnv } from "./env";
import { wakeTurns } from './ai/turn';
import {notifyDevices} from './notifications';

/** Bounded session shards coordinate admission. A routing hash is NEVER identity;
 * the application authenticates the original request on every invocation. */
export class RequestCoordinator extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS admission(day TEXT PRIMARY KEY,n INTEGER NOT NULL)");
  }
  async fetch(request: Request) {
    const day = new Date().toISOString().slice(0, 10);
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM admission WHERE day<>?", day);
    // Eight shards leave a single always-on executor enough room for its 60s fallback.
    // This is application admission, not a replacement for Cloudflare account quotas.
    const n = sql.exec<{n:number}>("SELECT n FROM admission WHERE day=?",day).toArray()[0]?.n ?? 0;
    const recovery = /^\/api\/runner\/runs\/[^/]+\/(heartbeat|finish|events|actions|stop)/.test(new URL(request.url).pathname);
    if(n >= (recovery ? 9600 : 8000))return Response.json({error:"PLATFORM_DAILY_LIMIT",resetAt:new Date(Date.parse(day)+86400000).toISOString()},{status:429});
    sql.exec("INSERT INTO admission(day,n) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET n=n+1",day);
    return app.fetch(request, this.env);
  }
}

/** The scheduling atom is the single global task queue, not all HTTP traffic. */
export class Scheduler extends DurableObject<AppEnv> {
  async wake() {
    if(await this.ctx.storage.getAlarm()===null)await this.ctx.storage.setAlarm(Date.now()+1);
  }
  async alarm() {
    await maintenance(this.env); await wakeTurns(this.env);
    const pending=await this.env.DB.prepare("SELECT id FROM runs WHERE status='queued' LIMIT 1").first();
    if(pending)await notifyDevices(this.env);
  }
}
