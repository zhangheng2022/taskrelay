/** 云端队列与租约：固化运行快照、按用户公平领取、维护账号锁，并清理过期运行及推进已确认调度。 */
import { quotaDay } from './tenancy';
import {
  limits,
  PROTOCOL_VERSION,
  type TaskRun,
  type TaskDefinition,
} from "../../../packages/contracts/src/index";
import {
  latestDue,
  nextOccurrence,
} from "../../../packages/contracts/src/schedule";
export type Row = Record<string, any>;
export const now = () => new Date().toISOString();
export const uid = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
export function runFrom(row: Row): TaskRun {
  return {
    id: row.id,
    instructionVersion: row.instruction_version ?? 0,
    userId: row.user_id,
    profileId: row.profile_id,
    accountId: row.account_id ?? null,
    credentialVersion: row.account_credential_version ?? undefined,
    stateEpoch: row.account_state_epoch ?? undefined,
    cleanupPending: !!row.cleanup_pending,
    accountName: row.account_name ?? undefined,
    dispatchGroupId: row.dispatch_group_id ?? undefined,
    dispatchIndex: row.dispatch_index ?? undefined,
    dispatchTotal: row.dispatch_total ?? undefined,
    dispatchGroupActive: ['active','paused'].includes(row.dispatch_group_state),
    queueReason:row.queue_reason,
    taskId: row.task_id,
    task: JSON.parse(row.task_snapshot),
    status: row.status,
    scheduledFor: row.scheduled_for,
    deadline: row.deadline,
    deviceId: row.device_id,
    leaseEpoch: row.lease_epoch,
    leaseExpiresAt: row.lease_expires_at,
    cancelRequested: !!row.cancel_requested,
    writePending: !!row.write_pending,
    mayHaveWritten: !!row.may_have_written,
    result: row.result ? JSON.parse(row.result) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reconciliationOf: row.reconciliation_of ?? null,
  };
}
export function taskFrom(row: Row): TaskDefinition {
  return {
    ...JSON.parse(row.definition),
    confirmedCondition: row.confirmed_condition ?? null,
    status: row.status,
    nextRunAt: row.next_run_at,
  };
}
export async function getRun(db: D1Database, id: string) {
  const row = await db
    .prepare(`SELECT r.*,a.name account_name,g.state dispatch_group_state,
      (SELECT COUNT(*) FROM account_dispatch_members m WHERE m.group_id=r.dispatch_group_id) dispatch_total
      FROM runs r LEFT JOIN accounts a ON a.id=r.account_id LEFT JOIN account_dispatch_groups g ON g.id=r.dispatch_group_id WHERE r.id=?`)
    .bind(id)
    .first<Row>();
  if (!row) throw new Error("RUN_NOT_FOUND");
  return runFrom(row);
}
/** Read-only explanation of known claim blockers; never a claim decision or reservation. */
export async function queueReasons(db: D1Database, userId: string) {
  const at=now(), onlineAfter=new Date(Date.now()-limits.leaseMs).toISOString();
  const rows=await db.prepare(`SELECT r.id, CASE
    WHEN (SELECT value FROM settings WHERE key='maintenance')='1' THEN '云端维护中，暂不领取'
    WHEN (SELECT value FROM settings WHERE key='claimsEnabled')='0' THEN '管理员已暂停领取'
    WHEN r.deadline<=? THEN '已超过领取窗口，等待清理'
    WHEN m.disabled=1 THEN '当前用户已停用'
    WHEN ((SELECT COUNT(*) FROM runs used WHERE used.user_id=r.user_id AND used.started_day=?) + COALESCE((SELECT runs FROM quota_carry WHERE user_id=r.user_id AND day=?),0))>=m.daily_runs AND NOT COALESCE(m.daily_quota_paused=1 OR m.daily_quota_paused_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'),0) THEN '今日启动额度已用完，上海时间零点重置'
    WHEN EXISTS(SELECT 1 FROM runs active WHERE active.user_id=r.user_id AND (active.status IN ('running','waiting_user','verifying') OR active.cleanup_pending=1)) THEN '等待上一项运行、人工协助或浏览器清理结束'
    WHEN EXISTS(SELECT 1 FROM account_locks l WHERE l.account_key=r.account_key AND l.run_id<>COALESCE(r.reconciliation_of,'')) THEN '账号被占用或结果待核查'
    WHEN NOT EXISTS(SELECT 1 FROM devices d WHERE d.revoked=0 AND d.claim_ready=1 AND d.protocol_version=${PROTOCOL_VERSION} AND d.last_seen>?) THEN '没有最近在线、未暂停且版本兼容的可用设备'
    WHEN NOT EXISTS(SELECT 1 FROM devices d WHERE d.revoked=0 AND d.claim_ready=1 AND d.protocol_version=${PROTOCOL_VERSION} AND d.last_seen>? AND NOT EXISTS(SELECT 1 FROM runs busy WHERE busy.device_id=d.id AND (busy.status IN ('running','waiting_user','verifying') OR busy.cleanup_pending=1))) THEN '符合条件的设备正在执行其他任务或清理浏览器'
    ELSE '等待设备领取；设备本地暂停或网络状态可能影响领取' END reason
    FROM runs r JOIN tasks t ON t.id=r.task_id JOIN members m ON m.id=r.user_id
    LEFT JOIN accounts a ON a.id=json_extract(r.task_snapshot,'$.accountId') AND a.user_id=r.user_id
    WHERE r.user_id=? AND r.status='queued'`).bind(at,quotaDay(),quotaDay(),onlineAfter,onlineAfter,userId).all<{id:string;reason:string}>();
  return new Map(rows.results.map(r=>[r.id,r.reason]));
}
export async function enqueue(
  db: D1Database,
  task: TaskDefinition,
  key: string,
  scheduled = now(),
  command?: { id: string; threadId: string; groupId?: string; position?: number },
) {
  const owner=await db.prepare('SELECT user_id FROM tasks WHERE id=?').bind(task.id).first<{user_id:string}>();
  if(!owner) throw new Error('TASK_NOT_FOUND');
  const id = uid("run");
  const account=task.accountId ? await db.prepare('SELECT profile_id FROM accounts WHERE id=? AND user_id=?').bind(task.accountId,owner.user_id).first<{profile_id:string}>():null;
  // 未保存的环境只属于本次执行；保存卡片可将它转正，但后续无账号执行不能重新占用该目录。
  const profileId=account?.profile_id ?? (task.accountId ?? `temporary_${id}`);
  if(task.confirmedCondition){
    const card=await db.prepare('SELECT confirmed_content FROM run_conditions WHERE run_id=? AND task_id=? AND approved_version=?').bind(task.confirmedCondition,task.id,task.version).first<{confirmed_content:string}>();
    if(card?.confirmed_content)task={...task,runConditions:JSON.parse(card.confirmed_content)};
  }
  const at = now(),
    deadline = new Date(
      new Date(scheduled).getTime() + limits.lateMs,
    ).toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO runs(id,task_id,task_snapshot,status,scheduled_for,deadline,account_key,idempotency_key,created_at,updated_at,user_id,profile_id,execution_protocol,thread_id,account_id,dispatch_group_id,dispatch_index)
      SELECT ?,?,?,'queued',?,?,?,?,?,?,?,?,${PROTOCOL_VERSION},${command ? '?' : '(SELECT id FROM ai_threads WHERE task_id=? AND closed=0 LIMIT 1)'},?,?,?
      WHERE EXISTS(SELECT 1 FROM tasks WHERE id=? AND version=? AND context_withdrawn=0 AND deleted=0)
      ${command ? `AND EXISTS(SELECT 1 FROM conversation_commands c JOIN ai_threads t ON t.id=c.thread_id
        WHERE c.id=? AND c.thread_id=? AND c.task_id=? AND c.state ${command.groupId?"IN ('committed','done')":"='committed'"} AND c.run_task IS NOT NULL AND t.closed=0 AND t.user_id=?)` : ''}
      ${command?.groupId?`AND EXISTS(SELECT 1 FROM account_dispatch_groups g JOIN account_dispatch_members m ON m.group_id=g.id
        WHERE g.id=? AND g.state='active' AND m.position=? AND m.state='pending'
        AND NOT EXISTS(SELECT 1 FROM account_dispatch_members earlier WHERE earlier.group_id=g.id AND earlier.position<m.position AND earlier.state<>'done'))`:''}`,
    )
    .bind(
      id,
      task.id,
      JSON.stringify(task),
      scheduled,
      deadline,
      task.accountId ?? `task:${task.id}`,
      key,
      at,
      at,owner.user_id,profileId,command?.threadId ?? task.id,task.accountId,command?.groupId??null,command?.position??null,
      task.id, task.version,
      ...(command ? [command.id, command.threadId, task.id, owner.user_id] : []),
      ...(command?.groupId ? [command.groupId,command.position] : []),
    )
    .run();
  const saved = await db
      .prepare("SELECT * FROM runs WHERE idempotency_key=?")
      .bind(key)
      .first<Row>();
  if (!saved) throw new Error(command ? 'COMMAND_RETIRED' : 'TASK_CONTEXT_OR_VERSION_CHANGED');
  return runFrom(saved);
}
export async function claim(
  db: D1Database,
  deviceId: string,
  requestId: string,
): Promise<TaskRun | null> {
  if((await db.prepare("SELECT value FROM settings WHERE key='claimsEnabled'").first<{value:string}>())?.value==='0') return null;
  const prior = await db
    .prepare(
      `SELECT r.*,a.name account_name,g.state dispatch_group_state,(SELECT COUNT(*) FROM account_dispatch_members m WHERE m.group_id=r.dispatch_group_id) dispatch_total
       FROM claims c JOIN runs r ON r.id=c.run_id LEFT JOIN accounts a ON a.id=r.account_id LEFT JOIN account_dispatch_groups g ON g.id=r.dispatch_group_id WHERE c.device_id=? AND c.request_id=?`,
    )
    .bind(deviceId, requestId)
    .first<Row>();
  if (prior) return ["running","waiting_user","verifying"].includes(prior.status) && prior.lease_expires_at>now() && !prior.cancel_requested ? runFrom(prior) : null;
  const at = now();
  const busy = await db
    .prepare(
      "SELECT id FROM runs WHERE device_id=? AND (status IN ('running','waiting_user','verifying') OR cleanup_pending=1)",
    )
    .bind(deviceId)
    .first();
  if (busy) return null;
  const candidate = await db
    .prepare(
      `SELECT r.* FROM runs r JOIN tasks t ON r.task_id=t.id JOIN members m ON m.id=r.user_id LEFT JOIN accounts a ON a.id=r.account_id
       WHERE m.disabled=0 AND t.deleted=0 AND t.context_withdrawn=0
       AND NOT EXISTS(SELECT 1 FROM runs active WHERE active.user_id=r.user_id AND (active.status IN ('running','waiting_user','verifying') OR active.cleanup_pending=1))
       AND (m.daily_quota_paused=1 OR m.daily_quota_paused_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') OR ((SELECT COUNT(*) FROM runs used WHERE used.user_id=r.user_id AND used.started_day=?) + COALESCE((SELECT runs FROM quota_carry WHERE user_id=r.user_id AND day=?),0))<m.daily_runs)
       AND EXISTS(SELECT 1 FROM devices WHERE id=? AND revoked=0 AND claim_ready=1)
       AND NOT EXISTS(SELECT 1 FROM devices preferred WHERE preferred.id=COALESCE(a.last_device_id,a.assigned_device_id) AND preferred.id<>?
         AND preferred.revoked=0 AND preferred.claim_ready=1 AND preferred.protocol_version=${PROTOCOL_VERSION} AND preferred.last_seen>?
         AND NOT EXISTS(SELECT 1 FROM runs busy WHERE busy.device_id=preferred.id AND (busy.status IN ('running','waiting_user','verifying') OR busy.cleanup_pending=1)))
       AND r.execution_protocol=${PROTOCOL_VERSION} AND r.status='queued' AND r.deadline>?
       AND (r.dispatch_group_id IS NULL OR EXISTS(SELECT 1 FROM account_dispatch_groups g WHERE g.id=r.dispatch_group_id AND g.state='active'))
       AND (NOT EXISTS(SELECT 1 FROM account_locks l WHERE l.account_key=r.account_key) OR EXISTS(SELECT 1 FROM account_locks l JOIN runs old ON old.id=l.run_id WHERE l.account_key=r.account_key AND old.id=r.reconciliation_of AND old.status='unknown' AND old.cleanup_pending=0))
       ORDER BY COALESCE(m.last_claim_at,''),r.created_at,r.id LIMIT 1`,
    )
    .bind(quotaDay(),quotaDay(),deviceId,deviceId,new Date(Date.now()-limits.leaseMs).toISOString(),at)
    .first<Row>();
  if (!candidate) return null;
  const lease = new Date(Date.now() + limits.leaseMs).toISOString();
  try { await db.batch([
    db
      .prepare(
        "UPDATE account_locks SET run_id=? WHERE run_id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND status='queued' AND reconciliation_of=?) AND NOT EXISTS(SELECT 1 FROM runs WHERE device_id=? AND (status IN ('running','waiting_user','verifying') OR cleanup_pending=1))",
      )
      .bind(
        candidate.id,
        candidate.reconciliation_of ?? "",
        candidate.id,
        candidate.reconciliation_of ?? "",
        deviceId,
      ),
    db
      .prepare(
        "INSERT OR IGNORE INTO account_locks(account_key,run_id) SELECT account_key,id FROM runs WHERE id=? AND status='queued' AND NOT EXISTS(SELECT 1 FROM runs WHERE device_id=? AND (status IN ('running','waiting_user','verifying') OR cleanup_pending=1))",
      )
      .bind(candidate.id, deviceId),
    db
      .prepare(
        `UPDATE runs SET status='running',device_id=?,lease_epoch=lease_epoch+1,lease_expires_at=?,updated_at=?,started_day=?,cleanup_pending=1,cleanup_confirmed=0,
          account_credential_version=COALESCE((SELECT credential_version FROM accounts WHERE id=runs.account_id AND user_id=runs.user_id),1),
          account_state_epoch=COALESCE((SELECT state_epoch FROM accounts WHERE id=runs.account_id AND user_id=runs.user_id),1),
          profile_id=COALESCE((SELECT profile_id FROM accounts WHERE id=runs.account_id AND user_id=runs.user_id),profile_id)
          WHERE id=? AND status='queued' AND EXISTS(SELECT 1 FROM account_locks WHERE run_id=runs.id)
          AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.device_id=? AND (r.status IN ('running','waiting_user','verifying') OR r.cleanup_pending=1))`,
      )
      .bind(deviceId, lease, at, quotaDay(), candidate.id, deviceId),
    // 状态发布权随成功领取转移，并在释放锁后保留；旧执行的清理重试不能再发布迟到快照。
    db.prepare(`UPDATE accounts SET state_owner_run_id=? WHERE id=(SELECT account_id FROM runs
      WHERE id=? AND device_id=? AND status='running' AND EXISTS(SELECT 1 FROM account_locks WHERE run_id=runs.id AND account_key=runs.account_id))`)
      .bind(candidate.id,candidate.id,deviceId),
    db
      .prepare(
        "INSERT OR IGNORE INTO claims(device_id,request_id,run_id) SELECT ?,?,id FROM runs WHERE id=? AND device_id=? AND status='running'",
      )
      .bind(deviceId, requestId, candidate.id, deviceId),
    db
      .prepare(
        "DELETE FROM account_locks WHERE run_id=? AND NOT EXISTS(SELECT 1 FROM runs WHERE id=? AND (status IN ('running','waiting_user','verifying','unknown') OR cleanup_pending=1))",
      )
      .bind(candidate.id, candidate.id),
  ]); } catch(e) {
    if(/CLAIM_BUSY|RUN_QUOTA_EXCEEDED|USER_DISABLED|ACCOUNT_DEVICE_MISMATCH/.test((e as Error).message)) return null;
    throw e;
  }
  const row = await db
    .prepare(
      `SELECT r.*,a.name account_name,g.state dispatch_group_state,(SELECT COUNT(*) FROM account_dispatch_members m WHERE m.group_id=r.dispatch_group_id) dispatch_total
       FROM claims c JOIN runs r ON r.id=c.run_id LEFT JOIN accounts a ON a.id=r.account_id LEFT JOIN account_dispatch_groups g ON g.id=r.dispatch_group_id WHERE c.device_id=? AND c.request_id=?`,
    )
    .bind(deviceId, requestId)
    .first<Row>();
  return row ? runFrom(row) : null;
}
export async function requireLease(
  db: D1Database,
  id: string,
  deviceId: string,
  epoch: number,
  allowCancelled = false,
) {
  const run = await getRun(db, id);
  if (
    run.deviceId !== deviceId ||
    run.leaseEpoch !== epoch ||
    !run.leaseExpiresAt ||
    run.leaseExpiresAt <= now() ||
    !["running", "waiting_user", "verifying"].includes(run.status)
  )
    throw new Error("LEASE_EXPIRED");
  if (run.cancelRequested && !allowCancelled)
    throw new Error("CANCEL_REQUESTED");
  return run;
}
export async function tick(db: D1Database) {
  if((await db.prepare("SELECT value FROM settings WHERE key='maintenance'").first<{value:string}>())?.value==='1') return;
  const at = now();
  await db.batch([
    db
      .prepare(
        "UPDATE runs SET status='expired',updated_at=? WHERE status='queued' AND deadline<=?",
      )
      .bind(at, at),
    db
      .prepare(
        "UPDATE runs SET status=CASE WHEN write_pending=1 OR may_have_written=1 THEN 'unknown' ELSE 'failed' END,result=?,updated_at=? WHERE status IN ('running','waiting_user','verifying') AND lease_expires_at<=?",
      )
      .bind(
        JSON.stringify({
          summary: "执行器租约过期，未确认的操作需先核查",
          outcome: "unconfirmed",
          evidence: [],
          errorCode: "LEASE_EXPIRED",
        }),
        at,
        at,
      ),
    db.prepare(
      "UPDATE account_locks SET run_id=(SELECT reconciliation_of FROM runs WHERE id=account_locks.run_id) WHERE run_id IN (SELECT id FROM runs WHERE reconciliation_of IS NOT NULL AND cleanup_pending=0 AND status IN ('failed','cancelled','expired','unknown'))",
    ),
    db.prepare(
      "DELETE FROM account_locks WHERE run_id IN (SELECT id FROM runs WHERE cleanup_pending=0 AND status IN ('failed','cancelled','expired','succeeded'))",
    ),
    db
      .prepare(
        "UPDATE challenges SET status='expired',secret=NULL WHERE expires_at<=? AND status<>'consumed'",
      )
      .bind(at),
    db.prepare("DELETE FROM pairings WHERE expires_at<=?").bind(at),
  ]);
  const due = await db
    .prepare(
      "SELECT * FROM tasks WHERE status='active' AND next_run_at<=? ORDER BY next_run_at LIMIT 100",
    )
    .bind(at)
    .all<Row>();
  for (const row of due.results) {
    const task = taskFrom(row),
      slot = latestDue(task.schedule, new Date(at));
    const active = await db
      .prepare(
        "SELECT id FROM runs WHERE task_id=? AND status IN ('queued','running','waiting_user','verifying','unknown')",
      )
      .bind(task.id)
      .first();
    if (slot && Date.parse(at) - Date.parse(slot) < limits.lateMs && !active) { try { await enqueue(
        db,
        task,
        `schedule:${task.id}:${task.version}:${slot}`,
        slot,
      ); } catch(e) { if(!/QUEUE_LIMIT|USER_DISABLED|TASK_CONTEXT_OR_VERSION_CHANGED/.test((e as Error).message)) throw e; } }
    await db
      .prepare(
        "UPDATE tasks SET next_run_at=? WHERE id=? AND version=? AND next_run_at=?",
      )
      .bind(
        task.confirmedCondition ? nextOccurrence(task.schedule, new Date(at)) : null,
        task.id,
        task.version,
        row.next_run_at,
      )
      .run();
  }
}
