import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "../env";
import { promoteInbox } from "./conversations";
import { drainCommands } from "./commands";
import { dispatchGraphEvent, nextGraphWake, wakeGraph } from "./dispatch";

/** One object serializes one graph; D1 owns events and LangGraph owns resumable state. */
export class AiTurn extends DurableObject<AppEnv> {
  async enqueue(id: string) {
    const prior = await this.ctx.storage.get<string>("id");
    if (prior && prior !== id) throw Error("GRAPH_CONFLICT");
    await this.ctx.storage.put("id", id);
    await this.ctx.storage.setAlarm(Date.now() + 1);
  }
  async alarm() {
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
    if (turn)
      await promoteInbox(
        { ...this.env, requestUserId: turn.owner },
        turn.thread_id,
      );
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
  for (const t of waiting.results)
    await promoteInbox({ ...env, requestUserId: t.user_id }, t.id);
  const events = await env.DB.prepare(
    "SELECT DISTINCT graph_id FROM ai_dispatch WHERE state='pending' OR (state='running' AND lease_until<?) LIMIT 20",
  )
    .bind(new Date().toISOString())
    .all<{ graph_id: string }>();
  for (const event of events.results) await wakeGraph(env, event.graph_id);
}
