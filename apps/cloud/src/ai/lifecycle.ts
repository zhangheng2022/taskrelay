import { dbTime } from "../database";
import { deleteEvidence } from "../evidence";
import type { AppEnv } from "../env";

// 显式清理覆盖直接关联运行的调用，也覆盖经图关联运行或聊天的调用。
// 正文和调用标记归同一作业处理，避免保留期每轮把 THREAD_DELETED 改回 HISTORY_EXPIRED。
const expiredCall = `(created_at<? OR EXISTS(
  SELECT 1 FROM ai_graph_inputs g WHERE g.owner=ai_calls.user_id AND g.id=ai_calls.graph_id AND g.active=0
)) AND NOT EXISTS(
  SELECT 1 FROM history_cleanup_targets t WHERE t.kind='run' AND t.resource_id=ai_calls.run_id
) AND NOT EXISTS(
  SELECT 1 FROM ai_graph_inputs g JOIN history_cleanup_targets t
    ON (t.kind='thread' AND t.resource_id=g.parent_thread) OR (t.kind='run' AND t.resource_id=g.run_id)
  WHERE g.owner=ai_calls.user_id AND g.id=ai_calls.graph_id
)`;

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
      `DELETE FROM call_results WHERE id IN(SELECT id FROM ai_calls WHERE ${expiredCall})`,
    ).bind(dbTime(cutoff)),
    env.DB.prepare(
      `UPDATE ai_calls SET status='unknown',error='HISTORY_EXPIRED'
       WHERE (status<>'unknown' OR error IS NULL OR error<>'HISTORY_EXPIRED') AND ${expiredCall}`,
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
  // 以事务后已关闭的事实为准；预读过期候选会误关闭同时收到新消息的聊天。
  const expired = await env.DB.prepare(
    "SELECT id,user_id FROM ai_threads WHERE deleted=1 AND closed=1 AND id NOT IN(SELECT resource_id FROM history_cleanup_targets WHERE kind='thread')",
  ).all<{ id: string; user_id: string }>();
  for (const thread of expired.results)
    await env.NOTIFICATIONS?.getByName("user:" + thread.user_id).closeDrafts(thread.id);
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
