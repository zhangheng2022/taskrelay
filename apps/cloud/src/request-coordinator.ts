import { DurableObject } from "cloudflare:workers";
import { app, maintenance } from "./index";
import type { AppEnv } from "./env";
import { wakeTurns } from './ai/turn';
import {notifyDevices} from './notifications';

/** Bounded session shards route application work. A routing hash is NEVER identity;
 * the application authenticates the original request on every invocation. */
export class RequestCoordinator extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    ctx.storage.sql.exec('DROP TABLE IF EXISTS admission');
  }
  async fetch(request: Request) {
    return app.fetch(request, this.env);
  }
}

/** The scheduling atom is the single global task queue, not all HTTP traffic. */
export class Scheduler extends DurableObject<AppEnv> {
  async wake() {
    if(await this.ctx.storage.getAlarm()===null)await this.ctx.storage.setAlarm(Date.now()+1);
  }
  async alarm() {
    // 先设看门狗；失败或进程中断后仍可重试持久清理作业。
    await this.ctx.storage.setAlarm(Date.now()+60_000);
    await maintenance(this.env); await wakeTurns(this.env);
    const pending=await this.env.DB.prepare("SELECT id FROM runs WHERE status='queued' LIMIT 1").first();
    if(pending)await notifyDevices(this.env);
    const cleanup=await this.env.DB.prepare("SELECT id FROM history_cleanup_jobs WHERE status='pending' LIMIT 1").first();
    if(cleanup)await this.ctx.storage.setAlarm(Date.now()+2_000);
    else await this.ctx.storage.deleteAlarm();
  }
}
