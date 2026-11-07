import { dbTime } from "./database";
/** 账号执行组固定交办时的账号顺序。成员仅在前一浏览器已清理后投递，
 * 不把等待成员放入有领取期限的 runs；D1 条件写入处理重试、停止及聊天退休。
 */
import type { TaskDefinition } from "../../../packages/contracts/src/index";
import { enqueue, getRun, now, type Row } from "./store";
import { hash } from "../../../packages/contracts/src/security";
import { accountMatchesDomain } from "./accounts";

/** 网站“立即运行”复用已确认的账号集合；新请求创建新组，相同请求只返回原组。 */
export async function enqueueTaskDispatch(db: D1Database, task: TaskDefinition, key: string) {
  if (!task.accountIds || task.accountIds.length < 2) return enqueue(db, task, key);
  const id = `rerun_${(await hash(key)).slice(0, 48)}`;
  let command = await db
    .prepare("SELECT * FROM conversation_commands WHERE id=?")
    .bind(id)
    .first<Row>();
  if (!command) {
    const thread = await db
      .prepare(
        `SELECT t.id,t.user_id FROM ai_threads t JOIN tasks task ON task.id=t.task_id
      WHERE t.task_id=? AND t.closed=0 AND task.version=? AND task.context_withdrawn=0 AND task.deleted=0 ORDER BY t.created_at DESC LIMIT 1`,
      )
      .bind(task.id, task.version)
      .first<{ id: string; user_id: string }>();
    if (!thread) throw Error("TASK_CONTEXT_OR_VERSION_CHANGED");
    for (const accountId of task.accountIds) {
      const account = await db
        .prepare("SELECT * FROM account_details WHERE id=? AND user_id=?")
        .bind(accountId, thread.user_id)
        .first<Row>();
      if (!account || !accountMatchesDomain(account, task.entryUrl))
        throw Error("ACCOUNT_ORIGIN_MISMATCH");
    }
    await db
      .prepare(
        `INSERT OR IGNORE INTO conversation_commands(id,thread_id,task_id,run_task,state,created_at)
      SELECT ?,?,?,?,'committed',? WHERE EXISTS(SELECT 1 FROM tasks task JOIN ai_threads t ON t.task_id=task.id
        WHERE task.id=? AND task.version=? AND task.context_withdrawn=0 AND task.deleted=0 AND t.id=? AND t.closed=0)
      AND NOT EXISTS(SELECT 1 FROM runs WHERE task_id=? AND (status IN ('queued','running','waiting_user','verifying','unknown') OR cleanup_pending=1))
      AND NOT EXISTS(SELECT 1 FROM account_dispatch_groups WHERE task_id=? AND state IN ('active','paused'))
      AND NOT EXISTS(SELECT 1 FROM conversation_commands WHERE task_id=? AND state='committed' AND run_task IS NOT NULL)`,
      )
      .bind(
        id,
        thread.id,
        task.id,
        JSON.stringify(task),
        dbTime(now()),
        task.id,
        task.version,
        thread.id,
        task.id,
        task.id,
        task.id,
      )
      .run();
    command = await db
      .prepare("SELECT * FROM conversation_commands WHERE id=?")
      .bind(id)
      .first<Row>();
    if (!command) throw Error("RUN_ALREADY_ACTIVE");
  }
  if (command.run_task) {
    await ensureDispatchGroup(db, command);
    await advanceDispatchGroups(db, id);
  }
  await db
    .prepare("UPDATE conversation_commands SET state='done' WHERE id=? AND state='committed'")
    .bind(id)
    .run();
  const first = await db
    .prepare("SELECT id FROM runs WHERE dispatch_group_id=? ORDER BY dispatch_index LIMIT 1")
    .bind(id)
    .first<{ id: string }>();
  return first ? getRun(db, first.id) : { dispatchGroupId: id, status: "queued" as const };
}

/** 命令本身是幂等身份；账号集合只从已提交快照读取，后续新增账号不会加入。 */
export async function ensureDispatchGroup(db: D1Database, command: Row) {
  const task = JSON.parse(command.run_task) as TaskDefinition;
  const accounts = task.accountIds?.length ? task.accountIds : [task.accountId];
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO account_dispatch_groups(id,task_id,task_version,thread_id,user_id,created_at,updated_at,member_count)
      SELECT c.id,c.task_id,?,c.thread_id,t.user_id,?,?,? FROM conversation_commands c JOIN ai_threads t ON t.id=c.thread_id
      WHERE c.id=? AND c.state='committed' AND c.run_task IS NOT NULL AND t.closed=0
      AND EXISTS(SELECT 1 FROM tasks WHERE id=c.task_id AND version=? AND context_withdrawn=0 AND deleted=0)`,
      )
      .bind(task.version, dbTime(now()), dbTime(now()), accounts.length, command.id, task.version),
    db
      .prepare(
        `INSERT OR IGNORE INTO account_dispatch_members(group_id,position,account_id)
      SELECT g.id,CAST(j.key AS INTEGER),j.value FROM account_dispatch_groups g,json_each(?) j
      WHERE g.id=? AND g.state='active'`,
      )
      .bind(JSON.stringify(accounts), command.id),
  ]);
}

/** 停止整个交办组，包含在停止与成员登记之间已经创建的运行。 */
export async function cancelDispatchGroup(db: D1Database, runId: string) {
  const group = await db
    .prepare("SELECT dispatch_group_id id FROM runs WHERE id=?")
    .bind(runId)
    .first<{ id: string | null }>();
  if (!group?.id) return;
  await db.batch([
    db
      .prepare(
        "UPDATE account_dispatch_groups SET state='cancelled',updated_at=? WHERE id=? AND state IN ('active','paused')",
      )
      .bind(dbTime(now()), group.id),
    db
      .prepare(
        "UPDATE account_dispatch_members SET state='cancelled' WHERE group_id=? AND state='pending'",
      )
      .bind(group.id),
    db
      .prepare(
        `UPDATE runs SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=?
      WHERE dispatch_group_id=? AND status IN ('queued','running','waiting_user','verifying')`,
      )
      .bind(dbTime(now()), group.id),
  ]);
}

/** Scheduler 与清理确认都可以调用；并发调用通过成员身份和 enqueue 的原子条件去重。 */
export async function advanceDispatchGroups(db: D1Database, id?: string) {
  await db.batch([
    db
      .prepare(
        `UPDATE account_dispatch_groups SET state='paused',updated_at=? WHERE state='active'
      AND EXISTS(SELECT 1 FROM runs WHERE dispatch_group_id=account_dispatch_groups.id AND status='unknown')`,
      )
      .bind(dbTime(now())),
    db
      .prepare(
        `UPDATE account_dispatch_groups SET state='cancelled',updated_at=? WHERE state='active'
      AND EXISTS(SELECT 1 FROM runs WHERE dispatch_group_id=account_dispatch_groups.id AND (cancel_requested=1 OR status='cancelled'))`,
      )
      .bind(dbTime(now())),
    db.prepare(`UPDATE account_dispatch_members SET state='done' WHERE state='enqueued' AND EXISTS(
      SELECT 1 FROM runs r WHERE r.id=account_dispatch_members.run_id AND r.status IN ('succeeded','failed','expired')
      AND r.cleanup_pending=0 AND NOT EXISTS(SELECT 1 FROM account_locks WHERE run_id=r.id))`),
    db.prepare(`UPDATE account_dispatch_members SET state='cancelled' WHERE state='pending' AND EXISTS(
      SELECT 1 FROM account_dispatch_groups g WHERE g.id=account_dispatch_members.group_id AND g.state IN ('cancelled','retired'))`),
    db
      .prepare(
        `UPDATE account_dispatch_groups SET state='completed',updated_at=? WHERE state='active'
      AND NOT EXISTS(SELECT 1 FROM account_dispatch_members WHERE group_id=account_dispatch_groups.id AND state<>'done')`,
      )
      .bind(dbTime(now())),
  ]);
  const rows = await db
    .prepare(
      `SELECT g.*,c.run_task,m.position,m.account_id FROM account_dispatch_groups g
    JOIN conversation_commands c ON c.id=g.id JOIN account_dispatch_members m ON m.group_id=g.id
    JOIN ai_threads t ON t.id=g.thread_id JOIN tasks task ON task.id=g.task_id
    WHERE g.state='active' AND m.state='pending' AND c.run_task IS NOT NULL AND c.state IN ('committed','done')
    AND t.closed=0 AND task.context_withdrawn=0 AND task.deleted=0 AND task.version=g.task_version
    AND NOT EXISTS(SELECT 1 FROM account_dispatch_members earlier WHERE earlier.group_id=g.id AND earlier.position<m.position AND earlier.state<>'done')
    ${id ? "AND g.id=?" : ""} ORDER BY g.created_at,m.position LIMIT 20`,
    )
    .bind(...(id ? [id] : []))
    .all<Row>();
  for (const row of rows.results) {
    const definition = JSON.parse(row.run_task) as TaskDefinition;
    // 每个执行只看到当前账号；组名单留在云端，不能把其他账号凭据带进当前环境。
    const task: TaskDefinition = {
      ...definition,
      accountId: row.account_id,
      accountIds: undefined,
    };
    try {
      const run = await enqueue(
        db,
        task,
        `manual:conversation:${row.id}${row.position ? `:${row.position}` : ""}`,
        undefined,
        { id: row.id, threadId: row.thread_id, groupId: row.id, position: row.position },
      );
      await db
        .prepare(
          `UPDATE account_dispatch_members SET run_id=?,state='enqueued' WHERE group_id=? AND position=? AND state='pending'
        AND EXISTS(SELECT 1 FROM account_dispatch_groups WHERE id=? AND state='active')`,
        )
        .bind(run.id, row.id, row.position, row.id)
        .run();
    } catch (error) {
      if (
        !/COMMAND_RETIRED|TASK_CONTEXT_OR_VERSION_CHANGED|QUEUE_LIMIT|USER_DISABLED/.test(
          (error as Error).message,
        )
      )
        throw error;
    }
  }
}
