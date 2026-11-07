import { dbTime } from "./database";
/** 聊天删除的持久作业。接收事务固定目标、关闭聊天并撤回执行授权；
 * Scheduler 每轮只回收有限条正文/图片。摘要与幂等墓碑分离，迟到执行仅可收尾，不能恢复正文。
 * 清空保留一个暂停的任务入口；删除隐藏任务。账号、模型、设备与未知操作的租约记录不受影响。
 */
import type { AppEnv } from "./env";
import { now, uid } from "./store";
import { deleteEvidence } from "./evidence";
import { notifyDevices, notifyUser } from "./notifications";

export type CleanupScope = "all" | "task" | "clear" | "thread";
export interface CleanupJob {
  id: string;
  scope: CleanupScope;
  target_id: string | null;
  status: string;
  error: string | null;
  total: number;
  completed: number;
}

export async function cleanupJobs(env: AppEnv, userId: string, id?: string) {
  const rows = await env.DB.prepare(
    `SELECT j.id,j.scope,j.target_id,j.status,j.error,COUNT(t.resource_id) total,COALESCE(SUM(t.done),0) completed
  FROM history_cleanup_jobs j LEFT JOIN history_cleanup_targets t ON t.job_id=j.id
  WHERE j.user_id=? ${id ? "AND j.id=?" : "AND j.status<>'done'"} GROUP BY j.id ORDER BY j.created_at LIMIT 50`,
  )
    .bind(userId, ...(id ? [id] : []))
    .all<CleanupJob>();
  return rows.results;
}

export async function beginCleanup(
  env: AppEnv,
  userId: string,
  scope: CleanupScope,
  targetId: string | null,
  requestId: string,
) {
  const previous = await env.DB.prepare(
    "SELECT id,scope,target_id FROM history_cleanup_jobs WHERE user_id=? AND request_id=?",
  )
    .bind(userId, requestId)
    .first<{ id: string; scope: string; target_id: string | null }>();
  if (previous) {
    if (previous.scope !== scope || previous.target_id !== targetId)
      throw Error("REQUEST_CONFLICT");
    return (await cleanupJobs(env, userId, previous.id))[0];
  }
  let taskId = targetId;
  if (scope === "thread") {
    const thread = await env.DB.prepare(
      "SELECT task_id,closed FROM ai_threads WHERE id=? AND user_id=?",
    )
      .bind(targetId, userId)
      .first<{ task_id: string | null; closed: number }>();
    if (!thread) throw Error("THREAD_NOT_FOUND");
    taskId = thread.closed ? null : thread.task_id;
  } else if (
    scope !== "all" &&
    !(await env.DB.prepare("SELECT id FROM tasks WHERE id=? AND user_id=? AND deleted=0")
      .bind(targetId, userId)
      .first())
  )
    throw Error("TASK_NOT_FOUND");
  const id = uid("cleanup"),
    at = now(),
    deleting = scope === "all" || scope === "task";
  const threads = `SELECT resource_id FROM history_cleanup_targets WHERE job_id=? AND kind='thread'`;
  const runs = `SELECT resource_id FROM history_cleanup_targets WHERE job_id=? AND kind='run'`;
  const taskWhere =
    scope === "all" ? "user_id=? AND deleted=0" : "user_id=? AND id=? AND deleted=0";
  const taskArgs = scope === "all" ? [userId] : [userId, taskId];
  const fresh = "EXISTS(SELECT 1 FROM history_cleanup_jobs WHERE id=? AND status='capturing')";
  // 使用唯一请求 ID 仲裁并发重试；只有本次新插入的作业可以捕获目标。
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO history_cleanup_jobs(id,user_id,request_id,scope,target_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).bind(id, userId, requestId, scope, targetId, dbTime(at), dbTime(at)),
    env.DB.prepare(
      `INSERT INTO history_cleanup_targets(job_id,kind,resource_id,cutoff_version)
   SELECT ?,'task',id,version FROM tasks WHERE ${taskWhere} AND ${scope === "thread" ? "EXISTS(SELECT 1 FROM ai_threads WHERE id=? AND closed=0)" : "1=1"} AND ${fresh}`,
    ).bind(id, ...taskArgs, ...(scope === "thread" ? [targetId] : []), id),
    env.DB.prepare(
      `INSERT INTO history_cleanup_targets(job_id,kind,resource_id)
   SELECT ?,'thread',id FROM ai_threads WHERE user_id=? AND ${scope === "all" ? "1=1" : scope === "thread" ? "id=?" : "task_id=?"} AND ${fresh}`,
    ).bind(id, userId, ...(scope === "all" ? [] : [targetId]), id),
    env.DB.prepare(
      `INSERT INTO history_cleanup_targets(job_id,kind,resource_id)
   SELECT ?,'run',id FROM runs WHERE user_id=? AND history_deleted=0 AND ${scope === "all" ? "1=1" : scope === "thread" ? "(thread_id=? OR (thread_id IS NULL AND task_id IN(SELECT resource_id FROM history_cleanup_targets WHERE job_id=? AND kind='task')))" : "task_id=?"} AND ${fresh}`,
    ).bind(
      id,
      userId,
      ...(scope === "all" ? [] : [targetId]),
      ...(scope === "thread" ? [id] : []),
      id,
    ),
    env.DB.prepare(
      `UPDATE ai_threads SET closed=1,deleted=1,version=version+1,active_turn=NULL,draft=NULL,partial='{}',summary='',summary_seq=0 WHERE id IN(${threads})`,
    ).bind(id),
    env.DB.prepare(
      `UPDATE runs SET history_deleted=1,context_withdrawn=1,cancel_requested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=? WHERE id IN(${runs})`,
    ).bind(dbTime(at), id),
    env.DB.prepare(`DELETE FROM run_results WHERE run_id IN(${runs})`).bind(id),
    env.DB.prepare(`DELETE FROM run_snapshots WHERE run_id IN(${runs})`).bind(id),
    // 新版本是清空后的空入口；旧版本正文由固定目标分批回收，安全身份继续保留。
    env.DB.prepare(
      `INSERT INTO task_versions(task_id,version,definition,user_id,model_id,model_version)
      SELECT t.id,t.version+1,json_object('id',t.id,'version',t.version+1,'title',CASE WHEN ?=1 THEN '已删除任务' ELSE t.title END,
        'goal','请重新交办任务','entryUrl','https://example.com','accountId',NULL,
        'modelId',v.model_id,'modelVersion',v.model_version,'allowedActions',json('["read"]'),
        'verification',json('{"kind":"goal","value":"请重新交办任务"}'),
        'schedule',json('{"kind":"manual"}'),'createdAt',json_extract(v.definition,'$.createdAt')),
        t.user_id,v.model_id,v.model_version FROM tasks t JOIN task_versions v ON v.task_id=t.id AND v.version=t.version
      WHERE t.id IN(SELECT resource_id FROM history_cleanup_targets WHERE job_id=? AND kind='task')`,
    ).bind(Number(deleting), id),
    env.DB.prepare(
      `UPDATE tasks SET deleted=?,version=version+1,context_withdrawn=1,status='paused',
      title=CASE WHEN ?=1 THEN '已删除任务' ELSE title END,schedule_kind='manual',next_run_at=NULL,confirmed_condition=NULL,updated_at=?
      WHERE id IN(SELECT resource_id FROM history_cleanup_targets WHERE job_id=? AND kind='task')`,
    ).bind(Number(deleting), Number(deleting), dbTime(at), id),
    env.DB.prepare(
      `UPDATE ai_graph_inputs SET active=0,generation=generation+1,status='cancelled',error='THREAD_DELETED' WHERE parent_thread IN(${threads}) OR run_id IN(${runs})`,
    ).bind(id, id),
    env.DB.prepare(
      `UPDATE ai_dispatch SET state='retired',lease_until=NULL,message_id=NULL,error='THREAD_DELETED' WHERE thread_id IN(${threads})`,
    ).bind(id),
    env.DB.prepare(
      `UPDATE ai_turns SET status='cancelled',result=NULL,error='THREAD_DELETED' WHERE thread_id IN(${threads})`,
    ).bind(id),
    env.DB.prepare(
      `UPDATE conversation_commands SET run_task=NULL,state='done' WHERE thread_id IN(${threads})`,
    ).bind(id),
    env.DB.prepare(
      `UPDATE execution_help SET awaiting_user=0,response=NULL WHERE thread_id IN(${threads}) OR run_id IN(${runs})`,
    ).bind(id, id),
    env.DB.prepare("UPDATE history_cleanup_jobs SET status='pending' WHERE id=?").bind(id),
  ]);
  const saved = await env.DB.prepare(
    "SELECT id,scope,target_id FROM history_cleanup_jobs WHERE user_id=? AND request_id=?",
  )
    .bind(userId, requestId)
    .first<{ id: string; scope: string; target_id: string | null }>();
  if (!saved || saved.scope !== scope || saved.target_id !== targetId)
    throw Error("REQUEST_CONFLICT");
  await notifyDevices(env);
  await notifyUser(env, userId);
  // Cron 是唤醒失败时的持久兜底，不能把已接收的删除误报为未提交。
  await env.SCHEDULER?.getByName("queue")
    .wake()
    .catch(() => {});
  return (await cleanupJobs(env, userId, saved.id))[0];
}

/** 每轮最多 4 个目标，每张表 100 行、每个目标 10 张图片。失败保留索引供下一轮重试。 */
export async function drainHistoryCleanups(env: AppEnv) {
  const jobs = await env.DB.prepare(
    "SELECT id,user_id FROM history_cleanup_jobs WHERE status='pending' ORDER BY updated_at LIMIT 4",
  ).all<{ id: string; user_id: string }>();
  for (const job of jobs.results) {
    try {
      const target = await env.DB.prepare(
        "SELECT kind,resource_id,cutoff_version FROM history_cleanup_targets WHERE job_id=? AND done=0 ORDER BY kind,resource_id LIMIT 1",
      )
        .bind(job.id)
        .first<{ kind: string; resource_id: string; cutoff_version: number | null }>();
      if (target) {
        const { kind, resource_id: resource } = target,
          field = kind === "thread" ? "thread_id" : "run_id";
        if (kind === "task") {
          const result = await env.DB.batch([
            env.DB.prepare(
              "DELETE FROM task_versions WHERE rowid IN(SELECT rowid FROM task_versions WHERE task_id=? AND version<=? AND version<>(SELECT version FROM tasks WHERE id=task_versions.task_id) AND NOT EXISTS(SELECT 1 FROM runs WHERE runs.task_id=task_versions.task_id AND runs.task_version=task_versions.version) AND NOT EXISTS(SELECT 1 FROM account_dispatch_groups g WHERE g.task_id=task_versions.task_id AND g.task_version=task_versions.version) LIMIT 100)",
            ).bind(resource, target.cutoff_version),
            // 运行安全身份仍引用历史版本；保留最小版本身份并回收正文，不能破坏 FK 或释放 unknown。
            env.DB.prepare(
              "UPDATE task_versions SET definition='{}' WHERE rowid IN(SELECT rowid FROM task_versions WHERE task_id=? AND version<=? AND definition<>'{}' AND version<>(SELECT version FROM tasks WHERE id=task_versions.task_id) LIMIT 100)",
            ).bind(resource, target.cutoff_version),
          ]);
          if (result.every((r) => !r.meta.changes))
            await env.DB.prepare(
              "UPDATE history_cleanup_targets SET done=1 WHERE job_id=? AND kind='task' AND resource_id=?",
            )
              .bind(job.id, resource)
              .run();
        } else {
          const images = await env.DB.prepare(
            `SELECT id,object_key FROM artifacts WHERE ${field}=? LIMIT 10`,
          )
            .bind(resource)
            .all<{ id: string; object_key: string }>();
          for (const image of images.results) {
            await deleteEvidence(env, image.object_key);
            await env.DB.prepare("DELETE FROM artifacts WHERE id=?").bind(image.id).run();
          }
          const tables =
            kind === "thread"
              ? ["ai_messages", "execution_help"]
              : ["run_conditions", "execution_help"];
          const statements = tables.map((table) =>
            env.DB.prepare(
              `DELETE FROM ${table} WHERE rowid IN(SELECT rowid FROM ${table} WHERE ${field}=? LIMIT 100)`,
            ).bind(resource),
          );
          if (kind === "thread")
            statements.push(
              env.DB.prepare(
                "UPDATE conversation_inbox SET content='',status='failed' WHERE rowid IN(SELECT rowid FROM conversation_inbox WHERE thread_id=? AND (content<>'' OR status<>'failed') LIMIT 100)",
              ).bind(resource),
            );
          const graphWhere = kind === "thread" ? "parent_thread=?" : "run_id=?";
          for (const table of ["ai_checkpoints", "ai_writes"])
            statements.push(
              env.DB.prepare(
                `DELETE FROM ${table} WHERE rowid IN(SELECT p.rowid FROM ${table} p JOIN ai_graph_inputs g ON g.id=p.thread AND g.owner=p.owner WHERE g.${graphWhere} LIMIT 100)`,
              ).bind(resource),
            );
          const calls = await env.DB.prepare(
            `SELECT id FROM ai_calls WHERE (graph_id IN(SELECT id FROM ai_graph_inputs WHERE ${graphWhere}) ${kind === "run" ? "OR run_id=?" : ""})
            AND (status<>'unknown' OR error IS NULL OR error<>'THREAD_DELETED' OR EXISTS(SELECT 1 FROM call_results b WHERE b.id=ai_calls.id)) LIMIT 100`,
          )
            .bind(resource, ...(kind === "run" ? [resource] : []))
            .all<{ id: string }>();
          if (calls.results.length) {
            // 固定本批 ID；删除正文后不重新选择另一批，避免单次 alarm 清理无界数量的调用。
            const ids = calls.results.map((r) => r.id),
              placeholders = ids.map(() => "?").join(",");
            statements.push(
              env.DB.prepare(`DELETE FROM call_results WHERE id IN(${placeholders})`).bind(...ids),
            );
            statements.push(
              env.DB.prepare(
                `UPDATE ai_calls SET status='unknown',error='THREAD_DELETED' WHERE id IN(${placeholders}) AND (status<>'unknown' OR error IS NULL OR error<>'THREAD_DELETED')`,
              ).bind(...ids),
            );
          }
          const results = await env.DB.batch(statements);
          // 再经过一个无删除轮次才完成，避免刚好满批时漏掉余下内容。
          if (!images.results.length && results.every((r) => !r.meta.changes))
            await env.DB.prepare(
              "UPDATE history_cleanup_targets SET done=1 WHERE job_id=? AND kind=? AND resource_id=?",
            )
              .bind(job.id, kind, resource)
              .run();
        }
      }
      await env.DB.prepare(
        "UPDATE history_cleanup_jobs SET error=NULL,updated_at=?,status=CASE WHEN EXISTS(SELECT 1 FROM history_cleanup_targets WHERE job_id=? AND done=0) THEN 'pending' ELSE 'done' END WHERE id=?",
      )
        .bind(dbTime(now()), job.id, job.id)
        .run();
      await notifyUser(env, job.user_id);
    } catch {
      await env.DB.prepare(
        "UPDATE history_cleanup_jobs SET error='CLEANUP_RETRYING',updated_at=? WHERE id=?",
      )
        .bind(dbTime(now()), job.id)
        .run();
    }
  }
  return !!(await env.DB.prepare(
    "SELECT id FROM history_cleanup_jobs WHERE status='pending' LIMIT 1",
  ).first());
}
