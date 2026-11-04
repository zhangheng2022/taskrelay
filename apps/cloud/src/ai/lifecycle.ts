import {deleteEvidence} from '../evidence';
import type { AppEnv } from "../env";
import { hash } from "../../../../packages/contracts/src/security";
import { now } from "../store";

const preserved = [
  "auth_user",
  "auth_account",
  "auth_session",
  "members",
  "accounts",
  "model_profiles",
  "devices",
  "quota_reservations",
] as const;
const history = [
  "ai_messages",
  "ai_turns",
  "ai_threads",
  "ai_writes",
  "ai_checkpoints",
  "ai_calls",
  "ai_graph_inputs",
  "ai_memories",
  "ai_plan_steps",
  "conversations",
  "challenges",
  "artifacts",
  "actions",
  "claims",
  "account_locks",
  "run_events",
  "model_usage",
  "task_versions",
  "idempotency",
  "runs",
  "tasks",
] as const;
const blockers = `(SELECT COUNT(*) FROM runs WHERE status IN ('running','waiting_user','verifying','unknown') OR (write_pending=1 AND status<>'succeeded'))
 +(SELECT COUNT(*) FROM account_locks)
 +(SELECT COUNT(*) FROM devices WHERE revoked=0 AND (protocol_version<>3 OR cutover_ready_at IS NULL OR julianday(cutover_ready_at)<julianday('now','-10 minutes')))
 +(SELECT COUNT(*) FROM ai_calls WHERE status IN ('reserved','running'))
 +(SELECT COUNT(*) FROM ai_turns WHERE status='running')`;

export async function cutoverPreview(env: AppEnv) {
  const rows = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`SELECT ${blockers} blockers`),
    ...preserved.map((t) =>
      env.DB.prepare(`SELECT '${t}' name,COUNT(*) count FROM ${t}`),
    ),
    ...history.map((t) =>
      env.DB.prepare(`SELECT '${t}' name,COUNT(*) count FROM ${t}`),
    ),
  ]);
  const counts = rows.slice(1).map((r) => r.results[0]);
  return {
    blockers: Number(rows[0].results[0].blockers),
    counts,
    digest: await hash(JSON.stringify(counts)),
  };
}

/** Only called under authenticated admin routes after explicit maintenance preparation. */
export async function cutover(env: AppEnv, digest: string) {
  const state = await env.DB.prepare(
    "SELECT key,value FROM settings WHERE key IN ('maintenance','claimsEnabled','historyEpoch')",
  ).all<{ key: string; value: string }>();
  const settings = Object.fromEntries(
    state.results.map((r) => [r.key, r.value]),
  );
  if (settings.maintenance !== "1" || settings.claimsEnabled !== "0")
    throw new Error("MAINTENANCE_REQUIRED");
  if (settings.historyEpoch === "3")
    throw new Error("CUTOVER_ALREADY_COMPLETED");
  const preview = await cutoverPreview(env);
  if (preview.blockers) throw new Error("CUTOVER_BLOCKED");
  if (preview.digest !== digest) throw new Error("CUTOVER_PREVIEW_STALE");
  // Delete only recorded TaskRelay evidence objects, never an entire bucket.
  const evidence = await env.DB.prepare(
    "SELECT object_key FROM artifacts",
  ).all<{ object_key: string }>();
  for (const row of evidence.results) await deleteEvidence(env,row.object_key);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ai_cutovers(id,at,counts,guard) SELECT 'protocol-3',?,?,CASE WHEN (${blockers})=0 AND EXISTS(SELECT 1 FROM settings WHERE key='maintenance' AND value='1') AND EXISTS(SELECT 1 FROM settings WHERE key='claimsEnabled' AND value='0') THEN 1 ELSE 0 END`,
    ).bind(now(), JSON.stringify(preview.counts)),
    env.DB.prepare(
      "INSERT INTO quota_carry(user_id,day,runs) SELECT user_id,started_day,COUNT(*) FROM runs WHERE started_day IS NOT NULL GROUP BY user_id,started_day ON CONFLICT(user_id,day) DO UPDATE SET runs=quota_carry.runs+excluded.runs",
    ),
    ...history.map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    env.DB.prepare(
      "INSERT INTO settings(key,value) VALUES('historyEpoch','3') ON CONFLICT(key) DO UPDATE SET value='3'",
    ),
  ]);
  // Keep maintenance and claims disabled until post-cutover checks pass.
  return {
    ok: true,
    historyEpoch: 3,
    preserved: preview.counts.slice(0, preserved.length),
  };
}

export async function retainHistory(env: AppEnv, cutoff: string) {
  // Expiring a conversation invalidates every derived copy before removing its text.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE ai_turns SET status='unknown',error='TURN_OUTCOME_UNKNOWN' WHERE status='running' AND created_at<?",
    ).bind(new Date(Date.now() - 180000).toISOString()),
    env.DB.prepare(
      "UPDATE ai_threads SET active_turn=NULL WHERE active_turn IN(SELECT id FROM ai_turns WHERE status='unknown')",
    ),
    env.DB.prepare(
      "UPDATE ai_calls SET status='unknown',error='MODEL_CALL_OUTCOME_UNKNOWN' WHERE status IN ('running','reserved') AND created_at<?",
    ).bind(new Date(Date.now() - 180000).toISOString()),
    env.DB.prepare(
      "UPDATE ai_threads SET closed=1,deleted=1,version=version+1,active_turn=NULL,draft=NULL,partial='{}',summary='',summary_seq=0 WHERE updated_at<? AND deleted=0",
    ).bind(cutoff),
    env.DB.prepare(
      "UPDATE ai_graph_inputs SET active=0 WHERE active=1 AND (created_at<? OR parent_thread IN(SELECT id FROM ai_threads WHERE deleted=1))",
    ).bind(cutoff),
    env.DB.prepare(
      "DELETE FROM ai_writes WHERE EXISTS(SELECT 1 FROM ai_graph_inputs g WHERE g.owner=ai_writes.owner AND g.id=ai_writes.thread AND g.active=0)",
    ),
    env.DB.prepare(
      "DELETE FROM ai_checkpoints WHERE EXISTS(SELECT 1 FROM ai_graph_inputs g WHERE g.owner=ai_checkpoints.owner AND g.id=ai_checkpoints.thread AND g.active=0)",
    ),
    env.DB.prepare(
      "UPDATE ai_calls SET result=NULL,status='unknown',error='HISTORY_EXPIRED' WHERE (created_at<? OR graph_id IN(SELECT id FROM ai_graph_inputs WHERE active=0)) AND (result IS NOT NULL OR status<>'unknown' OR error IS NULL OR error<>'HISTORY_EXPIRED')",
    ).bind(cutoff),
    env.DB.prepare(
      "UPDATE ai_turns SET result=NULL,status='cancelled',error='HISTORY_EXPIRED' WHERE thread_id IN(SELECT id FROM ai_threads WHERE deleted=1) AND (result IS NOT NULL OR status<>'cancelled' OR error IS NULL OR error<>'HISTORY_EXPIRED')",
    ),
    env.DB.prepare(
      "DELETE FROM ai_messages WHERE thread_id IN(SELECT id FROM ai_threads WHERE deleted=1)",
    ),
  ]);
  // Digest tombstones deliberately remain: expiry must not make a request replayable.
}
