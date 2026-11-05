/** 用户工作空间接口：先核对资源归属，再读取任务/运行/图片或提交账号与控制请求；管理员配置单独挂载。 */
import { conditionsSchema } from './ai/commands';
import {getEvidence} from './evidence';
import {Buffer} from 'node:buffer';
import { quotaSummary } from './tenancy';
import { Hono } from "hono";
import { z } from "zod";
import { egress } from "./egress";
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq } from "drizzle-orm";
import {
  scheduleSchema,
  idSchema,
  type TaskDefinition,
} from "../../../packages/contracts/src/index";
import { publicUrl, hash } from "../../../packages/contracts/src/security";
import { nextOccurrence } from "../../../packages/contracts/src/schedule";
import type { AppEnv, Variables } from "./env";
import { tasksTable } from "./schema";
import {
  now,
  uid,
  taskFrom,
  runFrom,
  getRun,
  enqueue,
  tick,
  queueReasons,
  type Row,
} from "./store";
import {
  modelFrom,
  getModel,
  storeModel,
  probe,
  probeVision,
  validateEndpoint,
} from "./models";
import { seal, unseal } from "./crypto";
export const user = new Hono<{ Bindings: AppEnv; Variables: Variables }>();
export const admin = new Hono<{ Bindings: AppEnv; Variables: Variables }>();
user.use('*', async (c,next) => {
 const path=c.req.path.replace('/api/user','');
 const match=/^\/(tasks|runs|challenges|artifacts)\/([^/]+)/.exec(path);
 if(match && !(match[1]==='tasks' && ['compose','draft'].includes(match[2]))) {
  const id=decodeURIComponent(match[2]);
  const queries:Record<string,string>={
   tasks:'SELECT id FROM tasks WHERE id=? AND user_id=? AND deleted=0',
   runs:'SELECT id FROM runs WHERE id=? AND user_id=? AND history_deleted=0',
   challenges:'SELECT c.id FROM challenges c JOIN runs r ON r.id=c.run_id WHERE c.id=? AND r.user_id=? AND r.history_deleted=0',
   artifacts:'SELECT a.id FROM artifacts a JOIN runs r ON r.id=a.run_id WHERE a.id=? AND r.user_id=? AND r.history_deleted=0',
  };
  if(!await c.env.DB.prepare(queries[match[1]]).bind(id,c.get('userId')).first()) return c.json({error:'RESOURCE_NOT_FOUND'},404);
 }

 return next();
});
user.get('/me', async c=>c.json({id:c.get('userId'),email:c.get('member').email,role:c.get('member').role,quota:await quotaSummary(c.env.DB,c.get('userId'),c.get('member'))}));
user.get("/snapshot", async (c) => {
  if (
    c.env.DEV_MODE === "1" &&
    ["localhost", "127.0.0.1"].includes(new URL(c.req.url).hostname)
  )
    await tick(c.env.DB);
  const db = c.env.DB;
  const results = await db.batch([
    db.prepare("SELECT * FROM tasks WHERE user_id=? AND deleted=0 ORDER BY created_at DESC LIMIT 200").bind(c.get("userId")),
    db.prepare("SELECT * FROM runs WHERE user_id=? AND history_deleted=0 ORDER BY created_at DESC LIMIT 200").bind(c.get("userId")),
    db.prepare(
      "SELECT m.id,m.version,m.config,m.capabilities FROM model_profiles m WHERE version=(SELECT MAX(version) FROM model_profiles x WHERE x.id=m.id) ORDER BY created_at DESC",
    ),
    db.prepare("SELECT id,name,origin,username_hint,created_at,assigned_device_id,login_reset FROM accounts WHERE user_id=?").bind(c.get("userId")),
    db.prepare(
      "SELECT id,name,last_seen,revoked,protocol_version FROM devices",
    ),
    db
      .prepare(
        "SELECT h.id,h.run_id AS runId,r.task_id AS taskId FROM execution_help h JOIN runs r ON r.id=h.run_id JOIN ai_threads t ON t.id=h.thread_id AND t.id=r.thread_id AND t.user_id=r.user_id WHERE r.user_id=? AND t.closed=0 AND h.awaiting_user=1 AND h.reply_message_id IS NULL AND r.status IN ('running','waiting_user') ORDER BY h.created_at",
      )
      .bind(c.get("userId")),
  ]);
  const r = results.map((x) => x.results as Row[]);
  const reasons=await queueReasons(db,c.get('userId'));
  return c.json({
    tasks: r[0].map(taskFrom),
    runs: r[1].map(row=>runFrom({...row,queue_reason:reasons.get(row.id)})),
    models: r[2].map(modelFrom).map(m=>c.get("actor")==="owner"?m:{...m,baseUrl:"",hasKey:false}),
    me: {id:c.get("userId"),role:c.get("member").role,email:c.get("member").email},
    quota: await quotaSummary(db,c.get("userId"),c.get("member")),
    accounts: r[3].map((x) => ({
      id: x.id,
      name: x.name,
      origin: x.origin,
      usernameHint: x.username_hint,
      assignedDeviceId:x.assigned_device_id,loginReset:!!x.login_reset,
      createdAt: x.created_at,
    })),
    devices: (c.get("actor")==="owner"?r[4]:[]).map((x) => ({
      id: x.id,
      name: x.name,
      lastSeen: x.last_seen,
      revoked: !!x.revoked,
      protocolVersion: x.protocol_version,
    })),
    challenges: [],
    waitingHelp: r[5],
    serverTime: now(),
  });
});
user.get("/tasks", async (c) =>
  c.json(
    (
      await drizzle(c.env.DB)
        .select()
        .from(tasksTable)
        .where(and(eq(tasksTable.userId,c.get("userId")),eq(tasksTable.deleted,0)))
        .orderBy(desc(tasksTable.createdAt))
    ).map((row) => ({
      ...JSON.parse(row.definition),
      status: row.status,
      nextRunAt: row.nextRunAt,
    })),
  ),
);
admin.post("/models", async (c) =>
  c.json(await storeModel(c.env, await c.req.json()), 201),
);
admin.put("/models/:id", async (c) =>
  c.json(
    await storeModel(
      c.env,
      await c.req.json(),
      idSchema.parse(c.req.param("id")),
    ),
  ),
);
admin.post("/models/:id/test", async (c) => {
  const { profile } = await getModel(c.env, c.req.param("id"));
  return c.json(await probe(c.env, profile.id, profile.version));
});
admin.post("/models/:id/vision", async (c) =>
  c.json(await probeVision(c.env, c.req.param("id"))),
);
user.post("/accounts", async (c) => {
  const body = z
    .object({
      name: z.string().min(1).max(80),
      origin: z.url(),
      username: z.string().max(200),
      password: z.string().max(2000),
    })
    .strict()
    .parse(await c.req.json());
  const origin = publicUrl(body.origin).origin,
    id = uid("account");
  await c.env.DB.prepare(
    "INSERT INTO accounts(id,name,origin,username_hint,secret,created_at,user_id,profile_id) VALUES(?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      body.name,
      origin,
      body.username ? body.username.slice(0, 2) + "***" : "未设置",
      await seal(
        { username: body.username, password: body.password },
        c.env.MASTER_KEY,
        `account:${id}`,
      ),
      now(),c.get("userId"),uid("profile"),
    )
    .run();
  return c.json({ id }, 201);
});
user.post('/tasks/:id/conditions',async c=>{
  const b=z.object({requestId:idSchema,runId:idSchema,expectedVersion:z.number().int(),conditions:conditionsSchema,
    schedule:scheduleSchema,modelId:idSchema,accountId:idSchema.nullable()}).strict().parse(await c.req.json());
  const id=c.req.param('id'),key='conditions:'+id+':'+b.requestId,digest=await hash(JSON.stringify(b));
  const prior=await c.env.DB.prepare('SELECT digest FROM idempotency WHERE key=?').bind(key).first<{digest:string}>();
  if(prior){if(prior.digest!==digest)throw Error('IDEMPOTENCY_CONFLICT');return c.json({id});}
  const row=await c.env.DB.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').bind(id,c.get('userId')).first<Row>();
  if(!row||row.version!==b.expectedVersion)throw Error('TASK_VERSION_CONFLICT');
  if(row.context_withdrawn)throw Error('TASK_CONTEXT_WITHDRAWN');
  const card=await c.env.DB.prepare("SELECT c.* FROM run_conditions c JOIN runs r ON r.id=c.run_id WHERE c.run_id=? AND c.task_id=? AND r.status='succeeded'").bind(b.runId,id).first<Row>();
  if(!card)throw Error('CONDITIONS_NOT_READY');
  // An older successful card must never authorize a new, unverified task revision.
  if(card.task_version!==row.version&&card.approved_version!==row.version)throw Error('CONDITIONS_STALE');
  if(await c.env.DB.prepare("SELECT id FROM runs WHERE task_id=? AND status IN ('queued','running','waiting_user','verifying','unknown')").bind(id).first())throw Error('RUN_ALREADY_ACTIVE');
  if(await c.env.DB.prepare('SELECT id FROM ai_threads WHERE task_id=? AND active_turn IS NOT NULL AND closed=0').bind(id).first())throw Error('CONVERSATION_BUSY');
  const base=taskFrom(row),model=await getModel(c.env,b.modelId);
  if(!model.profile.capabilities.connection||!model.profile.capabilities.tools||model.profile.capabilities.structured==='none')throw Error('MODEL_CAPABILITIES_REQUIRED');
  if(b.accountId){const a=await c.env.DB.prepare('SELECT origin FROM accounts WHERE id=? AND user_id=?').bind(b.accountId,c.get('userId')).first<{origin:string}>();if(!a||a.origin!==new URL(base.entryUrl).origin)throw Error('ACCOUNT_ORIGIN_MISMATCH');}
  const task:TaskDefinition={...base,goal:b.conditions.goal,verification:base.verification.kind==='batch'?{...base.verification,value:b.conditions.completion,scope:b.conditions.scope}:{kind:'goal',value:b.conditions.completion},
    schedule:b.schedule,modelId:b.modelId,modelVersion:model.profile.version,accountId:b.accountId,version:base.version+1,status:'active',nextRunAt:nextOccurrence(b.schedule),confirmedCondition:b.runId};
  const writes=await c.env.DB.batch([
    c.env.DB.prepare('INSERT OR IGNORE INTO idempotency(key,digest,resource_id) SELECT ?,?,id FROM tasks WHERE id=? AND version=? AND context_withdrawn=0 AND NOT EXISTS(SELECT 1 FROM ai_threads WHERE task_id=tasks.id AND active_turn IS NOT NULL AND closed=0)').bind(key,digest,id,b.expectedVersion),
    c.env.DB.prepare('UPDATE tasks SET version=?,definition=?,status=?,next_run_at=?,confirmed_condition=?,updated_at=? WHERE id=? AND version=? AND context_withdrawn=0 AND EXISTS(SELECT 1 FROM idempotency WHERE key=? AND digest=?)')
      .bind(task.version,JSON.stringify(task),task.status,task.nextRunAt,b.runId,now(),id,b.expectedVersion,key,digest),
    c.env.DB.prepare('INSERT OR IGNORE INTO task_versions(task_id,version,definition) SELECT id,version,definition FROM tasks WHERE id=? AND version=?').bind(id,task.version),
    c.env.DB.prepare('UPDATE run_conditions SET confirmed_at=?,approved_version=?,confirmed_content=? WHERE run_id=? AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND version=? AND confirmed_condition=?)')
      .bind(now(),task.version,JSON.stringify(b.conditions),b.runId,id,task.version,b.runId),
    c.env.DB.prepare('UPDATE ai_threads SET model_id=?,model_version=? WHERE task_id=? AND closed=0 AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND version=? AND confirmed_condition=?)')
      .bind(task.modelId,task.modelVersion,id,id,task.version,b.runId),
  ]);
  if(!writes[1].meta.changes)throw Error('TASK_VERSION_CONFLICT');
  return c.json({id,version:task.version});
});
user.post("/tasks/:id/state", async (c) => {
  const { enabled } = z
      .object({ enabled: z.boolean() })
      .parse(await c.req.json()),
    id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT * FROM tasks WHERE id=?")
    .bind(id)
    .first<Row>();
  if (!row) throw new Error("TASK_NOT_FOUND");
  const task = taskFrom(row);
  if (enabled) {
    if(row.context_withdrawn)throw Error('TASK_CONTEXT_WITHDRAWN');
    if(!row.confirmed_condition)throw Error("CONDITIONS_CONFIRMATION_REQUIRED");
  }
  const saved = await c.env.DB.prepare(
    "UPDATE tasks SET status=?,next_run_at=?,updated_at=? WHERE id=? AND deleted=0 AND (?=0 OR context_withdrawn=0)",
  )
    .bind(
      enabled ? "active" : "paused",
      enabled ? nextOccurrence(task.schedule) : null,
      now(),
      id,
      Number(enabled),
    )
    .run();
  if(!saved.meta.changes)throw Error('TASK_CONTEXT_WITHDRAWN');
  return c.json({ ok: true });
});
user.post("/tasks/:id/run", async (c) => {
  const { requestId } = z
    .object({ requestId: idSchema })
    .parse(await c.req.json());
  const row = await c.env.DB.prepare("SELECT * FROM tasks WHERE id=?")
    .bind(c.req.param("id"))
    .first<Row>();
  if (!row) throw new Error("TASK_NOT_FOUND");
  if(row.context_withdrawn)throw Error('TASK_CONTEXT_WITHDRAWN');
  const task = taskFrom(row);
  const model = await getModel(c.env, task.modelId, task.modelVersion);
  if (
    !model.profile.capabilities.tools ||
    model.profile.capabilities.structured === "none"
  )
    throw new Error("MODEL_CAPABILITIES_REQUIRED");
  // A manual invocation does not enable periodic scheduling. It is eligible even if paused.
  return c.json(
    await enqueue(c.env.DB, task, `manual:${task.id}:${requestId}`),
  );
});
user.get("/runs/:id", async (c) => {
  const run = await getRun(c.env.DB, c.req.param("id"));
  if (run.status === 'queued') run.queueReason = (await queueReasons(c.env.DB,c.get('userId'))).get(run.id);
  const [events, usage] = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT id,run_id AS runId,sequence,kind,message,at FROM run_events WHERE run_id=? ORDER BY sequence LIMIT 500",
    ).bind(run.id),
    c.env.DB.prepare(
      "SELECT u.*,p.config FROM model_usage u JOIN model_profiles p ON p.id=u.model_id AND p.version=u.model_version WHERE run_id=?",
    ).bind(run.id),
  ]);
  return c.json({
    run,
    events: events.results,
    usage: (usage.results as Row[]).map((r: Row) => {
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
            : (r.input_tokens * p.inputPrice +
                r.output_tokens * p.outputPrice) /
              1000000,
      };
    }),
  });
});
user.post("/runs/:id/cancel", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare(
    "UPDATE runs SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=? WHERE id=? AND status IN ('queued','running','waiting_user','verifying')",
  )
    .bind(now(), id)
    .run();
  return c.json({ ok: true });
});
admin.post("/devices/:id/revoke", async (c) => {
  await c.env.DB.prepare("UPDATE devices SET revoked=1 WHERE id=?")
    .bind(c.req.param("id"))
    .run();
  return c.json({ ok: true });
});
admin.get("/pairings/:code", async (c) => {
  if (c.get("actor") !== "owner")
    return c.json({ error: "OWNER_REQUIRED" }, 403);
  const r = await c.env.DB.prepare(
    "SELECT name,code,expires_at AS expiresAt,approved FROM pairings WHERE code=? AND expires_at>?",
  )
    .bind(c.req.param("code"), now())
    .first();
  if (!r) throw new Error("PAIRING_EXPIRED");
  return c.json(r);
});
admin.post("/pairings/:code/approve", async (c) => {
  if (c.get("actor") !== "owner")
    return c.json({ error: "OWNER_REQUIRED" }, 403);
  const r = await c.env.DB.prepare(
    "SELECT * FROM pairings WHERE code=? AND expires_at>?",
  )
    .bind(c.req.param("code"), now())
    .first<Row>();
  if (!r) throw new Error("PAIRING_EXPIRED");
  const token = await unseal<string>(
    r.token_secret,
    c.env.MASTER_KEY,
    `pair:${r.id}`,
  );
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO devices(id,name,token_hash,protocol_version) VALUES(?,?,?,2)",
    ).bind(r.device_id, r.name, await hash(token)),
    c.env.DB.prepare("UPDATE pairings SET approved=1 WHERE id=?").bind(r.id),
  ]);
  return c.json({ ok: true });
});
user.get("/artifacts/:id", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT * FROM artifacts WHERE id=? AND expires_at>?",
  )
    .bind(c.req.param("id"), now())
    .first<Row>();
  if (!row) return c.json({ error: "ARTIFACT_EXPIRED" }, 404);
  const object = await getEvidence(c.env,row.object_key);
  if (!object) return c.json({ error: "ARTIFACT_EXPIRED" }, 404);
  if (c.req.query("format") === "data") {
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
});
admin.get("/settings", async (c) =>
  c.json({
    retentionDays: Number(
      (
        await c.env.DB.prepare(
          "SELECT value FROM settings WHERE key='retentionDays'",
        ).first<{ value: string }>()
      )?.value ?? 30,
    ),
  }),
);
admin.get("/settings/check", async (c) => {
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
          const value = new RegExp(`^${field}=([A-Z0-9-]{2,10})$`, "m").exec(
            trace,
          )?.[1];
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
      for (const [key, value] of Object.entries(result))
        checks[`workerEgress_${key}`] = value;
    } catch (error) {
      const message = (error as Error).message;
      checks.workerEgress_status = /^[A-Z][A-Z0-9_]+$/.test(message)
        ? message
        : "UNAVAILABLE";
    }
  }
  return c.json(checks);
});
admin.put("/settings", async (c) => {
  const { retentionDays } = z
    .object({ retentionDays: z.number().int().min(1).max(365) })
    .parse(await c.req.json());
  await c.env.DB.prepare(
    "UPDATE settings SET value=? WHERE key='retentionDays'",
  )
    .bind(String(retentionDays))
    .run();
  return c.json({ ok: true });
});
