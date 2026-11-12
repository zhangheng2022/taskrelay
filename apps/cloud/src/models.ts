import { dbTime } from "./database";
/**
 * 模型服务入口：管理配置版本、能力探测、调用去重、结构化校验与实际用量。
 * 普通调用只提交加密出站作业；仅固定模型版本指定区域的 ModelEgress 的 alarm 可调用提供方适配器。
 */
import { connectionFrom, gatewayTransport, validateEndpoint } from "./model-gateway";
import { reserve } from "./tenancy";
import { resolveModelImage } from "./images";
import { z } from "zod";
import {
  infer,
  streamKind,
  type Inference,
  type ModelResponse,
} from "../../../packages/model/src/index";
import { draftPublisher, type DraftTarget } from "./chat-drafts";
import type { ModelCapabilities, ModelProfile } from "../../../packages/contracts/src/index";
import type { AppEnv } from "./env";
import { seal, unseal } from "./crypto";
import { now, uid, type Row } from "./store";
import { visionFixture } from "./vision-fixture";
import { egress } from "./egress";
import { hash } from "../../../packages/contracts/src/security";
import { graphWriteFence } from "./ai/fence";
import { callResultStatements, unpackCallCipher } from "./call-cache";

export function modelFrom(row: Row): ModelProfile {
  const config = JSON.parse(row.config);
  const capabilities: ModelCapabilities = JSON.parse(row.capabilities);
  if (config.protocol !== "responses") throw Error("MODEL_PROTOCOL_RETIRED");
  return {
    ...config,
    id: row.id,
    version: row.version,
    enabled: row.enabled !== 0,
    managementVersion: row.management_version ?? 1,
    scope: row.owner_user_id == null ? "platform" : "personal",
    connectionId: row.connection_id,
    effectiveRegion: row.effective_region,
    capabilities,
  };
}
// 读能力与真正出站使用同一归属约束。未迁移的历史版本缺少连接，只可查询历史用量。
export async function getModelProfile(
  env: AppEnv,
  id: string,
  version?: number,
  userId: string | null | undefined = env.requestUserId,
) {
  const adminProbe = env.adminProbeModelId === id;
  const row = await env.DB.prepare(
    `SELECT v.id,v.version,v.config,v.connection_id,v.effective_region,v.capabilities,m.owner_user_id,m.enabled,m.management_version
     FROM model_profile_versions v JOIN models m ON m.id=v.id LEFT JOIN model_connections c
     ON c.id=v.connection_id AND c.owner_user_id IS m.owner_user_id WHERE v.id=? AND (m.owner_user_id IS NULL OR m.owner_user_id=?)
     AND (c.id IS NOT NULL OR (v.connection_id IS NULL AND v.config='{}')) AND v.version=COALESCE(?,m.current_version)
     ${adminProbe ? "AND c.id IS NOT NULL AND m.owner_user_id IS NULL AND EXISTS(SELECT 1 FROM members WHERE id=? AND role='admin' AND disabled=0)" : ""}`,
  )
    .bind(id, userId ?? null, version ?? null, ...(adminProbe ? [userId ?? null] : []))
    .first<Row>();
  if (!row) throw Error("MODEL_NOT_FOUND");
  const profile = modelFrom(row);
  if (!row.enabled && !adminProbe) throw Error("MODEL_DISABLED");
  return { profile };
}
export async function recordUsage(
  env: AppEnv,
  profile: ModelProfile,
  response: ModelResponse,
  runId: string | null,
  userId: string,
  timing: { callId: string; inferenceStartedAt: string; providerStartedAt: string },
) {
  await env.DB.prepare(
    `INSERT INTO model_usage(id,run_id,model_id,model_version,input_tokens,output_tokens,at,user_id,
      call_id,inference_started_at,provider_started_at,retired_cost) VALUES(?,?,?,?,?,?,?,?,?,?,?,
        CASE WHEN NOT EXISTS(SELECT 1 FROM model_profile_versions WHERE id=? AND version=? AND connection_id IS NOT NULL)
        THEN (? * ? + ? * ?) / 1000000.0 END)`,
  )
    .bind(
      uid("usage"),
      runId,
      profile.id,
      profile.version,
      response.usage.input,
      response.usage.output,
      dbTime(now()),
      userId,
      timing.callId,
      dbTime(timing.inferenceStartedAt),
      dbTime(timing.providerStartedAt),
      profile.id,
      profile.version,
      response.usage.input,
      profile.inputPrice ?? null,
      response.usage.output,
      profile.outputPrice ?? null,
    )
    .run();
}
export async function invoke(
  env: AppEnv,
  id: string,
  version: number,
  request: Inference,
  runId: string | null = null,
  operationId?: string,
  graphId?: string,
  graphGeneration?: number,
  preview?: DraftTarget,
) {
  const userId = runId
    ? (
        await env.DB.prepare("SELECT user_id FROM runs WHERE id=?")
          .bind(runId)
          .first<{ user_id: string }>()
      )?.user_id
    : env.requestUserId;
  if (!userId || (env.requestUserId && env.requestUserId !== userId))
    throw new Error("MODEL_ACTOR_REQUIRED");
  env = { ...env, requestUserId: userId };
  const { profile: pinned } = await getModelProfile(env, id, version);
  const callId = operationId ?? crypto.randomUUID();
  const digest = await hash(JSON.stringify({ userId, id, version, request, runId }));
  const graphFence = graphId ? graphWriteFence(userId, graphId, graphGeneration) : undefined;
  // 桌面原生工具循环没有云端 graphId，仍须按运行关联缓存并原子拒绝清理后的迟到结果。
  const fence =
    graphFence ??
    (runId
      ? {
          sql: "EXISTS(SELECT 1 FROM runs WHERE id=? AND user_id=? AND history_deleted=0)",
          values: [runId, userId],
        }
      : undefined);
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO ai_calls(id,user_id,graph_id,run_id,digest,status,created_at,updated_at) SELECT ?,?,?,?,?,'reserved',?,? ${fence ? `WHERE ${fence.sql}` : ""}`,
  )
    .bind(
      callId,
      userId,
      graphId ?? null,
      runId,
      digest,
      dbTime(now()),
      dbTime(now()),
      ...(fence?.values ?? []),
    )
    .run();
  if (!inserted.meta.changes) {
    // A deduplicated result still belongs to its original live graph. Replaying
    // an operation must not bypass deletion, cancellation, or generation fences.
    const [parents, chunks] = await env.DB.batch<Row>([
      env.DB.prepare(
        `SELECT * FROM call_details WHERE id=? ${fence ? `AND ${fence.sql}` : ""}`,
      ).bind(callId, ...(fence?.values ?? [])),
      env.DB.prepare(
        "SELECT token,part,value FROM call_result_chunks WHERE id=? ORDER BY part",
      ).bind(callId),
    ]);
    const prior = parents.results[0];
    if (!prior && fence) throw Error("MODEL_CALL_DISCARDED");
    if (!prior || prior.user_id !== userId || prior.digest !== digest)
      throw new Error("MODEL_CALL_CONFLICT");
    if (prior.status === "done" && prior.result)
      return unseal<ModelResponse>(
        unpackCallCipher(
          prior.result,
          chunks.results as { part: number; token: string; value: string }[],
        ),
        env.MASTER_KEY,
        `ai-call:${callId}`,
      );
    throw new Error(prior.status === "failed" ? prior.error : "MODEL_CALL_OUTCOME_UNKNOWN");
  }
  try {
    let streamMode = request.stream ? "stream" : "buffered";
    // 去重先于能力选择：回退开关或能力更新不能改变已发出调用的身份，也不能触发重探测。
    if (request.stream === undefined) {
      const disabled =
        (
          await env.DB.prepare(
            "SELECT value FROM settings WHERE key='modelStreamingEnabled'",
          ).first<{ value: string }>()
        )?.value === "0";
      if (!disabled) await ensureStreaming(env, id, version, request, userId);
      const { profile } = await getModelProfile(env, id, version);
      request = {
        ...request,
        stream: !disabled && profile.capabilities.streaming?.[streamKind(request)] === "supported",
      };
      streamMode = request.stream ? "stream" : disabled ? "buffered" : "fallback";
    }
    const reservationId = await reserve(env, userId, "model", callId);
    const egressStartedAt = now();
    await env.DB.prepare(
      "UPDATE ai_calls SET status='running',updated_at=?,egress_started_at=?,stream_mode=? WHERE id=?",
    )
      .bind(dbTime(egressStartedAt), dbTime(egressStartedAt), streamMode, callId)
      .run();
    return await egress<ModelResponse>(
      env,
      {
        kind: "inference",
        region: pinned.effectiveRegion!,
        adminProbe: env.adminProbeModelId === id,
        userId,
        reservationId,
        modelId: id,
        version,
        request,
        runId,
        callId,
        preview,
      },
      async (result) => {
        const at = now(),
          cipher = await seal(result, env.MASTER_KEY, `ai-call:${callId}`);
        const [saved] = await env.DB.batch([
          env.DB.prepare(
            `UPDATE ai_calls SET status='done',updated_at=? WHERE id=? AND status='running' ${fence ? `AND ${fence.sql}` : ""}`,
          ).bind(dbTime(at), callId, ...(fence?.values ?? [])),
          ...callResultStatements(env.DB, callId, cipher, {
            sql: `EXISTS(SELECT 1 FROM ai_calls WHERE id=? AND status='done' AND updated_at=? ${fence ? `AND ${fence.sql}` : ""})`,
            values: [callId, dbTime(at), ...(fence?.values ?? [])],
          }),
        ]);
        if (!saved.meta.changes) throw new Error("MODEL_CALL_DISCARDED");
      },
    );
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]+$/.test((error as Error).message)
      ? (error as Error).message
      : "MODEL_CALL_OUTCOME_UNKNOWN";
    await env.DB.prepare(
      "UPDATE ai_calls SET status=?,error=?,updated_at=? WHERE id=? AND status<>'done'",
    )
      .bind(
        code.includes("QUOTA") ||
          [
            "WORKERS_AI_FREE_LIMIT",
            "WORKERS_AI_PAID_MODEL",
            "MODEL_REGION_REQUIRES_DEPLOYMENT",
            "MODEL_GATEWAY_NOT_CONFIGURED",
          ].includes(code)
          ? "failed"
          : "unknown",
        code,
        dbTime(now()),
        callId,
      )
      .run();
    throw error;
  } finally {
    if (!operationId)
      await env.DB.prepare("DELETE FROM call_results WHERE id=?").bind(callId).run();
  }
}
// Called exclusively by the region-bound Durable Object's alarm.
export async function performInference(
  env: AppEnv,
  id: string,
  version: number,
  request: Inference,
  runId: string | null = null,
  userId: string,
  reservationId: string,
  callId?: string,
  preview?: DraftTarget,
) {
  const inferenceStartedAt = now();
  if (
    !(await env.DB.prepare(
      "SELECT id FROM quota_reservations WHERE id=? AND user_id=? AND kind='model'",
    )
      .bind(reservationId, userId)
      .first())
  )
    throw new Error("MODEL_RESERVATION_REQUIRED");
  const { profile } = await getModelProfile(env, id, version, userId);
  const row = await env.DB.prepare(
    "SELECT * FROM model_connections WHERE id=? AND (owner_user_id IS NULL OR owner_user_id=?)",
  )
    .bind(profile.connectionId!, userId)
    .first<Row>();
  if (!row) throw Error("MODEL_CONNECTION_NOT_FOUND");
  const connection = connectionFrom(row);
  if (connection.kind === "custom") await validateEndpoint(connection.upstream);
  const gateway = gatewayTransport(env, connection, profile.model);
  if (request.imageRef && request.image) throw Error("IMAGE_REFERENCE_INVALID");
  if (request.imageRef && !profile.capabilities.vision) throw Error("VISION_NOT_SUPPORTED");
  const { imageRef, ...wire } = request;
  if (imageRef) wire.image = await resolveModelImage(env, imageRef, runId, userId);
  const providerStartedAt = now();
  const disabled =
    (
      await env.DB.prepare("SELECT value FROM settings WHERE key='chatPreviewEnabled'").first<{
        value: string;
      }>()
    )?.value === "0";
  const publisher = draftPublisher(
    env,
    userId,
    callId ?? reservationId,
    disabled ? undefined : preview,
  );
  let result: ModelResponse;
  let first = true;
  try {
    result = await infer(
      { ...profile, baseUrl: gateway.baseUrl },
      "",
      wire,
      gateway.fetch,
      async (text) => {
        if (first) {
          first = false;
          await env.DB.prepare("UPDATE ai_calls SET first_delta_at=? WHERE id=? AND user_id=?")
            .bind(dbTime(now()), callId ?? reservationId, userId)
            .run();
        }
        await publisher.text(text);
      },
    );
    await publisher.end();
  } catch (error) {
    await publisher.end(true);
    throw error;
  }
  await recordUsage(env, profile, result, runId, userId, {
    callId: reservationId,
    inferenceStartedAt,
    providerStartedAt,
  });
  return result;
}
// Only received, invalid output can spend the repair budget. Transport failures
// propagate without retry; every attempt retains the regional alarm egress and usage path.
export async function generateStructured<T>(
  env: AppEnv,
  id: string,
  version: number,
  schema: Record<string, unknown>,
  validate: (value: unknown) => T | Promise<T>,
  messages: Inference["messages"],
  runId: string | null = null,
  invalidCode = "MODEL_INVALID_JSON",
  operationId?: string,
  graphId?: string,
  media?: {
    image?: string;
    imageRef?: Inference["imageRef"];
    format?: "schema" | "json";
    wireSchema?: Record<string, unknown>;
  },
  graphGeneration?: number,
  preview?: DraftTarget,
): Promise<{ data: T; response: ModelResponse }> {
  const { profile } = await getModelProfile(env, id, version);
  if (profile.capabilities.structured === "none") throw new Error("STRUCTURED_OUTPUT_REQUIRED");
  if (media?.format === "schema" && profile.capabilities.structured !== "schema")
    throw Error("STRUCTURED_SCHEMA_REQUIRED");
  const mode = media?.format ?? profile.capabilities.structured;
  const format = mode === "schema" ? { schema: media?.wireSchema ?? schema } : { jsonMode: true };
  const instructions: Inference["messages"] =
    mode === "json"
      ? [
          {
            role: "system",
            content:
              "只返回符合以下 JSON Schema 的 JSON，不要输出 Markdown：" + JSON.stringify(schema),
          },
          ...messages,
        ]
      : messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await invoke(
      env,
      id,
      version,
      {
        messages: attempt
          ? [
              ...instructions,
              {
                role: "user",
                content:
                  "输出未通过格式校验。仅返回符合以下 JSON Schema 的 JSON，不要改写原始输入中的密码或验证码：" +
                  JSON.stringify(schema),
              },
            ]
          : instructions,
        ...format,
        ...(media?.image ? { image: media.image } : {}),
        ...(media?.imageRef ? { imageRef: media.imageRef } : {}),
        maxTokens: profile.outputTokens ?? 4096,
      },
      runId,
      operationId ? `${operationId}:${attempt}` : undefined,
      graphId,
      graphGeneration,
      preview ? { ...preview, version: attempt } : undefined,
    );
    try {
      return { data: await validate(JSON.parse(response.text)), response };
    } catch {
      if (attempt) throw new Error(invalidCode);
    }
  }
  throw new Error(invalidCode);
}

/** 用无业务内容的独立调用确定流式能力；探测失败不会重放用户请求。 */
async function ensureStreaming(
  env: AppEnv,
  id: string,
  version: number,
  request: Inference,
  userId: string,
) {
  const kind = streamKind(request);
  const { profile } = await getModelProfile(env, id, version);
  if (profile.capabilities.streaming?.[kind]) return;
  const shape = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };
  const probe: Inference = {
    messages: [
      {
        role: "user",
        content:
          kind === "tools"
            ? "Call check with ok true."
            : kind === "structured"
              ? 'Return JSON {"ok":true}.'
              : "Reply OK.",
      },
    ],
    maxTokens: 512,
    ...(kind === "tools"
      ? {
          tools: [{ name: "check", description: "Capability test", parameters: shape }],
          toolChoice: request.toolChoice,
        }
      : {}),
    ...(kind === "structured" ? (request.schema ? { schema: shape } : { jsonMode: true }) : {}),
  };
  const validateProbe = (response: ModelResponse) => {
    try {
      if (kind === "tools") {
        if (
          response.calls.length !== 1 ||
          response.calls[0].name !== "check" ||
          JSON.parse(response.calls[0].arguments).ok !== true
        )
          throw Error();
      } else if (kind === "structured") {
        if (JSON.parse(response.text).ok !== true) throw Error();
      } else if (!response.text.trim()) throw Error();
    } catch {
      throw Error("MODEL_STREAM_INVALID");
    }
  };
  let state: "supported" | "unsupported" = "supported";
  try {
    const response = await invoke({ ...env, requestUserId: userId }, id, version, {
      ...probe,
      stream: true,
    });
    validateProbe(response);
  } catch (error) {
    if (
      !["MODEL_STREAM_UNSUPPORTED", "MODEL_HTTP_400", "MODEL_HTTP_422"].includes(
        (error as Error).message,
      )
    )
      throw error;
    // 非流式控制探测成功后才能确认能力缺失，鉴权/网络失败仍保留未知。
    validateProbe(
      await invoke({ ...env, requestUserId: userId }, id, version, { ...probe, stream: false }),
    );
    state = "unsupported";
  }
  await env.DB.prepare(
    "UPDATE model_profile_versions SET capabilities=json_set(capabilities,?,?) WHERE id=? AND version=? AND connection_id IS NOT NULL",
  )
    .bind(`$.streaming.${kind}`, state, id, version)
    .run();
}
export async function generate<T>(
  env: AppEnv,
  id: string,
  version: number,
  schema: z.ZodType<T>,
  messages: Inference["messages"],
  runId: string | null = null,
  operationId?: string,
  graph?: { id: string; generation: number },
) {
  const { RelayChatModel } = await import("./ai/model");
  const { toLangChainMessages } = await import("../../../packages/model/src/langchain");
  return (await new RelayChatModel(
    env,
    id,
    version,
    operationId,
    runId,
    graph?.id,
    graph?.generation,
  )
    .withStructuredOutput(schema)
    .invoke(toLangChainMessages(messages))) as T;
}
/** Probes share the production LangChain interface while testing explicit formats. */
async function probeInference(
  env: AppEnv,
  id: string,
  version: number,
  request: Inference,
): Promise<ModelResponse> {
  const { RelayChatModel } = await import("./ai/model");
  const { toLangChainMessages, aiMessageToModelResponse } =
    await import("../../../packages/model/src/langchain");
  const { messages, toolChoice, ...options } = request;
  return aiMessageToModelResponse(
    await new RelayChatModel(env, id, version).invoke(toLangChainMessages(messages), {
      ...options,
      capabilityProbe: true,
      // 与桌面工具循环一致，仍由实际返回的函数名和参数决定是否通过。
      tool_choice: toolChoice ?? (request.tools?.length ? "auto" : undefined),
    }),
  );
}
export async function probe(env: AppEnv, id: string, version: number): Promise<ModelCapabilities> {
  const caps: ModelCapabilities = {
    connection: false,
    tools: false,
    structured: "none",
    vision: false,
    testedAt: now(),
  };
  const errors: string[] = [];
  await getModelProfile(env, id, version);
  try {
    const answer = await probeInference(env, id, version, {
      messages: [{ role: "user", content: "What is 17 + 25? Reply with just the number." }],
      maxTokens: 512,
    });
    if (answer.text.trim() !== "42") throw Error("MODEL_ANSWER_INCORRECT");
    caps.connection = true;
  } catch (e) {
    errors.push((e as Error).message);
  }
  if (caps.connection) {
    try {
      const r = await probeInference(env, id, version, {
        messages: [{ role: "user", content: "Call check with value 7." }],
        tools: [
          {
            name: "check",
            description: "Connection test",
            parameters: {
              type: "object",
              properties: { value: { type: "integer" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        ],
      });
      caps.tools =
        r.calls.length === 1 &&
        r.calls[0].name === "check" &&
        JSON.parse(r.calls[0].arguments).value === 7;
    } catch {
      errors.push("TOOLS_UNSUPPORTED");
    }
    const shape = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    };
    try {
      const r = await probeInference(env, id, version, {
        messages: [{ role: "user", content: "Return JSON with ok true." }],
        schema: shape,
      });
      if (JSON.parse(r.text).ok === true) caps.structured = "schema";
    } catch {
      /* Explicitly probe JSON mode below. */
    }
    if (caps.structured === "none")
      try {
        const r = await probeInference(env, id, version, {
          messages: [{ role: "user", content: 'Return JSON {"ok":true}.' }],
          jsonMode: true,
        });
        if (JSON.parse(r.text).ok === true) caps.structured = "json";
      } catch {
        errors.push("STRUCTURED_OUTPUT_UNSUPPORTED");
      }
  }
  caps.questionAnswered = caps.connection;
  if (caps.connection && !caps.tools && !errors.includes("TOOLS_UNSUPPORTED"))
    errors.push("TOOLS_UNSUPPORTED");
  if (
    caps.connection &&
    caps.structured === "none" &&
    !errors.includes("STRUCTURED_OUTPUT_UNSUPPORTED")
  )
    errors.push("STRUCTURED_OUTPUT_UNSUPPORTED");
  if (errors.length) caps.error = errors.join(",");
  await env.DB.prepare(
    "UPDATE model_profile_versions SET capabilities=json_patch(capabilities,?) WHERE id=? AND version=? AND connection_id IS NOT NULL",
  )
    .bind(JSON.stringify({ ...caps, vision: undefined, error: caps.error ?? null }), id, version)
    .run();
  return caps;
}
export async function storeModel(
  env: AppEnv,
  input: Record<string, unknown>,
  id = uid("model"),
  expectedVersion?: number,
) {
  const { modelInputSchema } = await import("../../../packages/contracts/src/index");
  const parsed = modelInputSchema.parse(input);
  const connection = await env.DB.prepare(
    "SELECT * FROM model_connections WHERE id=? AND owner_user_id IS NULL",
  )
    .bind(parsed.connectionId)
    .first<Row>();
  if (!connection) throw Error("MODEL_CONNECTION_NOT_FOUND");
  if (
    connection.kind === "workers-ai" &&
    !/^@cf\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(parsed.model)
  )
    throw Error("WORKERS_AI_MODEL_INVALID");
  const prior = await env.DB.prepare(
    "SELECT m.current_version AS version FROM models m JOIN model_profile_versions v ON v.id=m.id AND v.version=m.current_version WHERE m.id=? AND m.owner_user_id IS NULL AND v.connection_id IS NOT NULL",
  )
    .bind(id)
    .first<{ version: number }>();
  if (expectedVersion && !prior) throw Error("RESOURCE_VERSION_CONFLICT");
  const version = (prior?.version ?? 0) + 1;
  const config = parsed;
  const capabilities: ModelCapabilities = {
    connection: false,
    tools: false,
    structured: "none",
    vision: false,
    testedAt: null,
  };
  const writes = await env.DB.batch<{
    effective_region: import("../../../packages/contracts/src/index").EgressRegion;
  }>([
    env.DB.prepare(
      `INSERT INTO models(id,current_version,created_at,enabled) SELECT ?,?,?,0 WHERE ?=0 OR EXISTS(SELECT 1 FROM models WHERE id=? AND current_version=?)
    ON CONFLICT(id) DO UPDATE SET current_version=excluded.current_version WHERE models.owner_user_id IS NULL AND models.current_version=? AND (? IS NULL OR models.management_version=?)`,
    ).bind(
      id,
      version,
      dbTime(now()),
      prior?.version ?? 0,
      id,
      prior?.version ?? 0,
      prior?.version ?? 0,
      expectedVersion ?? null,
      expectedVersion ?? null,
    ),
    env.DB.prepare(
      `INSERT INTO model_profile_versions(id,version,config,connection_id,effective_region,capabilities,created_at)
       SELECT ?,?,?,id,CASE WHEN ?='inherit' THEN default_region ELSE ? END,?,? FROM model_connections WHERE id=? AND owner_user_id IS NULL AND changes()=1 RETURNING effective_region`,
    ).bind(
      id,
      version,
      JSON.stringify(config),
      parsed.region,
      parsed.region,
      JSON.stringify(capabilities),
      dbTime(now()),
      parsed.connectionId,
    ),
  ]);
  const stored = writes[1].results[0];
  if (!writes[0].meta.changes || !stored) throw Error("RESOURCE_VERSION_CONFLICT");
  return { id, version, ...config, effectiveRegion: stored.effective_region, capabilities };
}
export async function probeVision(env: AppEnv, id: string, version?: number) {
  const { profile } = await getModelProfile(env, id, version);
  let vision = false;
  try {
    const r = await probeInference(env, id, profile.version, {
      messages: [
        {
          role: "user",
          content:
            "What is the single solid color in this image? Reply with only the English color name.",
        },
      ],
      image: visionFixture,
      maxTokens: 128,
    });
    vision = /^\s*(red|红色)[.!。]?\s*$/i.test(r.text);
  } catch {
    /* Independent optional capability; text capabilities remain unchanged. */
  }
  const capabilities = {
    ...profile.capabilities,
    vision,
    visionTestedAt: now(),
  };
  await env.DB.prepare(
    "UPDATE model_profile_versions SET capabilities=json_patch(capabilities,?) WHERE id=? AND version=? AND connection_id IS NOT NULL",
  )
    .bind(
      JSON.stringify({ vision, visionTestedAt: capabilities.visionTestedAt }),
      id,
      profile.version,
    )
    .run();
  return capabilities;
}
