/**
 * 模型服务入口：管理配置版本、能力探测、调用去重、结构化校验与实际用量。
 * 普通调用只提交加密出站作业；仅美国区域 ModelEgress 的 alarm 可调用提供方适配器。
 */
import { reserve } from "./tenancy";
import { resolveModelImage } from "./images";
import { z } from "zod";
import { infer, type Inference, type ModelResponse } from "../../../packages/model/src/index";
import { publicEndpoint } from "../../../packages/contracts/src/security";
import type { ModelCapabilities, ModelProfile } from "../../../packages/contracts/src/index";
import type { AppEnv } from "./env";
import { seal, unseal } from "./crypto";
import { now, uid, type Row } from "./store";
import { visionFixture } from "./vision-fixture";
import { egress } from "./egress";
import { hash } from "../../../packages/contracts/src/security";
import { graphWriteFence } from "./ai/fence";

export async function validateEndpoint(baseUrl: string) {
  return publicEndpoint(baseUrl, async (host) => {
    const results = await Promise.all(
      ["A", "AAAA"].map(async (type) => {
        const response = await fetch(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
          {
            headers: { accept: "application/dns-json" },
            redirect: "manual",
            signal: AbortSignal.timeout(10000),
          },
        );
        if (!response.ok) throw new Error("DNS_LOOKUP_FAILED");
        const data = (await response.json()) as {
          Status: number;
          Answer?: { type: number; data: string }[];
        };
        if (data.Status !== 0) throw new Error("DNS_LOOKUP_FAILED");
        return (data.Answer ?? []).filter((x) => x.type === 1 || x.type === 28).map((x) => x.data);
      }),
    );
    return results.flat();
  });
}
export function modelFrom(row: Row): ModelProfile {
  return {
    ...JSON.parse(row.config),
    id: row.id,
    version: row.version,
    hasKey: true,
    capabilities: JSON.parse(row.capabilities),
  };
}
export async function getModel(env: AppEnv, id: string, version?: number) {
  const row = await env.DB.prepare(
    `SELECT * FROM model_profiles WHERE id=? ${version ? "AND version=?" : ""} ORDER BY version DESC LIMIT 1`,
  )
    .bind(...(version ? [id, version] : [id]))
    .first<Row>();
  if (!row) throw new Error("MODEL_NOT_FOUND");
  return {
    profile: modelFrom(row),
    key: await unseal<string>(row.secret, env.MASTER_KEY, `model:${id}:${row.version}`),
  };
}
/** Configuration checks do not need to read or decrypt provider credentials. */
export async function getModelProfile(env: AppEnv, id: string, version?: number) {
  const row = await env.DB.prepare(
    `SELECT id,version,config,capabilities FROM model_profiles WHERE id=? ${version ? "AND version=?" : ""} ORDER BY version DESC LIMIT 1`,
  )
    .bind(...(version ? [id, version] : [id]))
    .first<Row>();
  if (!row) throw new Error("MODEL_NOT_FOUND");
  return { profile: modelFrom(row) };
}
export async function recordUsage(
  env: AppEnv,
  profile: ModelProfile,
  response: ModelResponse,
  runId: string | null,
  userId: string,
) {
  await env.DB.prepare(
    "INSERT INTO model_usage(id,run_id,model_id,model_version,input_tokens,output_tokens,at,user_id) VALUES(?,?,?,?,?,?,?,?)",
  )
    .bind(
      uid("usage"),
      runId,
      profile.id,
      profile.version,
      response.usage.input,
      response.usage.output,
      now(),
      userId,
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
) {
  const userId = runId
    ? (
        await env.DB.prepare("SELECT user_id FROM runs WHERE id=?")
          .bind(runId)
          .first<{ user_id: string }>()
      )?.user_id
    : env.requestUserId;
  if (!userId) throw new Error("MODEL_ACTOR_REQUIRED");
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
    .bind(callId, userId, graphId ?? null, runId, digest, now(), now(), ...(fence?.values ?? []))
    .run();
  if (!inserted.meta.changes) {
    // A deduplicated result still belongs to its original live graph. Replaying
    // an operation must not bypass deletion, cancellation, or generation fences.
    const prior = await env.DB.prepare(
      `SELECT * FROM ai_calls WHERE id=? ${fence ? `AND ${fence.sql}` : ""}`,
    )
      .bind(callId, ...(fence?.values ?? []))
      .first<Row>();
    if (!prior && fence) throw Error("MODEL_CALL_DISCARDED");
    if (!prior || prior.user_id !== userId || prior.digest !== digest)
      throw new Error("MODEL_CALL_CONFLICT");
    if (prior.status === "done" && prior.result)
      return unseal<ModelResponse>(prior.result, env.MASTER_KEY, `ai-call:${callId}`);
    throw new Error(prior.status === "failed" ? prior.error : "MODEL_CALL_OUTCOME_UNKNOWN");
  }
  try {
    const reservationId = await reserve(env, userId, "model", callId);
    await env.DB.prepare("UPDATE ai_calls SET status='running',updated_at=? WHERE id=?")
      .bind(now(), callId)
      .run();
    return await egress<ModelResponse>(
      env,
      {
        kind: "inference",
        userId,
        reservationId,
        modelId: id,
        version,
        request,
        runId,
      },
      async (result) => {
        const saved = await env.DB.prepare(
          `UPDATE ai_calls SET status='done',result=?,updated_at=? WHERE id=? AND status='running' ${fence ? `AND ${fence.sql}` : ""}`,
        )
          .bind(
            await seal(result, env.MASTER_KEY, `ai-call:${callId}`),
            now(),
            callId,
            ...(fence?.values ?? []),
          )
          .run();
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
        code.includes("QUOTA") || code === "MODEL_REGION_REQUIRES_DEPLOYMENT"
          ? "failed"
          : "unknown",
        code,
        now(),
        callId,
      )
      .run();
    throw error;
  } finally {
    if (!operationId)
      await env.DB.prepare("UPDATE ai_calls SET result=NULL WHERE id=?").bind(callId).run();
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
) {
  if (
    !(await env.DB.prepare(
      "SELECT id FROM quota_reservations WHERE id=? AND user_id=? AND kind='model'",
    )
      .bind(reservationId, userId)
      .first())
  )
    throw new Error("MODEL_RESERVATION_REQUIRED");
  const { profile, key } = await getModel(env, id, version);
  await validateEndpoint(profile.baseUrl);
  if (request.imageRef && request.image) throw Error("IMAGE_REFERENCE_INVALID");
  if (request.imageRef && !profile.capabilities.vision) throw Error("VISION_NOT_SUPPORTED");
  const { imageRef, ...wire } = request;
  if (imageRef) wire.image = await resolveModelImage(env, imageRef, runId, userId);
  const result = await infer(profile, key, wire);
  await recordUsage(env, profile, result, runId, userId);
  return result;
}
// Only received, invalid output can spend the repair budget. Transport failures
// propagate without retry; every attempt retains the US alarm egress and usage path.
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
    );
    try {
      return { data: await validate(JSON.parse(response.text)), response };
    } catch {
      if (attempt) throw new Error(invalidCode);
    }
  }
  throw new Error(invalidCode);
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
      tool_choice: toolChoice ?? (request.tools?.length ? "required" : undefined),
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
  const { profile } = await getModelProfile(env, id, version);
  caps.tokenParameter = profile.capabilities.tokenParameter ?? "max_completion_tokens";
  try {
    try {
      await probeInference(env, id, version, {
        messages: [{ role: "user", content: "Reply OK." }],
        maxTokens: 512,
      });
    } catch (error) {
      if (profile.protocol !== "chat" || (error as Error).message !== "MODEL_HTTP_400") throw error;
      caps.tokenParameter = "max_tokens";
      await probeInference(env, id, version, {
        messages: [{ role: "user", content: "Reply OK." }],
        maxTokens: 512,
        tokenParameter: "max_tokens",
      });
    }
    caps.connection = true;
    await env.DB.prepare("UPDATE model_profiles SET capabilities=? WHERE id=? AND version=?")
      .bind(JSON.stringify(caps), id, version)
      .run();
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
  if (errors.length) caps.error = errors.join(",");
  await env.DB.prepare("UPDATE model_profiles SET capabilities=? WHERE id=? AND version=?")
    .bind(JSON.stringify(caps), id, version)
    .run();
  return caps;
}
export async function storeModel(env: AppEnv, input: Record<string, unknown>, id = uid("model")) {
  const { modelInputSchema } = await import("../../../packages/contracts/src/index");
  const parsed = modelInputSchema.parse(input);
  // Accept a pasted endpoint, but store a base URL and never append it twice.
  const endpoint = new URL(parsed.baseUrl);
  const suffix = endpoint.pathname.match(/\/(chat\/completions|responses)\/?$/);
  if (suffix) {
    if ((suffix[1] === "responses") !== (parsed.protocol === "responses"))
      throw new Error("MODEL_PROTOCOL_MISMATCH");
    endpoint.pathname = endpoint.pathname.slice(0, -suffix[0].length) || "/";
  }
  if (endpoint.search || endpoint.hash) throw new Error("MODEL_BASE_URL_INVALID");
  parsed.baseUrl = endpoint.toString().replace(/\/$/, "");
  try {
    await validateEndpoint(parsed.baseUrl);
  } catch (error) {
    if (/^[A-Z][A-Z0-9_]+$/.test((error as Error).message)) throw error;
    throw new Error("MODEL_DNS_FAILED");
  }
  const prior = await env.DB.prepare(
    "SELECT version FROM model_profiles WHERE id=? ORDER BY version DESC LIMIT 1",
  )
    .bind(id)
    .first<{ version: number }>();
  const version = (prior?.version ?? 0) + 1;
  let key = parsed.apiKey;
  if (!key && prior) key = (await getModel(env, id, prior.version)).key;
  if (!key) throw new Error("API_KEY_REQUIRED");
  const { apiKey: _, ...config } = parsed;
  const capabilities: ModelCapabilities = {
    connection: false,
    tools: false,
    structured: "none",
    vision: false,
    testedAt: null,
  };
  await env.DB.prepare(
    "INSERT INTO model_profiles(id,version,config,secret,capabilities,created_at) VALUES(?,?,?,?,?,?)",
  )
    .bind(
      id,
      version,
      JSON.stringify(config),
      await seal(key, env.MASTER_KEY, `model:${id}:${version}`),
      JSON.stringify(capabilities),
      now(),
    )
    .run();
  return { id, version, ...config, hasKey: true, capabilities };
}
export async function probeVision(env: AppEnv, id: string) {
  const { profile } = await getModelProfile(env, id);
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
  await env.DB.prepare("UPDATE model_profiles SET capabilities=? WHERE id=? AND version=?")
    .bind(JSON.stringify(capabilities), id, profile.version)
    .run();
  return capabilities;
}
