import { dbTime } from "../database";
import { deleteEvidence } from "../evidence";
import type { AppEnv } from "../env";

export async function retainHistory(env: AppEnv, cutoff: string) {
  // 显式删除的目标归分批清理作业所有，保留期任务不越过它的批次边界。
  // Expiring a conversation invalidates every derived copy before removing its text.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE ai_turns SET status='unknown',error='TURN_OUTCOME_UNKNOWN' WHERE status='running' AND created_at<? AND NOT EXISTS(SELECT 1 FROM ai_dispatch WHERE graph_id=ai_turns.id AND state IN ('pending','running'))",
    ).bind(dbTime(new Date(Date.now() - 180000).toISOString())),
    env.DB.prepare(
      "UPDATE ai_threads SET active_turn=NULL WHERE active_turn IN(SELECT id FROM ai_turns WHERE status='unknown')",
    ),
    env.DB.prepare(
      "UPDATE ai_calls SET status='unknown',error='MODEL_CALL_OUTCOME_UNKNOWN' WHERE status IN ('running','reserved') AND created_at<?",
    ).bind(dbTime(new Date(Date.now() - 180000).toISOString())),
    env.DB.prepare(
      "UPDATE ai_threads SET closed=1,deleted=1,version=version+1,active_turn=NULL,draft=NULL,partial='{}',summary='',summary_seq=0 WHERE updated_at<? AND deleted=0",
    ).bind(dbTime(cutoff)),
    env.DB.prepare(
      "UPDATE ai_graph_inputs SET active=0,generation=generation+1,status='cancelled' WHERE active=1 AND (created_at<? OR parent_thread IN(SELECT id FROM ai_threads WHERE deleted=1 AND id NOT IN(SELECT resource_id FROM history_cleanup_targets WHERE kind='thread')))",
    ).bind(dbTime(cutoff)),
    env.DB.prepare(
      "DELETE FROM ai_writes WHERE EXISTS(SELECT 1 FROM ai_graph_inputs g WHERE g.owner=ai_writes.owner AND g.id=ai_writes.thread AND g.active=0 AND NOT EXISTS(SELECT 1 FROM history_cleanup_targets x WHERE (x.kind='thread' AND x.resource_id=g.parent_thread) OR (x.kind='run' AND x.resource_id=g.run_id)))",
    ),
    env.DB.prepare(
      "DELETE FROM ai_checkpoints WHERE EXISTS(SELECT 1 FROM ai_graph_inputs g WHERE g.owner=ai_checkpoints.owner AND g.id=ai_checkpoints.thread AND g.active=0 AND NOT EXISTS(SELECT 1 FROM history_cleanup_targets x WHERE (x.kind='thread' AND x.resource_id=g.parent_thread) OR (x.kind='run' AND x.resource_id=g.run_id)))",
    ),
    env.DB.prepare(
      "DELETE FROM call_results WHERE id IN(SELECT id FROM ai_calls WHERE created_at<? OR graph_id IN(SELECT id FROM ai_graph_inputs WHERE active=0))",
    ).bind(dbTime(cutoff)),
    env.DB.prepare(
      "UPDATE ai_calls SET status='unknown',error='HISTORY_EXPIRED' WHERE (created_at<? OR graph_id IN(SELECT id FROM ai_graph_inputs WHERE active=0)) AND (status<>'unknown' OR error IS NULL OR error<>'HISTORY_EXPIRED')",
    ).bind(dbTime(cutoff)),
    env.DB.prepare(
      "UPDATE ai_turns SET result=NULL,status='cancelled',error='HISTORY_EXPIRED' WHERE thread_id IN(SELECT id FROM ai_threads WHERE deleted=1 AND id NOT IN(SELECT resource_id FROM history_cleanup_targets WHERE kind='thread')) AND (result IS NOT NULL OR status<>'cancelled' OR error IS NULL OR error<>'HISTORY_EXPIRED')",
    ),
    env.DB.prepare(
      "DELETE FROM ai_messages WHERE thread_id IN(SELECT id FROM ai_threads WHERE deleted=1 AND id NOT IN(SELECT resource_id FROM history_cleanup_targets WHERE kind='thread'))",
    ),
    env.DB.prepare(
      "UPDATE conversation_inbox SET content='',status='failed' WHERE thread_id IN(SELECT id FROM ai_threads WHERE deleted=1 AND id NOT IN(SELECT resource_id FROM history_cleanup_targets WHERE kind='thread'))",
    ),
    env.DB.prepare(
      "UPDATE conversation_commands SET run_task=NULL,state='done' WHERE thread_id IN(SELECT id FROM ai_threads WHERE deleted=1 AND id NOT IN(SELECT resource_id FROM history_cleanup_targets WHERE kind='thread'))",
    ),
    env.DB.prepare(
      "UPDATE ai_dispatch SET state='retired',message_id=NULL,error='HISTORY_EXPIRED' WHERE thread_id IN(SELECT id FROM ai_threads WHERE deleted=1 AND id NOT IN(SELECT resource_id FROM history_cleanup_targets WHERE kind='thread'))",
    ),
  ]);
  await env.DB.prepare(
    "DELETE FROM preference_snapshots WHERE thread_id IN(SELECT id FROM ai_threads WHERE deleted=1)",
  ).run();
  const images = await env.DB.prepare(
    "SELECT a.id,a.object_key FROM artifacts a JOIN ai_threads t ON t.id=a.thread_id WHERE t.deleted=1 AND t.id NOT IN(SELECT resource_id FROM history_cleanup_targets WHERE kind='thread') LIMIT 100",
  ).all<{ id: string; object_key: string }>();
  for (const image of images.results) {
    await deleteEvidence(env, image.object_key);
    await env.DB.prepare("DELETE FROM artifacts WHERE id=?").bind(image.id).run();
  }
  await env.DB.prepare(
    "DELETE FROM execution_help WHERE thread_id IN (SELECT id FROM ai_threads WHERE deleted=1 AND id NOT IN(SELECT resource_id FROM history_cleanup_targets WHERE kind='thread'))",
  ).run();
  // Digest tombstones deliberately remain: expiry must not make a request replayable.
}
