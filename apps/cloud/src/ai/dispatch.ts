import type { AppEnv } from "../env";
import { member } from "../tenancy";
import { now } from "../store";
import { notifyUser } from "../notifications";
import { executeTurn } from "./conversations";
import { executeHelpGraph } from "./help-graph";

export interface GraphEvent {
  id: string;
  graph_id: string;
  thread_id: string;
  owner: string;
  kind: "chat" | "help" | "resume" | "refresh";
  turn_id: string | null;
  run_id: string | null;
  help_id: string | null;
  message_id: string | null;
  interrupt_id: string | null;
  question_round: number | null;
}

export async function wakeGraph(env: AppEnv, id: string) {
  if (env.AI_TURNS)
    await env.AI_TURNS.getByName(id)
      .enqueue(id)
      .catch(() => {});
}

/** This seam is also used by local tests; production calls it only from an alarm. */
export async function dispatchGraphEvent(env: AppEnv, graphId: string) {
  const at = now(),
    until = new Date(Date.now() + 180_000).toISOString();
  const event = await env.DB.prepare(
    `UPDATE ai_dispatch SET state='running',lease_until=? WHERE id=(
    SELECT id FROM ai_dispatch WHERE graph_id=? AND (state='pending' OR (state='running' AND lease_until<?))
      AND NOT EXISTS(SELECT 1 FROM ai_dispatch busy WHERE busy.graph_id=? AND busy.state='running' AND busy.lease_until>=?)
    ORDER BY created_at,id LIMIT 1) RETURNING *`,
  )
    .bind(until, graphId, at, graphId, at)
    .first<GraphEvent>();
  if (!event) return false;
  const scoped = { ...env, requestUserId: event.owner };
  try {
    await member(scoped.DB, event.owner);
    if (event.kind === "chat") {
      const current = await env.DB.prepare("SELECT status FROM ai_turns WHERE id=?")
        .bind(event.turn_id)
        .first<{ status: string }>();
      // A crash after committing the reply but before acknowledging the event is harmless.
      if (current?.status === "running") {
        const result = await executeTurn(scoped, event.thread_id, event.turn_id!);
        if (result.status !== "done")
          throw Error("error" in result ? result.error : "AI_TURN_FAILED");
      } else if (current?.status !== "done") throw Error("TURN_STALE");
    } else await executeHelpGraph(scoped, event);
    await env.DB.prepare(
      "UPDATE ai_dispatch SET state='done',lease_until=NULL WHERE id=? AND state='running'",
    )
      .bind(event.id)
      .run();
  } catch (error) {
    const raw = (error as Error).message,
      code = /^[A-Z][A-Z0-9_]+$/.test(raw) ? raw : "AI_GRAPH_FAILED";
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE ai_dispatch SET state='failed',lease_until=NULL,error=? WHERE id=? AND state='running'",
      ).bind(code, event.id),
      env.DB.prepare(
        "UPDATE ai_graph_inputs SET status=?,error=? WHERE id=? AND owner=? AND active=1",
      ).bind(/UNKNOWN|TIMEOUT/.test(code) ? "unknown" : "failed", code, graphId, event.owner),
    ]);
  }
  await notifyUser(env, event.owner).catch(() => {});
  return true;
}

export async function nextGraphWake(env: AppEnv, id: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT state,lease_until FROM ai_dispatch WHERE graph_id=? AND state IN ('pending','running')
    ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END,created_at LIMIT 1`,
  )
    .bind(id)
    .first<{ state: string; lease_until: string | null }>();
  return row
    ? row.state === "pending"
      ? Date.now() + 1
      : Math.max(Date.now() + 1, Date.parse(row.lease_until!))
    : null;
}
