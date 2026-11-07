import { pageQuery, pageKey, pageCursor } from "./pagination";
import { dbTime } from "./database";
/** 用户工作空间接口：先核对资源归属，再读取任务/运行/图片或提交账号与控制请求；管理员配置单独挂载。 */
import { validator } from "hono/validator";
import { conditionsSchema } from "./ai/commands";
import { getEvidence } from "./evidence";
import { Buffer } from "node:buffer";
import { quotaSummary } from "./tenancy";
import { Hono } from "hono";
import { z } from "zod";
import { egress } from "./egress";
import {
  scheduleSchema,
  modelInputSchema,
  idSchema,
  type TaskDefinition,
} from "../../../packages/contracts/src/index";
import { hash } from "../../../packages/contracts/src/security";
import { nextOccurrence } from "../../../packages/contracts/src/schedule";
import type { AppEnv, Variables } from "./env";
import { now, taskFrom, runFrom, getRun, tick, queueReasons, type Row } from "./store";
import { modelFrom, getModel, storeModel, probe, probeVision, validateEndpoint } from "./models";
import { seal, unseal } from "./crypto";
import { accountMatchesDomain, accountSummary, accountRoutes } from "./accounts";
import { accountCardRoutes } from "./account-cards";
import { cancelDispatchGroup, enqueueTaskDispatch } from "./account-dispatch";
const userBase = new Hono<{ Bindings: AppEnv; Variables: Variables }>();
const adminBase = new Hono<{ Bindings: AppEnv; Variables: Variables }>();
userBase.use("*", async (c, next) => {
  const path = c.req.path.replace("/api/user", "");
  const match = /^\/(tasks|runs|artifacts)\/([^/]+)/.exec(path);
  if (match && !(match[1] === "tasks" && ["compose", "draft"].includes(match[2]))) {
    const id = decodeURIComponent(match[2]);
    const queries: Record<string, string> = {
      tasks: "SELECT id FROM tasks WHERE id=? AND user_id=? AND deleted=0",
      runs: "SELECT id FROM runs WHERE id=? AND user_id=? AND history_deleted=0",
      artifacts:
        "SELECT a.id FROM artifacts a JOIN runs r ON r.id=a.run_id WHERE a.id=? AND r.user_id=? AND r.history_deleted=0",
    };
    if (!(await c.env.DB.prepare(queries[match[1]]).bind(id, c.get("userId")).first()))
      return c.json({ error: "RESOURCE_NOT_FOUND" }, 404);
  }

  return next();
});

const taskConditionsInput = z
  .object({
    requestId: idSchema,
    runId: idSchema,
    expectedVersion: z.number().int(),
    conditions: conditionsSchema,
    schedule: scheduleSchema,
    modelId: idSchema,
    accountId: idSchema.nullable(),
  })
  .strict();
const taskStateInput = z.object({ enabled: z.boolean() });
const runRequestInput = z.object({ requestId: idSchema });
const retentionInput = z.object({ retentionDays: z.number().int().min(1).max(365) });
export const user = userBase
  .get("/me", async (c) =>
    c.json({
      id: c.get("userId"),
      email: c.get("member").email,
      role: c.get("member").role,
      quota: await quotaSummary(c.env.DB, c.get("userId"), c.get("member")),
    }),
  )
  .get("/snapshot", async (c) => {
    if (c.env.DEV_MODE === "1" && ["localhost", "127.0.0.1"].includes(new URL(c.req.url).hostname))
      await tick(c.env.DB);
    const db = c.env.DB;
    const results = await db.batch([
      db
        .prepare(
          "SELECT * FROM task_details WHERE user_id=? AND deleted=0 ORDER BY created_at DESC,id DESC LIMIT 51",
        )
        .bind(c.get("userId")),
      db
        .prepare(
          `SELECT r.*,g.state dispatch_group_state,a.name account_name,
      g.member_count dispatch_total
      FROM run_details r LEFT JOIN account_dispatch_groups g ON g.id=r.dispatch_group_id LEFT JOIN accounts a ON a.id=r.account_id
      WHERE r.user_id=? AND r.history_deleted=0 ORDER BY r.created_at DESC,r.id DESC LIMIT 51`,
        )
        .bind(c.get("userId")),
      db.prepare(
        "SELECT v.id,v.version,v.config,v.capabilities FROM models m JOIN model_profile_versions v ON v.id=m.id AND v.version=m.current_version ORDER BY m.created_at DESC",
      ),
      db
        .prepare(
          `SELECT a.id,a.name,a.origin,a.username_hint,a.created_at,a.assigned_device_id,a.login_reset,a.business_domains,
        a.credential_version,a.state_epoch,a.credential_status,a.state_revision,a.sync_status,a.sync_error,a.last_device_id,v.login_origins
        FROM accounts a JOIN account_credential_versions v ON v.account_id=a.id AND v.version=a.credential_version WHERE a.user_id=?`,
        )
        .bind(c.get("userId")),
      db.prepare("SELECT id,name,last_seen,revoked,protocol_version FROM devices"),
      db
        .prepare(
          "SELECT h.id,h.run_id AS runId,r.task_id AS taskId FROM execution_help h JOIN runs r ON r.id=h.run_id JOIN ai_threads t ON t.id=h.thread_id AND t.id=r.thread_id AND t.user_id=r.user_id WHERE r.user_id=? AND t.closed=0 AND h.awaiting_user=1 AND h.reply_message_id IS NULL AND r.status IN ('running','waiting_user') ORDER BY h.created_at",
        )
        .bind(c.get("userId")),
    ]);
    const r = results.map((x) => x.results as Row[]);
    const reasons = await queueReasons(db, c.get("userId"));
    return c.json({
      tasks: r[0].slice(0, 50).map(taskFrom),
      nextTasksCursor: r[0].length > 50 ? pageCursor(r[0][49].created_at, r[0][49].id) : null,
      nextRunsCursor: r[1].length > 50 ? pageCursor(r[1][49].created_at, r[1][49].id) : null,
      runs: r[1].slice(0, 50).map((row) => runFrom({ ...row, queue_reason: reasons.get(row.id) })),
      models: r[2]
        .map(modelFrom)
        .map((m) => (c.get("actor") === "owner" ? m : { ...m, baseUrl: "", hasKey: false })),
      me: { id: c.get("userId"), role: c.get("member").role, email: c.get("member").email },
      quota: await quotaSummary(db, c.get("userId"), c.get("member")),
      accounts: r[3].map(accountSummary),
      devices: (c.get("actor") === "owner" ? r[4] : []).map((x) => ({
        id: x.id,
        name: x.name,
        lastSeen: x.last_seen,
        revoked: !!x.revoked,
        protocolVersion: x.protocol_version,
      })),
      challenges: [],
      waitingHelp: r[5].map((row) => ({
        id: String(row.id),
        runId: String(row.runId),
        taskId: String(row.taskId),
      })),
      serverTime: now(),
    });
  })
  .get(
    "/tasks",
    validator("query", (value) => pageQuery.parse(value)),
    async (c) => {
      const before = pageKey(c.req.valid("query").before);
      const rows = await c.env.DB.prepare(
        `SELECT * FROM task_details WHERE user_id=? AND deleted=0 ${before ? "AND (created_at,id)<(?,?)" : ""} ORDER BY created_at DESC,id DESC LIMIT 51`,
      )
        .bind(c.get("userId"), ...(before ?? []))
        .all<Row>();
      return c.json({
        items: rows.results.slice(0, 50).map(taskFrom),
        nextCursor:
          rows.results.length > 50
            ? pageCursor(rows.results[49].created_at, rows.results[49].id)
            : null,
      });
    },
  )
  .get("/tasks/:id", async (c) => {
    const row = await c.env.DB.prepare(
      "SELECT * FROM task_details WHERE id=? AND user_id=? AND deleted=0",
    )
      .bind(c.req.param("id"), c.get("userId"))
      .first<Row>();
    if (!row) throw Error("TASK_NOT_FOUND");
    return c.json(taskFrom(row));
  })
  .get(
    "/runs",
    validator("query", (value) => pageQuery.parse(value)),
    async (c) => {
      const before = pageKey(c.req.valid("query").before);
      const rows = await c.env.DB.prepare(
        `SELECT * FROM run_details WHERE user_id=? AND history_deleted=0 ${before ? "AND (created_at,id)<(?,?)" : ""} ORDER BY created_at DESC,id DESC LIMIT 51`,
      )
        .bind(c.get("userId"), ...(before ?? []))
        .all<Row>();
      return c.json({
        items: rows.results.slice(0, 50).map(runFrom),
        nextCursor:
          rows.results.length > 50
            ? pageCursor(rows.results[49].created_at, rows.results[49].id)
            : null,
      });
    },
  )
  .route("/", accountRoutes)
  .route("/", accountCardRoutes)
  .post(
    "/tasks/:id/conditions",
    validator("json", (value: z.input<typeof taskConditionsInput>) =>
      taskConditionsInput.parse(value),
    ),
    async (c) => {
      const b = c.req.valid("json");
      const id = c.req.param("id"),
        key = "conditions:" + id + ":" + b.requestId,
        digest = await hash(JSON.stringify(b));
      const prior = await c.env.DB.prepare("SELECT digest FROM idempotency WHERE key=?")
        .bind(key)
        .first<{ digest: string }>();
      if (prior) {
        if (prior.digest !== digest) throw Error("IDEMPOTENCY_CONFLICT");
        return c.json({ id });
      }
      const row = await c.env.DB.prepare("SELECT * FROM task_details WHERE id=? AND user_id=?")
        .bind(id, c.get("userId"))
        .first<Row>();
      if (!row || row.version !== b.expectedVersion) throw Error("TASK_VERSION_CONFLICT");
      if (row.context_withdrawn) throw Error("TASK_CONTEXT_WITHDRAWN");
      const card = await c.env.DB.prepare(
        "SELECT c.* FROM run_conditions c JOIN run_details r ON r.id=c.run_id WHERE c.run_id=? AND c.task_id=? AND r.status='succeeded'",
      )
        .bind(b.runId, id)
        .first<Row>();
      if (!card) throw Error("CONDITIONS_NOT_READY");
      // An older successful card must never authorize a new, unverified task revision.
      if (card.task_version !== row.version && card.approved_version !== row.version)
        throw Error("CONDITIONS_STALE");
      if (
        await c.env.DB.prepare(
          "SELECT id FROM runs WHERE task_id=? AND status IN ('queued','running','waiting_user','verifying','unknown')",
        )
          .bind(id)
          .first()
      )
        throw Error("RUN_ALREADY_ACTIVE");
      if (
        await c.env.DB.prepare(
          "SELECT id FROM ai_threads WHERE task_id=? AND active_turn IS NOT NULL AND closed=0",
        )
          .bind(id)
          .first()
      )
        throw Error("CONVERSATION_BUSY");
      const base = taskFrom(row),
        model = await getModel(c.env, b.modelId);
      if (
        !model.profile.capabilities.connection ||
        !model.profile.capabilities.tools ||
        model.profile.capabilities.structured === "none"
      )
        throw Error("MODEL_CAPABILITIES_REQUIRED");
      if (b.accountId) {
        const a = await c.env.DB.prepare("SELECT * FROM account_details WHERE id=? AND user_id=?")
          .bind(b.accountId, c.get("userId"))
          .first<Row>();
        if (!a || !accountMatchesDomain(a, base.entryUrl)) throw Error("ACCOUNT_ORIGIN_MISMATCH");
      }
      const task: TaskDefinition = {
        ...base,
        goal: b.conditions.goal,
        verification:
          base.verification.kind === "batch"
            ? { ...base.verification, value: b.conditions.completion, scope: b.conditions.scope }
            : { kind: "goal", value: b.conditions.completion },
        schedule: b.schedule,
        modelId: b.modelId,
        modelVersion: model.profile.version,
        accountId: b.accountId,
        accountIds: b.accountId ? [b.accountId] : [],
        version: base.version + 1,
        status: "active",
        nextRunAt: nextOccurrence(b.schedule),
        confirmedCondition: b.runId,
      };
      const writes = await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT OR IGNORE INTO idempotency(key,digest,resource_id) SELECT ?,?,id FROM tasks WHERE id=? AND version=? AND context_withdrawn=0 AND NOT EXISTS(SELECT 1 FROM ai_threads WHERE task_id=tasks.id AND active_turn IS NOT NULL AND closed=0)",
        ).bind(key, digest, id, b.expectedVersion),
        c.env.DB.prepare(
          "UPDATE tasks SET version=?,title=?,schedule_kind=?,status=?,next_run_at=?,confirmed_condition=?,updated_at=? WHERE id=? AND version=? AND context_withdrawn=0 AND EXISTS(SELECT 1 FROM idempotency WHERE key=? AND digest=?)",
        ).bind(
          task.version,
          task.title,
          task.schedule.kind,
          task.status,
          dbTime(task.nextRunAt),
          b.runId,
          dbTime(now()),
          id,
          b.expectedVersion,
          key,
          digest,
        ),
        c.env.DB.prepare(
          "INSERT OR IGNORE INTO task_versions(task_id,version,definition,user_id,model_id,model_version) SELECT id,version,?,user_id,?,? FROM tasks WHERE id=? AND version=?",
        ).bind(JSON.stringify(task), task.modelId, task.modelVersion, id, task.version),
        c.env.DB.prepare(
          "UPDATE run_conditions SET confirmed_at=?,approved_version=?,confirmed_content=? WHERE run_id=? AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND version=? AND confirmed_condition=?)",
        ).bind(
          dbTime(now()),
          task.version,
          JSON.stringify(b.conditions),
          b.runId,
          id,
          task.version,
          b.runId,
        ),
        c.env.DB.prepare(
          "UPDATE ai_threads SET model_id=?,model_version=? WHERE task_id=? AND closed=0 AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND version=? AND confirmed_condition=?)",
        ).bind(task.modelId, task.modelVersion, id, id, task.version, b.runId),
      ]);
      if (!writes[1].meta.changes) throw Error("TASK_VERSION_CONFLICT");
      return c.json({ id, version: task.version });
    },
  )
  .post(
    "/tasks/:id/state",
    validator("json", (value: z.input<typeof taskStateInput>) => taskStateInput.parse(value)),
    async (c) => {
      const { enabled } = c.req.valid("json"),
        id = c.req.param("id");
      const row = await c.env.DB.prepare("SELECT * FROM task_details WHERE id=?")
        .bind(id)
        .first<Row>();
      if (!row) throw new Error("TASK_NOT_FOUND");
      const task = taskFrom(row);
      if (enabled) {
        if (row.context_withdrawn) throw Error("TASK_CONTEXT_WITHDRAWN");
        if (!row.confirmed_condition) throw Error("CONDITIONS_CONFIRMATION_REQUIRED");
      }
      const saved = await c.env.DB.prepare(
        "UPDATE tasks SET status=?,next_run_at=?,updated_at=? WHERE id=? AND deleted=0 AND (?=0 OR context_withdrawn=0)",
      )
        .bind(
          enabled ? "active" : "paused",
          dbTime(enabled ? nextOccurrence(task.schedule) : null),
          dbTime(now()),
          id,
          Number(enabled),
        )
        .run();
      if (!saved.meta.changes) throw Error("TASK_CONTEXT_WITHDRAWN");
      return c.json({ ok: true });
    },
  )
  .post(
    "/tasks/:id/run",
    validator("json", (value: z.input<typeof runRequestInput>) => runRequestInput.parse(value)),
    async (c) => {
      const { requestId } = c.req.valid("json");
      const row = await c.env.DB.prepare("SELECT * FROM task_details WHERE id=?")
        .bind(c.req.param("id"))
        .first<Row>();
      if (!row) throw new Error("TASK_NOT_FOUND");
      if (row.context_withdrawn) throw Error("TASK_CONTEXT_WITHDRAWN");
      const task = taskFrom(row);
      const model = await getModel(c.env, task.modelId, task.modelVersion);
      if (!model.profile.capabilities.tools || model.profile.capabilities.structured === "none")
        throw new Error("MODEL_CAPABILITIES_REQUIRED");
      // A manual invocation does not enable periodic scheduling. It is eligible even if paused.
      return c.json(await enqueueTaskDispatch(c.env.DB, task, `manual:${task.id}:${requestId}`));
    },
  )
  .get(
    "/runs/:id",
    validator("query", (value) => pageQuery.parse(value)),
    async (c) => {
      const before = pageKey(c.req.valid("query").before);
      const run = await getRun(c.env.DB, c.req.param("id"));
      if (run.status === "queued")
        run.queueReason = (await queueReasons(c.env.DB, c.get("userId"))).get(run.id);
      const [usage] = await c.env.DB.batch([
        c.env.DB.prepare(
          `SELECT u.id,u.at,u.input_tokens,u.output_tokens,p.config FROM model_usage u JOIN model_profile_versions p ON p.id=u.model_id AND p.version=u.model_version WHERE run_id=? ${before ? "AND (u.at,u.id)<(?,?)" : ""} ORDER BY u.at DESC,u.id DESC LIMIT 51`,
        ).bind(run.id, ...(before ?? [])),
      ]);
      return c.json({
        run,
        events: [],
        nextUsageCursor:
          usage.results.length > 50
            ? pageCursor((usage.results[49] as Row).at, (usage.results[49] as Row).id)
            : null,
        usage: (usage.results.slice(0, 50) as Row[]).map((r: Row) => {
          const p = JSON.parse(r.config);
          return {
            input: r.input_tokens,
            output: r.output_tokens,
            cost:
              r.input_tokens === null ||
              r.output_tokens === null ||
              p.inputPrice === null ||
              p.outputPrice === null
                ? null
                : (r.input_tokens * p.inputPrice + r.output_tokens * p.outputPrice) / 1000000,
          };
        }),
      });
    },
  )
  .post("/runs/:id/cancel", async (c) => {
    const id = c.req.param("id");
    await cancelDispatchGroup(c.env.DB, id);
    await c.env.DB.prepare(
      "UPDATE runs SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=? WHERE id=? AND status IN ('queued','running','waiting_user','verifying')",
    )
      .bind(dbTime(now()), id)
      .run();
    return c.json({ ok: true });
  })
  .get(
    "/artifacts/:id",
    validator("query", (value: { format?: string | string[]; variant?: string | string[] }) =>
      z
        .object({
          format: z.literal("data").optional(),
          variant: z.enum(["original", "thumbnail"]).optional(),
        })
        .parse(value),
    ),
    async (c) => {
      const row = await c.env.DB.prepare(
        "SELECT * FROM artifacts WHERE id=? AND expires_at>? AND purpose='chat'",
      )
        .bind(c.req.param("id"), dbTime(now()))
        .first<Row>();
      if (!row) return c.json({ error: "ARTIFACT_EXPIRED" }, 404);
      const object = await getEvidence(
        c.env,
        row.object_key,
        c.req.valid("query").variant === "thumbnail",
      );
      if (!object) return c.json({ error: "ARTIFACT_EXPIRED" }, 404);
      if (c.req.valid("query").format === "data") {
        const bytes = Buffer.from(object);
        return c.json({
          dataUrl: `data:${row.content_type};base64,${bytes.toString("base64")}`,
        });
      }
      return new Response(object, {
        headers: {
          "Content-Type": row.content_type,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  );
export const admin = adminBase
  .post(
    "/models",
    validator("json", (value: z.input<typeof modelInputSchema>) => modelInputSchema.parse(value)),
    async (c) => c.json(await storeModel(c.env, c.req.valid("json")), 201),
  )
  .put(
    "/models/:id",
    validator("json", (value: z.input<typeof modelInputSchema>) => modelInputSchema.parse(value)),
    async (c) =>
      c.json(await storeModel(c.env, c.req.valid("json"), idSchema.parse(c.req.param("id")))),
  )
  .post("/models/:id/test", async (c) => {
    const { profile } = await getModel(c.env, c.req.param("id"));
    return c.json(await probe(c.env, profile.id, profile.version));
  })
  .post("/models/:id/vision", async (c) => c.json(await probeVision(c.env, c.req.param("id"))))
  .post("/devices/:id/revoke", async (c) => {
    await c.env.DB.prepare("UPDATE devices SET revoked=1 WHERE id=?").bind(c.req.param("id")).run();
    return c.json({ ok: true });
  })
  .get("/pairings/:code", async (c) => {
    if (c.get("actor") !== "owner") return c.json({ error: "OWNER_REQUIRED" }, 403);
    const r = await c.env.DB.prepare(
      "SELECT name,code,expires_at,approved FROM pairings WHERE code=? AND expires_at>?",
    )
      .bind(c.req.param("code"), dbTime(now()))
      .first<{ name: string; code: string; expires_at: string; approved: number }>();
    if (!r) throw new Error("PAIRING_EXPIRED");
    return c.json({ name: r.name, code: r.code, expiresAt: r.expires_at, approved: !!r.approved });
  })
  .post("/pairings/:code/approve", async (c) => {
    if (c.get("actor") !== "owner") return c.json({ error: "OWNER_REQUIRED" }, 403);
    const r = await c.env.DB.prepare("SELECT * FROM pairings WHERE code=? AND expires_at>?")
      .bind(c.req.param("code"), dbTime(now()))
      .first<Row>();
    if (!r) throw new Error("PAIRING_EXPIRED");
    const token = await unseal<string>(r.token_secret, c.env.MASTER_KEY, `pair:${r.id}`);
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO devices(id,name,token_hash,protocol_version) VALUES(?,?,?,2)",
      ).bind(r.device_id, r.name, await hash(token)),
      c.env.DB.prepare("UPDATE pairings SET approved=1 WHERE id=?").bind(r.id),
    ]);
    return c.json({ ok: true });
  })
  .get("/settings", async (c) =>
    c.json({
      retentionDays: Number(
        (
          await c.env.DB.prepare("SELECT value FROM settings WHERE key='retentionDays'").first<{
            value: string;
          }>()
        )?.value ?? 30,
      ),
    }),
  )
  .get("/settings/check", async (c) => {
    const checks: Record<string, string> = {};
    for (const [name, check] of Object.entries({
      database: () => c.env.DB.prepare("SELECT 1 AS ok").first(),
      encryption: () => seal("self-check", c.env.MASTER_KEY, "self-check"),
      modelDns: () => validateEndpoint("https://api.openai.com/v1"),
    })) {
      try {
        await check();
        checks[name] = "ok";
      } catch (error) {
        const e = error as Error;
        checks[name] = /^[A-Z][A-Z0-9_]+$/.test(e.message) ? e.message : e.name;
      }
    }
    // Explicit diagnostic only. No key, client headers, IP address or full trace is retained.
    if (c.req.query("egress") === "1") {
      try {
        const response = await fetch("https://api.openai.com/cdn-cgi/trace", {
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        checks.openaiTraceStatus = String(response.status);
        if (response.ok) {
          const trace = await response.text();
          for (const field of ["loc", "colo"] as const) {
            const value = new RegExp(`^${field}=([A-Z0-9-]{2,10})$`, "m").exec(trace)?.[1];
            if (value) checks[`openaiTrace_${field}`] = value;
          }
        }
      } catch {
        checks.openaiTraceStatus = "UNAVAILABLE";
      }
      try {
        const result = await egress<Record<string, string>>(c.env, {
          kind: "trace",
        });
        for (const [key, value] of Object.entries(result)) checks[`workerEgress_${key}`] = value;
      } catch (error) {
        const message = (error as Error).message;
        checks.workerEgress_status = /^[A-Z][A-Z0-9_]+$/.test(message) ? message : "UNAVAILABLE";
      }
    }
    return c.json(checks);
  })
  .put(
    "/settings",
    validator("json", (value: z.input<typeof retentionInput>) => retentionInput.parse(value)),
    async (c) => {
      const { retentionDays } = c.req.valid("json");
      await c.env.DB.prepare("UPDATE settings SET value=? WHERE key='retentionDays'")
        .bind(String(retentionDays))
        .run();
      return c.json({ ok: true });
    },
  );
