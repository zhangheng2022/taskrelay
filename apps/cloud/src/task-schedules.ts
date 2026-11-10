/** 云端拥有调度与需求确认。卡片写入采用版本和请求身份；定时运行复用账号执行组。 */
import { Hono } from "hono";
import { z } from "zod";
import {
  frequencySchema,
  type Frequency,
  type ScheduleCard,
} from "../../../packages/contracts/src/task-schedule";
import { idSchema, type TaskInput } from "../../../packages/contracts/src/index";
import { nextOccurrence, latestDue } from "../../../packages/contracts/src/schedule";
import { hash } from "../../../packages/contracts/src/security";
import type { AppEnv, Variables } from "./env";
import { seal, unseal } from "./crypto";
import { dbTime } from "./database";
import { requireLease, taskFrom, now, type Row } from "./store";
import { enqueueTaskDispatch } from "./account-dispatch";
import { capturePreferences } from "./ai/preferences";
import { learningSnapshot, listLearning } from "./execution-learning";

export function frequencySchedule(frequency: Frequency): TaskInput["schedule"] {
  try {
    new Intl.DateTimeFormat("en", { timeZone: frequency.timezone }).format();
  } catch {
    throw Error("SCHEDULE_TIMEZONE_INVALID");
  }
  if (frequency.kind === "once") return { kind: "once", at: frequency.at };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(frequency.time)) throw Error("SCHEDULE_TIME_INVALID");
  const [hour, minute] = frequency.time.split(":").map(Number);
  return {
    kind: "cron",
    timezone: frequency.timezone,
    expression: `${minute} ${hour} ${frequency.kind === "monthly" ? frequency.day : "*"} * ${frequency.kind === "weekly" ? [...new Set(frequency.days)].sort((a, b) => a - b).join(",") : "*"}`,
  };
}
export function previewSchedule(frequency: Frequency, after = new Date()) {
  const schedule = frequencySchedule(frequency),
    times: string[] = [];
  for (let i = 0; i < 3; i++) {
    const next = nextOccurrence(schedule, after);
    if (!next) break;
    times.push(next);
    after = new Date(next);
  }
  return times;
}
export async function scheduleCard(env: AppEnv, taskId: string): Promise<ScheduleCard | null> {
  const row = await env.DB.prepare(
    `SELECT s.*,t.title,EXISTS(SELECT 1 FROM ai_threads h WHERE h.id=s.thread_id AND h.closed=0 AND (h.active_turn IS NOT NULL OR EXISTS(SELECT 1 FROM conversation_inbox i WHERE i.thread_id=h.id AND i.status IN ('pending','processing')) OR ((SELECT COALESCE(MAX(seq),0) FROM ai_messages WHERE thread_id=h.id AND role='user')>s.confirmed_seq))) processing FROM task_schedules s JOIN tasks t ON t.id=s.task_id WHERE s.task_id=? AND t.deleted=0 AND t.context_withdrawn=0`,
  )
    .bind(taskId)
    .first<Row>();
  if (!row) return null;
  const old = row.schedule ? (JSON.parse(row.schedule) as TaskInput["schedule"]) : null;
  return {
    version: row.version,
    taskVersion: row.task_version,
    ready: !!row.ready && !row.processing,
    summary: row.summary
      ? await unseal<string>(row.summary, env.MASTER_KEY, `schedule:${taskId}`)
      : row.title,
    state: row.state,
    frequency: row.frequency ? JSON.parse(row.frequency) : null,
    legacy:
      row.legacy && old?.kind === "cron"
        ? { expression: old.expression, timezone: old.timezone }
        : null,
    nextRunAt: row.next_run_at,
  };
}
export async function confirmRequirements(
  env: AppEnv,
  runId: string,
  deviceId: string,
  input: { epoch: number; userSeq: number; summary: string; changed: boolean },
) {
  const run = await requireLease(env.DB, runId, deviceId, input.epoch);
  const summary = await seal(input.summary, env.MASTER_KEY, `schedule:${run.taskId}`);
  const saved = await env.DB.prepare(
    `INSERT INTO task_schedules(task_id,thread_id,task_version,confirmed_seq,summary,ready)
    SELECT r.task_id,r.thread_id,r.task_version,?,?,1 FROM runs r JOIN tasks t ON t.id=r.task_id JOIN ai_threads h ON h.id=r.thread_id
    WHERE r.id=? AND r.lease_epoch=? AND r.lease_expires_at>? AND r.cancel_requested=0 AND r.history_deleted=0 AND t.version=r.task_version AND t.context_withdrawn=0 AND h.closed=0
    AND (SELECT COALESCE(MAX(seq),0) FROM ai_messages WHERE thread_id=r.thread_id AND role='user')=?
    ON CONFLICT(task_id) DO UPDATE SET thread_id=excluded.thread_id,task_version=excluded.task_version,confirmed_seq=excluded.confirmed_seq,summary=excluded.summary,ready=1,
    state=CASE WHEN (?=1 AND confirmed_seq<>excluded.confirmed_seq) OR task_schedules.task_version<>excluded.task_version THEN 'paused' ELSE state END,
    next_run_at=CASE WHEN (?=1 AND confirmed_seq<>excluded.confirmed_seq) OR task_schedules.task_version<>excluded.task_version THEN NULL ELSE next_run_at END,
    requirement_revision=CASE WHEN task_schedules.task_version<>excluded.task_version THEN 0 ELSE requirement_revision+CASE WHEN ?=1 AND confirmed_seq<>excluded.confirmed_seq THEN 1 ELSE 0 END END,
    version=version+CASE WHEN (?=1 AND confirmed_seq<>excluded.confirmed_seq) OR ready=0 OR task_schedules.task_version<>excluded.task_version THEN 1 ELSE 0 END`,
  )
    .bind(
      input.userSeq,
      summary,
      run.id,
      input.epoch,
      dbTime(now()),
      input.userSeq,
      Number(input.changed),
      Number(input.changed),
      Number(input.changed),
      Number(input.changed),
    )
    .run();
  if (!saved.meta.changes) throw Error("INSTRUCTIONS_CHANGED");
  return { ready: true };
}
const writeSchema = z.object({
  requestId: idSchema,
  expectedVersion: z.number().int().positive(),
  expectedTaskVersion: z.number().int().positive(),
  enabled: z.boolean(),
  frequency: frequencySchema.optional(),
});
export const scheduleRoutes = new Hono<{ Bindings: AppEnv; Variables: Variables }>()
  .get("/:id/schedule", async (c) =>
    c.json({
      card: await scheduleCard(c.env, c.req.param("id")),
      learning:
        c.req.query("learning") === "1"
          ? await listLearning(c.env, c.req.param("id"), c.req.query("learningBefore"))
          : [],
    }),
  )
  .post("/:id/schedule/preview", async (c) =>
    c.json({ times: previewSchedule(frequencySchema.parse(await c.req.json())) }),
  )
  .post("/:id/schedule", async (c) => {
    const taskId = c.req.param("id"),
      b = writeSchema.parse(await c.req.json()),
      digest = await hash(JSON.stringify(b));
    const prior = await c.env.DB.prepare(
      "SELECT digest FROM schedule_requests WHERE task_id=? AND request_id=?",
    )
      .bind(taskId, b.requestId)
      .first<{ digest: string }>();
    if (prior) {
      if (prior.digest !== digest) throw Error("IDEMPOTENCY_CONFLICT");
      return c.json({ card: await scheduleCard(c.env, taskId) });
    }
    const row = await c.env.DB.prepare("SELECT * FROM task_schedules WHERE task_id=?")
      .bind(taskId)
      .first<Row>();
    if (!row) throw Error("SCHEDULE_NOT_READY");
    const schedule = b.frequency
      ? frequencySchedule(b.frequency)
      : row.schedule
        ? (JSON.parse(row.schedule) as TaskInput["schedule"])
        : null;
    if (b.enabled && (!row.ready || !schedule || schedule.kind === "manual"))
      throw Error("SCHEDULE_NOT_READY");
    const next = b.enabled && schedule ? nextOccurrence(schedule) : null;
    if (b.enabled && !next) throw Error("SCHEDULE_TIME_PAST");
    const [saved] = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE task_schedules SET state=?,frequency=?,schedule=?,legacy=?,next_run_at=?,version=version+1 WHERE task_id=? AND version=? AND task_version=?
       AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=task_id AND t.version=task_version AND t.context_withdrawn=0 AND t.deleted=0)
       AND (?=0 OR (ready=1 AND NOT EXISTS(SELECT 1 FROM ai_threads h WHERE h.id=task_schedules.thread_id AND h.closed=0 AND (h.active_turn IS NOT NULL OR EXISTS(SELECT 1 FROM conversation_inbox i WHERE i.thread_id=h.id AND i.status IN ('pending','processing')) OR ((SELECT COALESCE(MAX(seq),0) FROM ai_messages WHERE thread_id=h.id AND role='user')>confirmed_seq)))))`,
      ).bind(
        b.enabled ? "enabled" : "paused",
        b.frequency ? JSON.stringify(b.frequency) : row.frequency,
        schedule ? JSON.stringify(schedule) : null,
        b.frequency ? 0 : row.legacy,
        dbTime(next),
        taskId,
        b.expectedVersion,
        b.expectedTaskVersion,
        Number(b.enabled),
      ),
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO schedule_requests(task_id,request_id,digest,version) SELECT task_id,?,?,version FROM task_schedules WHERE task_id=? AND version=? AND changes()=1",
      ).bind(b.requestId, digest, taskId, b.expectedVersion + 1),
    ]);
    if (!saved.meta.changes) {
      const duplicate = await c.env.DB.prepare(
        "SELECT digest FROM schedule_requests WHERE task_id=? AND request_id=?",
      )
        .bind(taskId, b.requestId)
        .first<{ digest: string }>();
      if (duplicate?.digest !== digest) throw Error("SCHEDULE_VERSION_CONFLICT");
    }
    return c.json({ card: await scheduleCard(c.env, taskId) });
  });

export async function tickSchedules(env: AppEnv) {
  if (
    (
      await env.DB.prepare("SELECT value FROM settings WHERE key='maintenance'").first<{
        value: string;
      }>()
    )?.value === "1"
  )
    return;
  const at = now();
  const rows = await env.DB.prepare(
    `SELECT s.task_id,s.version schedule_version,s.schedule,s.next_run_at,h.id thread_id,h.user_id FROM task_schedules s JOIN tasks t ON t.id=s.task_id JOIN ai_threads h ON h.id=s.thread_id AND h.closed=0
    WHERE s.state='enabled' AND s.ready=1 AND s.task_version=t.version AND t.context_withdrawn=0 AND t.deleted=0 AND s.next_run_at<=?
    AND h.active_turn IS NULL AND NOT EXISTS(SELECT 1 FROM conversation_inbox i WHERE i.thread_id=h.id AND i.status IN ('pending','processing'))
    AND ((SELECT COALESCE(MAX(seq),0) FROM ai_messages WHERE thread_id=h.id AND role='user')<=s.confirmed_seq) LIMIT 100`,
  )
    .bind(dbTime(at))
    .all<Row>();
  for (const row of rows.results) {
    const schedule = JSON.parse(row.schedule) as TaskInput["schedule"],
      slot = latestDue(schedule, new Date(at));
    const busy = await env.DB.prepare(
      `SELECT id FROM runs WHERE task_id=? AND (status IN ('queued','running','waiting_user','verifying','unknown') OR cleanup_pending=1)
      UNION ALL SELECT id FROM account_dispatch_groups WHERE task_id=? AND state IN ('active','paused')`,
    )
      .bind(row.task_id, row.task_id)
      .first();
    if (slot && Date.parse(at) - Date.parse(slot) < 3600000 && !busy) {
      const raw = await env.DB.prepare("SELECT * FROM task_details WHERE id=?")
        .bind(row.task_id)
        .first<Row>();
      if (raw) {
        const task = taskFrom(raw),
          key = `schedule:${task.id}:${row.schedule_version}:${slot}`;
        const snapshotId = `schedule_${(await hash(key)).slice(0, 40)}`;
        await capturePreferences(env, row.user_id, row.thread_id, snapshotId);
        try {
          await enqueueTaskDispatch(
            env.DB,
            {
              ...task,
              requiresScheduling: true,
              preferenceSnapshotId: snapshotId,
              learningIds: await learningSnapshot(env.DB, task),
              scheduleTrigger: { version: row.schedule_version, slot },
            },
            key,
          );
        } catch (error) {
          if (
            /MODEL_DISABLED|ACCOUNT_DISABLED|ACCOUNT_ORIGIN_MISMATCH/.test((error as Error).message)
          ) {
            await env.DB.prepare(
              "UPDATE task_schedules SET state='paused',next_run_at=NULL,version=version+1 WHERE task_id=? AND version=?",
            )
              .bind(task.id, row.schedule_version)
              .run();
            continue;
          }
          if (
            !/RUN_ALREADY_ACTIVE|COMMAND_RETIRED|QUEUE_LIMIT|USER_DISABLED|TASK_CONTEXT_OR_VERSION_CHANGED/.test(
              (error as Error).message,
            )
          )
            throw error;
        }
      }
    }
    await env.DB.prepare(
      "UPDATE task_schedules SET next_run_at=? WHERE task_id=? AND version=? AND next_run_at=? AND state='enabled'",
    )
      .bind(
        dbTime(nextOccurrence(schedule, new Date(at))),
        row.task_id,
        row.schedule_version,
        dbTime(row.next_run_at),
      )
      .run();
  }
}

/** 普通咨询只推进消息水位；新要求先失效确认，等待执行器重新理解。 */
export async function resolveScheduleIntent(
  env: AppEnv,
  taskId: string,
  threadId: string,
  changed: boolean,
) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(MAX(seq),0) seq FROM ai_messages WHERE thread_id=? AND role='user'",
  )
    .bind(threadId)
    .first<{ seq: number }>();
  await env.DB.prepare(
    `UPDATE task_schedules SET confirmed_seq=?,ready=CASE WHEN ?=1 THEN 0 ELSE ready END,
    state=CASE WHEN ?=1 THEN 'paused' ELSE state END,next_run_at=CASE WHEN ?=1 THEN NULL ELSE next_run_at END,
    requirement_revision=requirement_revision+?,version=version+? WHERE task_id=? AND thread_id=? AND confirmed_seq<?`,
  )
    .bind(
      row!.seq,
      Number(changed),
      Number(changed),
      Number(changed),
      Number(changed),
      Number(changed),
      taskId,
      threadId,
      row!.seq,
    )
    .run();
}
