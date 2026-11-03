import { Hono } from "hono";
import { z } from "zod";
import { egress } from "./egress";
import { drizzle } from "drizzle-orm/d1";
import { desc } from "drizzle-orm";
import {
  taskInputSchema,
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
  type Row,
} from "./store";
import {
  modelFrom,
  getModel,
  storeModel,
  probe,
  probeVision,
  generate,
  validateEndpoint,
} from "./models";
import { seal, unseal } from "./crypto";
import { challengeFrom, exactReply } from "./challenges";
export const user = new Hono<{ Bindings: AppEnv; Variables: Variables }>();
user.get("/snapshot", async (c) => {
  if (
    c.env.DEV_MODE === "1" &&
    ["localhost", "127.0.0.1"].includes(new URL(c.req.url).hostname)
  )
    await tick(c.env.DB);
  const db = c.env.DB;
  const results = await db.batch([
    db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200"),
    db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT 200"),
    db.prepare(
      "SELECT m.* FROM model_profiles m WHERE version=(SELECT MAX(version) FROM model_profiles x WHERE x.id=m.id) ORDER BY created_at DESC",
    ),
    db.prepare("SELECT id,name,origin,username_hint,created_at FROM accounts"),
    db.prepare(
      "SELECT id,name,last_seen,revoked,protocol_version FROM devices",
    ),
    db
      .prepare(
        "SELECT * FROM challenges WHERE status IN ('pending','answered','consuming') AND expires_at>? ORDER BY expires_at",
      )
      .bind(now()),
  ]);
  const r = results.map((x) => x.results as Row[]);
  return c.json({
    tasks: r[0].map(taskFrom),
    runs: r[1].map(runFrom),
    models: r[2].map(modelFrom),
    accounts: r[3].map((x) => ({
      id: x.id,
      name: x.name,
      origin: x.origin,
      usernameHint: x.username_hint,
      createdAt: x.created_at,
    })),
    devices: r[4].map((x) => ({
      id: x.id,
      name: x.name,
      lastSeen: x.last_seen,
      revoked: !!x.revoked,
      protocolVersion: x.protocol_version,
    })),
    challenges: r[5].map(challengeFrom),
    serverTime: now(),
  });
});
user.get("/tasks", async (c) =>
  c.json(
    (
      await drizzle(c.env.DB)
        .select()
        .from(tasksTable)
        .orderBy(desc(tasksTable.createdAt))
    ).map((row) => ({
      ...JSON.parse(row.definition),
      status: row.status,
      nextRunAt: row.nextRunAt,
    })),
  ),
);
user.post("/models", async (c) =>
  c.json(await storeModel(c.env, await c.req.json()), 201),
);
user.put("/models/:id", async (c) =>
  c.json(
    await storeModel(
      c.env,
      await c.req.json(),
      idSchema.parse(c.req.param("id")),
    ),
  ),
);
user.post("/models/:id/test", async (c) => {
  const { profile } = await getModel(c.env, c.req.param("id"));
  return c.json(await probe(c.env, profile.id, profile.version));
});
user.post("/models/:id/vision", async (c) =>
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
    "INSERT INTO accounts(id,name,origin,username_hint,secret,created_at) VALUES(?,?,?,?,?,?)",
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
      now(),
    )
    .run();
  return c.json({ id }, 201);
});
user.post("/tasks/draft", async (c) => {
  const { goal, modelId } = z
    .object({ goal: z.string().min(1).max(6000), modelId: idSchema })
    .parse(await c.req.json());
  const { profile } = await getModel(c.env, modelId);
  const schema = taskInputSchema.omit({ modelId: true, accountId: true });
  const draft = await generate(c.env, profile.id, profile.version, schema, [
    {
      role: "system",
      content:
        "将用户任务转换为可编辑任务卡。当前仅生成草稿，不执行。不能增加用户没授权的站点、写操作或成功目标。默认允许read,navigate；只有用户明确要求填写、提交或发布才添加fill/submit/publish。用户明确时间时生成once或cron（默认Asia/Shanghai）；没指定时间则manual，不能猜测执行时间。allowedOrigins只包含明确目标网站的HTTPS origin。缺少网站地址时不得猜测，请让用户补充。成功判据必须可观察。",
    },
    { role: "user", content: goal },
  ]);
  return c.json({ ...draft, modelId, accountId: null });
});
async function validatedTask(env: AppEnv, input: unknown) {
  const data = taskInputSchema.parse(input);
  const origin = publicUrl(data.entryUrl).origin;
  data.allowedOrigins = [
    ...new Set(data.allowedOrigins.map((x) => publicUrl(x).origin)),
  ];
  if (!data.allowedOrigins.includes(origin))
    throw new Error("ENTRY_ORIGIN_NOT_ALLOWED");
  if (data.schedule.kind !== "manual") nextOccurrence(data.schedule);
  const { profile } = await getModel(env, data.modelId);
  if (
    !profile.capabilities.connection ||
    !profile.capabilities.tools ||
    profile.capabilities.structured === "none"
  )
    throw new Error("MODEL_CAPABILITIES_REQUIRED");
  if (data.accountId) {
    const a = await env.DB.prepare("SELECT origin FROM accounts WHERE id=?")
      .bind(data.accountId)
      .first<{ origin: string }>();
    if (!a || !data.allowedOrigins.includes(a.origin))
      throw new Error("ACCOUNT_ORIGIN_MISMATCH");
  }
  return { data, modelVersion: profile.version };
}
user.post("/tasks", async (c) => {
  const body = z
    .object({ task: taskInputSchema, requestId: idSchema })
    .strict()
    .parse(await c.req.json());
  const key = `create:${body.requestId}`,
    digest = await hash(JSON.stringify(body.task));
  const existing = await c.env.DB.prepare(
    "SELECT * FROM idempotency WHERE key=?",
  )
    .bind(key)
    .first<Row>();
  if (existing) {
    if (existing.digest !== digest) throw new Error("IDEMPOTENCY_CONFLICT");
    const stored = await c.env.DB.prepare("SELECT * FROM tasks WHERE id=?")
      .bind(existing.resource_id)
      .first<Row>();
    if (!stored) throw new Error("TASK_NOT_FOUND");
    if (stored.version === 1)
      await enqueue(
        c.env.DB,
        taskFrom(stored),
        `trial:${existing.resource_id}:1`,
      );
    return c.json({ id: existing.resource_id });
  }
  const { data, modelVersion } = await validatedTask(c.env, body.task),
    id = `task_${body.requestId}`,
    at = now();
  const task: TaskDefinition = {
    ...data,
    id,
    version: 1,
    modelVersion,
    status: "pending_validation",
    createdAt: at,
    nextRunAt: null,
  };
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO idempotency(key,digest,resource_id) VALUES(?,?,?)",
    ).bind(key, digest, id),
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO tasks(id,version,definition,status,created_at,updated_at) SELECT ?,1,?,'pending_validation',?,? WHERE EXISTS(SELECT 1 FROM idempotency WHERE key=? AND digest=?)",
    ).bind(id, JSON.stringify(task), at, at, key, digest),
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO task_versions(task_id,version,definition) SELECT id,version,definition FROM tasks WHERE id=?",
    ).bind(id),
  ]);
  await enqueue(c.env.DB, task, `trial:${id}:1`);
  return c.json({ id }, 201);
});
user.put("/tasks/:id", async (c) => {
  const { task: input, expectedVersion } = z
    .object({
      task: taskInputSchema,
      expectedVersion: z.number().int().positive(),
    })
    .parse(await c.req.json());
  const { data, modelVersion } = await validatedTask(c.env, input),
    id = c.req.param("id");
  const old = await c.env.DB.prepare("SELECT * FROM tasks WHERE id=?")
    .bind(id)
    .first<Row>();
  if (!old) throw new Error("TASK_NOT_FOUND");
  const task: TaskDefinition = {
    ...data,
    id,
    version: expectedVersion + 1,
    modelVersion,
    status: "pending_validation",
    createdAt: old.created_at,
    nextRunAt: null,
  };
  const changed = await c.env.DB.prepare(
    "UPDATE tasks SET version=?,definition=?,status='pending_validation',next_run_at=NULL,updated_at=? WHERE id=? AND version=?",
  )
    .bind(task.version, JSON.stringify(task), now(), id, expectedVersion)
    .run();
  if (changed.meta.changes !== 1) throw new Error("VERSION_CONFLICT");
  await c.env.DB.prepare(
    "INSERT INTO task_versions(task_id,version,definition) VALUES(?,?,?)",
  )
    .bind(id, task.version, JSON.stringify(task))
    .run();
  await enqueue(c.env.DB, task, `trial:${id}:${task.version}`);
  return c.json({ id, version: task.version });
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
    const verified = await c.env.DB.prepare(
      "SELECT id FROM runs WHERE task_id=? AND status='succeeded' AND json_extract(task_snapshot,'$.version')=?",
    )
      .bind(id, task.version)
      .first();
    if (!verified) throw new Error("TRIAL_REQUIRED");
  }
  await c.env.DB.prepare(
    "UPDATE tasks SET status=?,next_run_at=?,updated_at=? WHERE id=?",
  )
    .bind(
      enabled ? "active" : "paused",
      enabled ? nextOccurrence(task.schedule) : null,
      now(),
      id,
    )
    .run();
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
user.post("/runs/:id/reconcile", async (c) => {
  const { requestId } = z
    .object({ requestId: idSchema })
    .parse(await c.req.json());
  const original = await getRun(c.env.DB, c.req.param("id"));
  if (original.status !== "unknown")
    throw new Error("RECONCILIATION_NOT_REQUIRED");
  const pending = await c.env.DB.prepare(
    "SELECT * FROM runs WHERE reconciliation_of=? AND status IN ('queued','running','waiting_user','verifying')",
  )
    .bind(original.id)
    .first<Row>();
  if (pending) return c.json(runFrom(pending));
  const task: TaskDefinition = {
    ...original.task,
    allowedActions: ["read", "navigate"],
    goal:
      "只读核查原任务的成功判据，禁止重复提交、填写或确认高影响动作。原目标：" +
      original.task.goal,
  };
  const run = await enqueue(
    c.env.DB,
    task,
    `reconcile:${original.id}:${requestId}`,
  );
  await c.env.DB.prepare(
    "UPDATE runs SET reconciliation_of=? WHERE id=? AND status='queued'",
  )
    .bind(original.id, run.id)
    .run();
  return c.json({ ...run, reconciliationOf: original.id });
});
user.get("/tasks/:id/chat", async (c) =>
  c.json(
    (
      await c.env.DB.prepare(
        "SELECT * FROM conversations WHERE task_id=? ORDER BY at LIMIT 200",
      )
        .bind(c.req.param("id"))
        .all()
    ).results,
  ),
);
user.post("/tasks/:id/chat", async (c) => {
  const { content, requestId } = z
      .object({
        content: z.string().trim().min(1).max(6000),
        requestId: idSchema,
      })
      .parse(await c.req.json()),
    taskId = c.req.param("id");
  const pending = await c.env.DB.prepare(
    "SELECT c.id FROM challenges c JOIN runs r ON r.id=c.run_id WHERE r.task_id=? AND c.status='pending' AND c.expires_at>?",
  )
    .bind(taskId, now())
    .first();
  if (pending) throw new Error("USE_CHALLENGE_REPLY");
  const row = await c.env.DB.prepare("SELECT * FROM tasks WHERE id=?")
    .bind(taskId)
    .first<Row>();
  if (!row) throw new Error("TASK_NOT_FOUND");
  const task = taskFrom(row);
  const prior = await c.env.DB.prepare(
    "SELECT id FROM conversations WHERE id=?",
  )
    .bind(requestId)
    .first();
  if (prior) return c.json({ ok: true });
  const answer = await generate(
    c.env,
    task.modelId,
    task.modelVersion,
    z.object({ reply: z.string().max(6000) }),
    [
      {
        role: "system",
        content:
          "你是 TaskRelay 任务助手。说明或澄清任务，不执行操作，也不能修改授权或调度。若用户补充目标，提醒其通过编辑任务卡保存并重新试运行。不要索取或复述密码/验证码。当前任务：" +
          JSON.stringify(task),
      },
      { role: "user", content },
    ],
  );
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO conversations(id,task_id,role,content,at) VALUES(?,?,?,?,?)",
    ).bind(requestId, taskId, "user", content, now()),
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO conversations(id,task_id,role,content,at) VALUES(?,?,?,?,?)",
    ).bind(`reply_${requestId}`, taskId, "assistant", answer.reply, now()),
  ]);
  return c.json({ ok: true });
});
user.post("/challenges/:id/reply", async (c) => {
  const body = z
    .object({
      runId: idSchema,
      stepId: idSchema,
      version: z.number().int(),
      leaseEpoch: z.number().int(),
      text: z.string().min(1).max(4000),
    })
    .strict()
    .parse(await c.req.json());
  const row = await c.env.DB.prepare(
    "SELECT c.* FROM challenges c JOIN runs r ON r.id=c.run_id WHERE c.id=? AND c.run_id=? AND c.step_id=? AND c.version=? AND c.lease_epoch=? AND c.status='pending' AND c.expires_at>? AND r.status='waiting_user' AND r.lease_epoch=c.lease_epoch AND r.lease_expires_at>? AND r.cancel_requested=0",
  )
    .bind(
      c.req.param("id"),
      body.runId,
      body.stepId,
      body.version,
      body.leaseEpoch,
      now(),
      now(),
    )
    .first<Row>();
  if (!row) throw new Error("CHALLENGE_STALE");
  if (row.kind === "unsupported") throw new Error("CHALLENGE_UNSUPPORTED");
  const run = await getRun(c.env.DB, body.runId);
  const parsed = await generate(
    c.env,
    run.task.modelId,
    run.task.modelVersion,
    z.object({
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
      confirmed: z.boolean(),
    }),
    [
      {
        role: "system",
        content:
          "提取用户回复中要填写的信息。返回原文 UTF-16 字符起止位置（end不含），必须保留前导零、大小写、符号；不能生成新值。scan或approval时仅用户明确表示完成/同意才confirmed=true；否定、歧义一律false。类型：" +
          row.kind,
      },
      { role: "user", content: body.text },
    ],
    run.id,
  );
  const value = ["code", "information"].includes(row.kind)
    ? exactReply(body.text, parsed)
    : "";
  // Consequential approvals require an explicit literal as well as model interpretation.
  if (
    row.kind === "approval" &&
    (!parsed.confirmed || !["确认执行", "同意执行"].includes(body.text.trim()))
  )
    throw new Error("EXPLICIT_APPROVAL_REQUIRED");
  if (row.kind === "scan" && !parsed.confirmed)
    throw new Error("CONFIRMATION_REQUIRED");
  const secret = await seal(
    { value, confirmed: parsed.confirmed },
    c.env.MASTER_KEY,
    `challenge:${row.id}:${row.version}:${row.lease_epoch}`,
  );
  const result = await c.env.DB.prepare(
    "UPDATE challenges SET status='answered',secret=? WHERE id=? AND status='pending' AND expires_at>? AND EXISTS(SELECT 1 FROM runs r WHERE r.id=challenges.run_id AND r.lease_epoch=challenges.lease_epoch AND r.lease_expires_at>? AND r.status='waiting_user' AND r.cancel_requested=0)",
  )
    .bind(secret, row.id, now(), now())
    .run();
  if (result.meta.changes !== 1) throw new Error("CHALLENGE_STALE");
  return c.json({ ok: true });
});
user.post("/devices/:id/revoke", async (c) => {
  await c.env.DB.prepare("UPDATE devices SET revoked=1 WHERE id=?")
    .bind(c.req.param("id"))
    .run();
  return c.json({ ok: true });
});
user.get("/pairings/:code", async (c) => {
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
user.post("/pairings/:code/approve", async (c) => {
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
      "INSERT OR IGNORE INTO devices(id,name,token_hash,protocol_version) VALUES(?,?,?,1)",
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
  const object = await c.env.EVIDENCE.get(row.object_key);
  if (!object) return c.json({ error: "ARTIFACT_EXPIRED" }, 404);
  if (c.req.query("format") === "data") {
    const bytes = new Uint8Array(await object.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return c.json({
      dataUrl: `data:${row.content_type};base64,${btoa(binary)}`,
    });
  }
  return new Response(object.body, {
    headers: {
      "Content-Type": row.content_type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
user.get("/settings", async (c) =>
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
user.get("/settings/check", async (c) => {
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
user.put("/settings", async (c) => {
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
