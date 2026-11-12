import { applicationDb } from "./database";
import { DurableObject } from "cloudflare:workers";
import { app, maintenance } from "./index";
import type { AppEnv } from "./env";
import { wakeTurns } from "./ai/turn";
import { notifyDevices } from "./notifications";
import { loadReleaseCatalog } from "./updates";
import { UpdateBroadcast } from "./update-broadcast";

/** Bounded session shards route application work. A routing hash is NEVER identity;
 * the application authenticates the original request on every invocation.
 * 独立 updates 对象拥有更新目录观察与持久广播游标，普通会话分片不承担发布广播。 */
export class RequestCoordinator extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, { ...env, DB: applicationDb(env.DB) });
  }
  async fetch(request: Request) {
    return app.fetch(request, this.env);
  }
  async releaseCatalog() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const catalog = await loadReleaseCatalog(this.env.DB);
      await new UpdateBroadcast(this.ctx.storage, this.env).observe(
        catalog.releases.find((release) => release.version === catalog.latest) ?? null,
      );
      return catalog;
    });
  }
  async alarm() {
    await new UpdateBroadcast(this.ctx.storage, this.env).alarm();
  }
}

/** 全局队列由同一个对象维护。alarm 加速积压处理，Cron 每分钟独立推进一轮。 */
export class Scheduler extends DurableObject<AppEnv> {
  private running = false;
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, { ...env, DB: applicationDb(env.DB) });
  }
  async wake() {
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + 1);
  }
  alarm() {
    return this.runMaintenance();
  }
  async runMaintenance() {
    // Cron 和 alarm 可以在等待 D1 时相遇；正在执行的一轮负责安排后续处理。
    if (this.running) return;
    this.running = true;
    try {
      await this.processQueue();
    } finally {
      this.running = false;
    }
  }
  private async processQueue() {
    if (
      (
        await this.env.DB.prepare("SELECT value FROM settings WHERE key='storageFrozen'").first<{
          value: string;
        }>()
      )?.value === "1"
    ) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    // 先设看门狗；失败或进程中断后仍可重试持久清理作业。
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    await maintenance(this.env);
    await wakeTurns(this.env);
    const pending = await this.env.DB.prepare(
      "SELECT id FROM runs WHERE status='queued' LIMIT 1",
    ).first();
    if (pending) await notifyDevices(this.env);
    const cleanup = await this.env.DB.prepare(
      "SELECT id FROM history_cleanup_jobs WHERE status='pending' LIMIT 1",
    ).first();
    if (cleanup) await this.ctx.storage.setAlarm(Date.now() + 2_000);
    else await this.ctx.storage.deleteAlarm();
  }
}
