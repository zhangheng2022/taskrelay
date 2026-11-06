/** 设备执行协议：用租约约束上下文、模型转发、协助与动作登记；终态独立提交后回填原聊天。 */
import { Buffer } from "node:buffer";
import { Hono } from "hono";
import { z } from "zod";
import {
  PROTOCOL_VERSION,
  idSchema,
  limits,
  runResultSchema,
} from "../../../packages/contracts/src/index";
import { executorTools } from "../../../packages/contracts/src/execution";
import { publicUrl } from "../../../packages/contracts/src/security";
import type { AppEnv, Variables } from "./env";
import { claim, getRun, requireLease, now, type Row } from "./store";
import { getModelProfile } from "./models";
import { RelayChatModel } from "./ai/model";
import { AIMessage } from "@langchain/core/messages";
import {
  aiMessageToModelResponse,
  toLangChainMessages,
} from "../../../packages/model/src/langchain";
import { putEvidence, deleteEvidence } from "./evidence";
import { appendMessage, conversationContext, runThread } from "./chat-messages";
import { resolveHelp } from "./execution-help";
import { estimateTokens } from "../../../packages/model/src/agent-context";
import { browserStateAccess, stageBrowserState, publishBrowserState } from "./browser-state";
import { advanceDispatchGroups } from "./account-dispatch";
import { pendingCardOrigins, registerAccountRunnerRoutes } from "./account-cards";
import { readRunCredentials } from "./accounts";

export const runner = new Hono<{ Bindings: AppEnv; Variables: Variables }>();
registerAccountRunnerRoutes(runner);
const lease = z.object({ epoch: z.number().int().positive() });
const modelMessage = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string(),
    tool_call_id: z.string().min(1).optional(),
    tool_calls: z
      .array(
        z.object({
          id: z.string().min(1),
          type: z.literal("function"),
          function: z.object({ name: z.string().min(1), arguments: z.string() }),
        }),
      )
      .optional(),
    content_blocks: z
      .array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("text"), text: z.string() }),
          z.object({ type: z.literal("image_url"), image_url: z.object({ url: z.string() }) }),
        ]),
      )
      .optional(),
  })
  .superRefine((message, ctx) => {
    if (message.role === "tool" && !message.tool_call_id)
      ctx.addIssue({ code: "custom", message: "MODEL_TOOL_CALL_ID_REQUIRED" });
  });
const parts = z.array(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("image"), artifactId: idSchema, alt: z.string() }),
    z.object({ type: z.literal("tool"), name: z.string(), result: z.string() }),
  ]),
);
runner.post("/claim", async (c) => {
  const b = z
    .object({ requestId: idSchema, protocolVersion: z.literal(PROTOCOL_VERSION) })
    .parse(await c.req.json());
  return c.json({ run: await claim(c.env.DB, c.get("deviceId"), b.requestId) });
});
runner.post("/runs/:id/heartbeat", async (c) => {
  const b = lease.parse(await c.req.json()),
    run = await requireLease(c.env.DB, c.req.param("id"), c.get("deviceId"), b.epoch, true);
  const expiry = new Date(Date.now() + limits.leaseMs).toISOString();
  await c.env.DB.prepare(
    "UPDATE runs SET lease_expires_at=?,updated_at=? WHERE id=? AND lease_epoch=?",
  )
    .bind(expiry, now(), run.id, b.epoch)
    .run();
  return c.json({ leaseExpiresAt: expiry, cancelRequested: run.cancelRequested });
});
runner.post("/runs/:id/context", async (c) => {
  const b = lease
    .extend({ after: z.number().int().nonnegative().default(0) })
    .parse(await c.req.json());
  const run = await requireLease(c.env.DB, c.req.param("id"), c.get("deviceId"), b.epoch),
    thread = await runThread(c.env, run.id);
  const messages = await conversationContext(c.env, thread.id, b.after, { runId: run.id });
  await requireLease(c.env.DB, run.id, c.get("deviceId"), b.epoch);
  const current = await getRun(c.env.DB, run.id);
  const profile =
    b.after === 0
      ? (await getModelProfile(c.env, run.task.modelId, run.task.modelVersion)).profile
      : null;
  return c.json({
    messages,
    ...(profile
      ? {
          modelContext: {
            contextTokens: profile.contextTokens ?? 16000,
            outputTokens: profile.outputTokens ?? 4096,
          },
        }
      : {}),
    accountBinding: {
      accountId: current.accountId ?? null,
      credentialVersion: current.credentialVersion ?? 1,
      stateEpoch: current.stateEpoch ?? 1,
    },
  });
});
runner.post("/runs/:id/messages", async (c) => {
  const b = lease
    .extend({
      id: idSchema,
      content: z.string(),
      parts: parts.default([]),
      replyTo: idSchema.optional(),
    })
    .parse(await c.req.json());
  const run = await requireLease(c.env.DB, c.req.param("id"), c.get("deviceId"), b.epoch, true),
    thread = await runThread(c.env, run.id);
  for (const part of b.parts)
    if (
      part.type === "image" &&
      !(await c.env.DB.prepare("SELECT id FROM artifacts WHERE id=? AND run_id=? AND thread_id=?")
        .bind(part.artifactId, run.id, thread.id)
        .first())
    )
      throw Error("ARTIFACT_NOT_FOUND");
  await appendMessage(c.env, thread.id, { ...b, source: "executor", runId: run.id });
  return c.json({ ok: true });
});
// The executor owns the prompt and tool loop; this endpoint only relays inference.
runner.post("/runs/:id/model", async (c) => {
  const b = lease
    .extend({
      requestId: idSchema,
      messages: z.array(modelMessage),
      purpose: z.enum(["decision", "summary"]).default("decision"),
      supportsScreenshot: z.boolean().optional(),
    })
    .parse(await c.req.json());
  const run = await requireLease(c.env.DB, c.req.param("id"), c.get("deviceId"), b.epoch);
  const { profile } = await getModelProfile(c.env, run.task.modelId, run.task.modelVersion);
  const images =
    b.purpose === "decision"
      ? await c.env.DB.prepare(
          `SELECT COUNT(*) AS count FROM ai_messages m,json_each(m.parts) p
    JOIN artifacts a ON a.id=json_extract(p.value,'$.artifactId') AND a.run_id=m.run_id
    WHERE m.run_id=? AND json_extract(p.value,'$.type')='image'`,
        )
          .bind(run.id)
          .first<{ count: number }>()
      : null;
  // Delivery facts belong to this relay; they are not business outcome checks.
  const messages =
    b.purpose === "summary"
      ? b.messages
      : [
          {
            role: "system" as const,
            content: `运行能力与聊天附件反馈：本次运行已关联到聊天的截图数量=${images?.count ?? 0}。执行器会自动在最终答复前附上当前页面截图；保存与展示截图不需要视觉模型。只报告实际结果，不把工具一次失败等同于整个任务失败。`,
          },
          ...b.messages,
        ];
  const tools =
    b.purpose === "summary"
      ? []
      : executorTools.filter((tool) => tool.name !== "screenshot" || b.supportsScreenshot);
  if (
    estimateTokens(messages) + estimateTokens(tools) + (profile.outputTokens ?? 4096) + 512 >
    (profile.contextTokens ?? 16000)
  )
    throw Error("MODEL_CONTEXT_TOO_LARGE");
  const model = new RelayChatModel(
    c.env,
    run.task.modelId,
    run.task.modelVersion,
    `execute_${run.id}_${b.requestId}`,
    run.id,
  );
  const bound = tools.length
    ? model.bindTools(
        tools.map((tool) => ({ type: "function", function: tool })),
        { tool_choice: "auto", maxTokens: profile.outputTokens ?? 4096 },
      )
    : model.withConfig({ maxTokens: profile.outputTokens ?? 4096 });
  const response = aiMessageToModelResponse(await bound.invoke(toLangChainMessages(messages)));
  await requireLease(c.env.DB, run.id, c.get("deviceId"), b.epoch);
  return c.json({ response });
});
// Never summarize Stagehand's tree/element IDs independently of its schema.
runner.post("/runs/:id/stagehand", async (c) => {
  const b = lease
    .extend({
      requestId: idSchema,
      messages: z.array(
        z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() }),
      ),
      schema: z.record(z.string(), z.unknown()).optional(),
      image: z.string().max(2_000_000).optional(),
    })
    .parse(await c.req.json());
  const run = await requireLease(c.env.DB, c.req.param("id"), c.get("deviceId"), b.epoch);
  const { profile } = await getModelProfile(c.env, run.task.modelId, run.task.modelVersion);
  if (b.image && !profile.capabilities.vision) throw Error("VISION_NOT_SUPPORTED");
  const operation = `stagehand_${run.id}_${b.requestId}`;
  const model = new RelayChatModel(
    c.env,
    run.task.modelId,
    run.task.modelVersion,
    operation,
    run.id,
  );
  const options = {
    image: b.image,
    maxTokens: profile.outputTokens ?? 4096,
    invalidCode: "STAGEHAND_SCHEMA_INVALID",
  };
  let response;
  if (b.schema) {
    const result = await model
      .withStructuredOutput(b.schema, { includeRaw: true })
      .invoke(toLangChainMessages(b.messages), options);
    if (!(result.raw instanceof AIMessage)) throw Error("MODEL_INVALID_RESPONSE");
    response = { ...aiMessageToModelResponse(result.raw), structured: result.parsed };
  } else
    response = aiMessageToModelResponse(
      await model.invoke(toLangChainMessages(b.messages), options),
    );
  await requireLease(c.env.DB, run.id, c.get("deviceId"), b.epoch);
  return c.json({ text: response.text, ...(b.schema ? { structured: response.structured } : {}) });
});
runner.post("/runs/:id/help", async (c) => {
  const b = lease
    .extend({ id: idSchema, message: z.string(), origin: z.url() })
    .parse(await c.req.json());
  const run = await requireLease(c.env.DB, c.req.param("id"), c.get("deviceId"), b.epoch);
  publicUrl(b.origin);
  return c.json(await resolveHelp(c.env, run, { ...b, origin: new URL(b.origin).origin }));
});
runner.post("/runs/:id/help/:help/ack", async (c) => {
  const b = lease.parse(await c.req.json()),
    run = await requireLease(c.env.DB, c.req.param("id"), c.get("deviceId"), b.epoch);
  await c.env.DB.prepare(
    "UPDATE execution_help SET awaiting_user=0 WHERE id=? AND run_id=? AND epoch=?",
  )
    .bind(c.req.param("help"), run.id, b.epoch)
    .run();
  return c.json({ ok: true });
});
runner.post("/runs/:id/credentials", async (c) => {
  const b = lease.extend({ url: z.url(), helpId: idSchema.optional() }).parse(await c.req.json());
  const run = await requireLease(c.env.DB, c.req.param("id"), c.get("deviceId"), b.epoch);
  return c.json(await readRunCredentials(c.env, run, b.url));
});
runner.post("/runs/:id/browser-state", async (c) => {
  const b = lease.extend({ metadataOnly: z.boolean().optional() }).parse(await c.req.json());
  const run = await requireLease(c.env.DB, c.req.param("id"), c.get("deviceId"), b.epoch);
  const result = await browserStateAccess(
    c.env,
    run,
    await pendingCardOrigins(c.env, run.id),
    !b.metadataOnly,
  );
  await requireLease(c.env.DB, run.id, c.get("deviceId"), b.epoch);
  return c.json(b.metadataOnly ? { ...result, state: null } : result);
});
runner.post("/runs/:id/browser-state/upload", async (c) => {
  const b = lease
    .extend({ state: z.unknown(), baseRevision: z.number().int().nonnegative() })
    .parse(await c.req.json());
  const run = await requireLease(c.env.DB, c.req.param("id"), c.get("deviceId"), b.epoch);
  return c.json(
    await stageBrowserState(
      c.env,
      run,
      b.state,
      b.baseRevision,
      await pendingCardOrigins(c.env, run.id),
    ),
  );
});
runner.post("/runs/:id/browser-state/sync-failed", async (c) => {
  const b = lease
    .extend({ reason: z.enum(["TOO_LARGE", "UNSUPPORTED_COOKIE", "SYNC_FAILED"]).optional() })
    .parse(await c.req.json());
  const run = await requireLease(c.env.DB, c.req.param("id"), c.get("deviceId"), b.epoch);
  // 只持久化固定分类；浏览器/网络原始错误可能包含 Cookie、地址参数或凭据。
  await c.env.DB.prepare(
    `UPDATE accounts SET sync_status='failed',sync_error=? WHERE id=? AND user_id=? AND credential_version=? AND state_epoch=?
    AND EXISTS(SELECT 1 FROM runs r JOIN account_locks l ON l.run_id=r.id AND l.account_key=r.account_id
      WHERE r.id=? AND r.account_id=accounts.id AND r.device_id=? AND r.lease_epoch=? AND r.lease_expires_at>?
      AND r.cancel_requested=0 AND r.context_withdrawn=0 AND r.history_deleted=0 AND r.status IN ('running','waiting_user','verifying'))`,
  )
    .bind(
      b.reason ?? "SYNC_FAILED",
      run.accountId ?? null,
      run.userId,
      run.credentialVersion ?? 1,
      run.stateEpoch ?? 1,
      run.id,
      run.deviceId,
      run.leaseEpoch,
      now(),
    )
    .run();
  return c.json({ ok: true });
});
runner.post("/runs/:id/browser-closed", async (c) => {
  const b = lease.parse(await c.req.json()),
    run = await getRun(c.env.DB, c.req.param("id"));
  if (run.deviceId !== c.get("deviceId") || run.leaseEpoch !== b.epoch)
    throw Error("LEASE_EXPIRED");
  // Main 的退出事实可在终态之后重传。若 finish 丢失，仅结束本次执行，绝不推断业务成功。
  await c.env.DB.prepare(
    `UPDATE runs SET cleanup_confirmed=1,
    status=CASE WHEN status IN ('running','waiting_user','verifying') THEN CASE WHEN write_pending=1 OR may_have_written=1 THEN 'unknown' WHEN cancel_requested=1 THEN 'cancelled' ELSE 'failed' END ELSE status END,
    lease_expires_at=NULL WHERE id=? AND device_id=? AND lease_epoch=?`,
  )
    .bind(run.id, run.deviceId, b.epoch)
    .run();
  await publishBrowserState(c.env, run.id);
  // 退出事实和状态收尾分开确认；发布失败保留阻挡，避免 Scheduler 在重试前释放锁。
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE runs SET cleanup_pending=0 WHERE id=? AND device_id=? AND lease_epoch=? AND cleanup_confirmed=1",
    ).bind(run.id, run.deviceId, b.epoch),
    c.env.DB.prepare(
      "DELETE FROM account_locks WHERE run_id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND cleanup_confirmed=1 AND cleanup_pending=0 AND status IN ('succeeded','failed','cancelled','expired'))",
    ).bind(run.id, run.id),
  ]);
  await advanceDispatchGroups(c.env.DB);
  const account = await c.env.DB.prepare(
    "SELECT a.state_revision,a.state_object_key,r.state_candidate_key FROM accounts a JOIN runs r ON r.account_id=a.id WHERE r.id=?",
  )
    .bind(run.id)
    .first<Row>();
  return c.json({
    ok: true,
    synced: !!account?.state_object_key && account.state_object_key === account.state_candidate_key,
    revision: account?.state_revision ?? 0,
  });
});
runner.post("/runs/:id/tool", async (c) => {
  const b = lease
    .extend({
      id: idSchema,
      phase: z.enum(["start", "result"]),
      digest: z.string(),
      result: z.string().optional(),
    })
    .parse(await c.req.json());
  const run = await requireLease(c.env.DB, c.req.param("id"), c.get("deviceId"), b.epoch);
  if (b.phase === "start") {
    const prior = await c.env.DB.prepare(
      "SELECT digest,status FROM actions WHERE run_id=? AND action_id=?",
    )
      .bind(run.id, b.id)
      .first<Row>();
    if (prior) {
      if (prior.digest !== b.digest) throw Error("TOOL_REQUEST_CONFLICT");
      return c.json({ execute: false, status: prior.status });
    }
    const [saved] = await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO actions(run_id,action_id,digest,effect,status) SELECT ?,?,?,'write','intended' WHERE EXISTS(SELECT 1 FROM runs WHERE id=? AND lease_epoch=? AND lease_expires_at>? AND cancel_requested=0 AND status='running' AND write_pending=0)",
      ).bind(run.id, b.id, b.digest, run.id, b.epoch, now()),
      c.env.DB.prepare(
        "UPDATE runs SET write_pending=1 WHERE id=? AND EXISTS(SELECT 1 FROM actions WHERE run_id=? AND action_id=? AND digest=? AND status='intended')",
      ).bind(run.id, run.id, b.id, b.digest),
    ]);
    return c.json({ execute: saved.meta.changes === 1 });
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE actions SET status='observed' WHERE run_id=? AND action_id=? AND digest=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND lease_epoch=? AND lease_expires_at>?)",
    ).bind(run.id, b.id, b.digest, run.id, b.epoch, now()),
    c.env.DB.prepare(
      "UPDATE runs SET write_pending=0,may_have_written=0 WHERE id=? AND NOT EXISTS(SELECT 1 FROM actions WHERE run_id=? AND status='intended')",
    ).bind(run.id, run.id),
  ]);
  return c.json({ ok: true });
});
runner.post("/runs/:id/snapshots", async (c) => {
  const b = lease
    .extend({ captureId: idSchema, image: z.string().max(2_000_000) })
    .parse(await c.req.json());
  const run = await requireLease(c.env.DB, c.req.param("id"), c.get("deviceId"), b.epoch, true),
    thread = await runThread(c.env, run.id);
  const bytes = Buffer.from(b.image, "base64");
  if (
    bytes.length > 1_500_000 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw Error("PNG_REQUIRED");
  const id = `snapshot_${b.captureId}`;
  const prior = await c.env.DB.prepare("SELECT id,run_id,thread_id FROM artifacts WHERE id=?")
    .bind(id)
    .first<Row>();
  if (prior) {
    if (prior.run_id !== run.id || prior.thread_id !== thread.id) throw Error("ARTIFACT_CONFLICT");
    return c.json({ id });
  }
  // 每次上传独占对象，只有赢得索引插入的对象对外发布。进程中断或D1
  // 写入结果未知时不贸然删除；Evidence alarm 根据持久索引保留或回收。
  const key = `chat/${thread.id}/${id}/${crypto.randomUUID()}`;
  await putEvidence(c.env, key, new Uint8Array(bytes).buffer, null, true);
  const saved = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO artifacts(id,run_id,object_key,content_type,expires_at,thread_id,persistent)
    SELECT ?,?,?,'image/png','9999-12-31T23:59:59.999Z',?,1 WHERE EXISTS(SELECT 1 FROM ai_threads WHERE id=? AND closed=0)
    AND NOT EXISTS(SELECT 1 FROM evidence_retirements WHERE object_key=?)
    AND EXISTS(SELECT 1 FROM runs WHERE id=? AND device_id=? AND lease_epoch=? AND lease_expires_at>? AND status IN ('running','waiting_user','verifying'))`,
  )
    .bind(id, run.id, key, thread.id, thread.id, key, run.id, c.get("deviceId"), b.epoch, now())
    .run();
  if (!saved.meta.changes) {
    const winner = await c.env.DB.prepare(
      "SELECT id,run_id,thread_id,object_key FROM artifacts WHERE id=?",
    )
      .bind(id)
      .first<Row>();
    if (winner?.object_key !== key) await deleteEvidence(c.env, key);
    if (winner?.run_id === run.id && winner.thread_id === thread.id) return c.json({ id });
    if (winner) throw Error("ARTIFACT_CONFLICT");
    throw Error("THREAD_NOT_FOUND");
  }
  return c.json({ id });
});
runner.post("/runs/:id/finish", async (c) => {
  const b = lease
    .extend({
      status: z.enum(["succeeded", "failed", "unknown", "cancelled"]),
      result: runResultSchema,
      expectedUserSeq: z.number().int().nonnegative().optional(),
      stateCandidateKey: idSchema.nullable().optional(),
    })
    .parse(await c.req.json());
  const run = await getRun(c.env.DB, c.req.param("id"));
  if (run.deviceId !== c.get("deviceId") || run.leaseEpoch !== b.epoch)
    throw Error("LEASE_EXPIRED");
  const hidden = !!(await c.env.DB.prepare("SELECT id FROM runs WHERE id=? AND history_deleted=1")
    .bind(run.id)
    .first());
  const terminal = ["succeeded", "failed", "unknown", "cancelled", "expired"].includes(run.status);
  if (terminal) {
    // A lost response may be retried, but cannot replace the committed result.
    if (!hidden && JSON.stringify(run.result) !== JSON.stringify(b.result))
      throw Error("LEASE_EXPIRED");
  } else {
    await requireLease(c.env.DB, run.id, c.get("deviceId"), b.epoch, true);
    const at = now();
    const [saved] = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE runs SET status=CASE WHEN write_pending=1 THEN 'unknown' WHEN cancel_requested=1 THEN 'cancelled' ELSE ? END,result=CASE WHEN history_deleted=1 THEN NULL ELSE ? END,lease_expires_at=NULL,updated_at=?
        WHERE id=? AND lease_epoch=? AND lease_expires_at>? AND status IN ('running','waiting_user','verifying')
        AND (? IS NULL OR cancel_requested=1 OR (SELECT COALESCE(MAX(seq),0) FROM ai_messages WHERE thread_id=runs.thread_id AND role='user')=?)`,
      ).bind(
        b.status,
        JSON.stringify(b.result),
        at,
        run.id,
        b.epoch,
        at,
        b.expectedUserSeq ?? null,
        b.expectedUserSeq ?? null,
      ),
      c.env.DB.prepare(
        "UPDATE execution_help SET awaiting_user=0 WHERE run_id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND lease_epoch=? AND lease_expires_at IS NULL)",
      ).bind(run.id, run.id, b.epoch),
      c.env.DB.prepare(
        `UPDATE runs SET state_candidate_key=? WHERE id=? AND lease_epoch=? AND status IN ('succeeded','failed') AND EXISTS(SELECT 1 FROM browser_state_candidates WHERE object_key=? AND run_id=runs.id AND device_id=runs.device_id AND lease_epoch=runs.lease_epoch AND retired=0)`,
      ).bind(b.stateCandidateKey ?? null, run.id, b.epoch, b.stateCandidateKey ?? null),
      c.env.DB.prepare(
        "DELETE FROM account_locks WHERE run_id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND lease_epoch=? AND cleanup_pending=0 AND status IN ('succeeded','failed','cancelled','expired'))",
      ).bind(run.id, run.id, b.epoch),
    ]);
    if (!saved.meta.changes) {
      const savedRun = await getRun(c.env.DB, run.id);
      if (
        b.expectedUserSeq !== undefined &&
        savedRun.leaseEpoch === b.epoch &&
        ["running", "waiting_user", "verifying"].includes(savedRun.status) &&
        !savedRun.cancelRequested
      ) {
        const latest = await c.env.DB.prepare(
          "SELECT COALESCE(MAX(seq),0) seq FROM ai_messages WHERE thread_id=(SELECT thread_id FROM runs WHERE id=?) AND role='user'",
        )
          .bind(run.id)
          .first<{ seq: number }>();
        if (latest?.seq !== b.expectedUserSeq) throw Error("INSTRUCTIONS_CHANGED");
      }
      if (
        savedRun.leaseEpoch !== b.epoch ||
        (!hidden && JSON.stringify(savedRun.result) !== JSON.stringify(b.result))
      )
        throw Error("LEASE_EXPIRED");
    }
  }
  const thread = await c.env.DB.prepare(
    "SELECT t.id FROM ai_threads t JOIN runs r ON r.thread_id=t.id WHERE r.id=? AND t.closed=0",
  )
    .bind(run.id)
    .first<{ id: string }>();
  if (thread)
    await appendMessage(c.env, thread.id, {
      id: `final_${run.id}`,
      source: "executor",
      content: b.result.summary,
      runId: run.id,
    });
  return c.json({ ok: true });
});
