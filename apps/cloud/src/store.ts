import {
  limits,
  type TaskRun,
  type TaskDefinition,
  type RunResult,
  type RunStatus,
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
    status: row.status,
    nextRunAt: row.next_run_at,
  };
}
export async function getRun(db: D1Database, id: string) {
  const row = await db
    .prepare("SELECT * FROM runs WHERE id=?")
    .bind(id)
    .first<Row>();
  if (!row) throw new Error("RUN_NOT_FOUND");
  return runFrom(row);
}
export async function enqueue(
  db: D1Database,
  task: TaskDefinition,
  key: string,
  scheduled = now(),
) {
  const id = uid("run"),
    at = now(),
    deadline = new Date(
      new Date(scheduled).getTime() + limits.lateMs,
    ).toISOString();
  await db
    .prepare(
      "INSERT OR IGNORE INTO runs(id,task_id,task_snapshot,status,scheduled_for,deadline,account_key,idempotency_key,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?,?,?,?)",
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
      at,
    )
    .run();
  return runFrom(
    (await db
      .prepare("SELECT * FROM runs WHERE idempotency_key=?")
      .bind(key)
      .first<Row>())!,
  );
}
export async function claim(
  db: D1Database,
  deviceId: string,
  requestId: string,
): Promise<TaskRun | null> {
  const prior = await db
    .prepare(
      "SELECT r.* FROM claims c JOIN runs r ON r.id=c.run_id WHERE c.device_id=? AND c.request_id=?",
    )
    .bind(deviceId, requestId)
    .first<Row>();
  if (prior) return runFrom(prior);
  const at = now();
  const busy = await db
    .prepare(
      "SELECT id FROM runs WHERE device_id=? AND status IN ('running','waiting_user','verifying')",
    )
    .bind(deviceId)
    .first();
  if (busy) return null;
  const candidate = await db
    .prepare(
      "SELECT r.* FROM runs r JOIN tasks t ON r.task_id=t.id WHERE r.status='queued' AND r.deadline>? AND (t.status IN ('active','pending_validation') OR r.idempotency_key LIKE 'manual:%' OR r.reconciliation_of IS NOT NULL) AND (NOT EXISTS(SELECT 1 FROM account_locks l WHERE l.account_key=r.account_key) OR EXISTS(SELECT 1 FROM account_locks l JOIN runs old ON old.id=l.run_id WHERE l.account_key=r.account_key AND old.id=r.reconciliation_of AND old.status='unknown')) ORDER BY r.created_at LIMIT 1",
    )
    .bind(at)
    .first<Row>();
  if (!candidate) return null;
  const lease = new Date(Date.now() + limits.leaseMs).toISOString();
  await db.batch([
    db
      .prepare(
        "UPDATE account_locks SET run_id=? WHERE run_id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND status='queued' AND reconciliation_of=?) AND NOT EXISTS(SELECT 1 FROM runs WHERE device_id=? AND status IN ('running','waiting_user','verifying'))",
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
        "INSERT OR IGNORE INTO account_locks(account_key,run_id) SELECT account_key,id FROM runs WHERE id=? AND status='queued' AND NOT EXISTS(SELECT 1 FROM runs WHERE device_id=? AND status IN ('running','waiting_user','verifying'))",
      )
      .bind(candidate.id, deviceId),
    db
      .prepare(
        "UPDATE runs SET status='running',device_id=?,lease_epoch=lease_epoch+1,lease_expires_at=?,updated_at=? WHERE id=? AND status='queued' AND EXISTS(SELECT 1 FROM account_locks WHERE run_id=runs.id) AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.device_id=? AND r.status IN ('running','waiting_user','verifying'))",
      )
      .bind(deviceId, lease, at, candidate.id, deviceId),
    db
      .prepare(
        "INSERT OR IGNORE INTO claims(device_id,request_id,run_id) SELECT ?,?,id FROM runs WHERE id=? AND device_id=? AND status='running'",
      )
      .bind(deviceId, requestId, candidate.id, deviceId),
    db
      .prepare(
        "DELETE FROM account_locks WHERE run_id=? AND NOT EXISTS(SELECT 1 FROM runs WHERE id=? AND status IN ('running','waiting_user','verifying','unknown'))",
      )
      .bind(candidate.id, candidate.id),
  ]);
  const row = await db
    .prepare(
      "SELECT r.* FROM claims c JOIN runs r ON r.id=c.run_id WHERE c.device_id=? AND c.request_id=?",
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
export async function finish(
  db: D1Database,
  run: TaskRun,
  status: RunStatus,
  result: RunResult,
) {
  if ((run.writePending || run.mayHaveWritten) && status !== "succeeded")
    status = "unknown";
  const at = now();
  const statements = [
    db
      .prepare(
        "UPDATE runs SET status=?,result=?,updated_at=?,lease_expires_at=NULL WHERE id=? AND lease_epoch=? AND status IN ('running','waiting_user','verifying')",
      )
      .bind(status, JSON.stringify(result), at, run.id, run.leaseEpoch),
    db
      .prepare(
        "UPDATE challenges SET status='expired',secret=NULL WHERE run_id=? AND status<>'consumed'",
      )
      .bind(run.id),
  ];
  if (run.reconciliationOf) {
    if (status === "succeeded")
      statements.push(
        db
          .prepare(
            "UPDATE runs SET status='succeeded',write_pending=0,result=?,updated_at=? WHERE id=? AND status='unknown' AND EXISTS(SELECT 1 FROM runs WHERE id=? AND status='succeeded' AND lease_epoch=?)",
          )
          .bind(
            JSON.stringify({
              ...result,
              summary: "只读核查已确认成功判据：" + result.summary,
              outcome: "already_done",
            }),
            at,
            run.reconciliationOf,
            run.id,
            run.leaseEpoch,
          ),
      );
    else
      statements.push(
        db
          .prepare(
            "UPDATE account_locks SET run_id=? WHERE run_id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND status IN ('failed','cancelled','unknown','expired'))",
          )
          .bind(run.reconciliationOf, run.id, run.id),
      );
  }
  if (status !== "unknown")
    statements.push(
      db
        .prepare(
          "DELETE FROM account_locks WHERE run_id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND lease_epoch=? AND status IN ('succeeded','failed','cancelled','expired'))",
        )
        .bind(run.id, run.id, run.leaseEpoch),
    );
  if (status === "succeeded" && run.task.status === "pending_validation")
    statements.push(
      db
        .prepare(
          "UPDATE tasks SET status='active',next_run_at=?,updated_at=? WHERE id=? AND version=? AND status='pending_validation' AND EXISTS(SELECT 1 FROM runs WHERE id=? AND lease_epoch=? AND status='succeeded')",
        )
        .bind(
          nextOccurrence(run.task.schedule),
          at,
          run.taskId,
          run.task.version,
          run.id,
          run.leaseEpoch,
        ),
    );
  await db.batch(statements);
}
export async function tick(db: D1Database) {
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
      "UPDATE account_locks SET run_id=(SELECT reconciliation_of FROM runs WHERE id=account_locks.run_id) WHERE run_id IN (SELECT id FROM runs WHERE reconciliation_of IS NOT NULL AND status IN ('failed','cancelled','expired','unknown'))",
    ),
    db.prepare(
      "DELETE FROM account_locks WHERE run_id IN (SELECT id FROM runs WHERE status IN ('failed','cancelled','expired','succeeded'))",
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
    if (slot && !active)
      await enqueue(
        db,
        task,
        `schedule:${task.id}:${task.version}:${slot}`,
        slot,
      );
    await db
      .prepare(
        "UPDATE tasks SET next_run_at=? WHERE id=? AND version=? AND next_run_at=?",
      )
      .bind(
        nextOccurrence(task.schedule, new Date(at)),
        task.id,
        task.version,
        row.next_run_at,
      )
      .run();
  }
}
