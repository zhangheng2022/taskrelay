import { dbTime } from "../database";
import { applicationDb } from "../database";
/**
 * 每张云端图对应一个 Durable Object，由 alarm 消费 D1 中的持久化事件。
 * 定时唤醒负责补投遗留工作；图状态、请求去重和未知结果处理仍由各自存储模块负责。
 */
import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "../env";
import { promoteInbox } from "./conversations";
import { drainCommands } from "./commands";
import { dispatchGraphEvent, nextGraphWake, wakeGraph } from "./dispatch";

/** 单个对象串行消费一个图；KV 仅有 id 键绑定 D1 graph_id，不保存用户正文或检查点。
 * 无分块/密文；alarm 可重复唤醒，先检查冻结屏障，D1 拥有事件，LangGraph 拥有图状态。 */
export class AiTurn extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, { ...env, DB: applicationDb(env.DB) });
  }
  async enqueue(id: string) {
    const prior = await this.ctx.storage.get<string>("id");
    if (prior && prior !== id) throw Error("GRAPH_CONFLICT");
    await this.ctx.storage.put("id", id);
    await this.ctx.storage.setAlarm(Date.now() + 1);
  }
  async alarm() {
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
    const id = await this.ctx.storage.get<string>("id");
    if (!id) return;
    // A watchdog survives process loss; the next alarm resumes only checkpointed work.
    // ai_calls and command outboxes still prohibit repeating uncertain side effects.
    await this.ctx.storage.setAlarm(Date.now() + 180_000);
    await dispatchGraphEvent(this.env, id);
    const turn = await this.env.DB.prepare(
      "SELECT thread_id,owner FROM ai_dispatch WHERE graph_id=? AND kind='chat' AND state IN ('done','failed') LIMIT 1",
    )
      .bind(id)
      .first<{ thread_id: string; owner: string }>();
    if (turn) await promoteInbox({ ...this.env, requestUserId: turn.owner }, turn.thread_id);
    const next = await nextGraphWake(this.env, id);
    if (next !== null) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }
}

export async function wakeTurns(env: AppEnv) {
  await drainCommands(env);
  await env.DB.prepare(
    "UPDATE conversation_inbox SET status='failed' WHERE status='processing' AND id IN(SELECT id FROM ai_turns WHERE status<>'running')",
  ).run();
  const waiting = await env.DB.prepare(
    "SELECT DISTINCT t.id,t.user_id FROM ai_threads t JOIN conversation_inbox i ON i.thread_id=t.id WHERE t.active_turn IS NULL AND t.closed=0 AND i.status='pending' LIMIT 10",
  ).all<{ id: string; user_id: string }>();
  for (const t of waiting.results) await promoteInbox({ ...env, requestUserId: t.user_id }, t.id);
  const events = await env.DB.prepare(
    "SELECT DISTINCT graph_id FROM ai_dispatch WHERE state='pending' OR (state='running' AND lease_until<?) LIMIT 20",
  )
    .bind(dbTime(new Date().toISOString()))
    .all<{ graph_id: string }>();
  for (const event of events.results) await wakeGraph(env, event.graph_id);
}
