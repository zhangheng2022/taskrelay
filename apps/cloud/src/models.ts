import { z } from "zod";
import {
  infer,
  type Inference,
  type ModelResponse,
} from "../../../packages/model/src/index";
import { publicEndpoint } from "../../../packages/contracts/src/security";
import type {
  ModelCapabilities,
  ModelProfile,
} from "../../../packages/contracts/src/index";
import type { AppEnv } from "./env";
import { seal, unseal } from "./crypto";
import { now, uid, type Row } from "./store";
import { visionFixture } from "./vision-fixture";
import { egress } from "./egress";

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
        return (data.Answer ?? [])
          .filter((x) => x.type === 1 || x.type === 28)
          .map((x) => x.data);
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
    key: await unseal<string>(
      row.secret,
      env.MASTER_KEY,
      `model:${id}:${row.version}`,
    ),
  };
}
export async function recordUsage(
  env: AppEnv,
  profile: ModelProfile,
  response: ModelResponse,
  runId: string | null,
) {
  await env.DB.prepare(
    "INSERT INTO model_usage(id,run_id,model_id,model_version,input_tokens,output_tokens,at) VALUES(?,?,?,?,?,?,?)",
  )
    .bind(
      uid("usage"),
      runId,
      profile.id,
      profile.version,
      response.usage.input,
      response.usage.output,
      now(),
    )
    .run();
}
export async function invoke(
  env: AppEnv,
  id: string,
  version: number,
  request: Inference,
  runId: string | null = null,
) {
  return egress<ModelResponse>(env, {
    kind: "inference",
    modelId: id,
    version,
    request,
    runId,
  });
}
// Called exclusively by the region-bound Durable Object's alarm.
export async function performInference(
  env: AppEnv,
  id: string,
  version: number,
  request: Inference,
  runId: string | null = null,
) {
  const { profile, key } = await getModel(env, id, version);
  await validateEndpoint(profile.baseUrl);
  const result = await infer(profile, key, request);
  await recordUsage(env, profile, result, runId);
  return result;
}
export async function generate<T>(
  env: AppEnv,
  id: string,
  version: number,
  schema: z.ZodType<T>,
  messages: Inference["messages"],
  runId: string | null = null,
) {
  const { profile, key } = await getModel(env, id, version);
  await validateEndpoint(profile.baseUrl);
  if (profile.capabilities.structured === "none")
    throw new Error("STRUCTURED_OUTPUT_REQUIRED");
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await invoke(
      env,
      id,
      version,
      {
        messages: attempt
          ? [
              ...messages,
              {
                role: "user",
                content:
                  "输出未通过格式校验，仅返回符合 JSON Schema 的 JSON：" +
                  JSON.stringify(json),
              },
            ]
          : messages,
        ...(profile.capabilities.structured === "schema"
          ? { schema: json }
          : { jsonMode: true }),
      },
      runId,
    );
    try {
      return schema.parse(JSON.parse(response.text));
    } catch {
      if (attempt) throw new Error("MODEL_INVALID_JSON");
    }
  }
  throw new Error("MODEL_INVALID_JSON");
}
export async function probe(
  env: AppEnv,
  id: string,
  version: number,
): Promise<ModelCapabilities> {
  const caps: ModelCapabilities = {
    connection: false,
    tools: false,
    structured: "none",
    vision: false,
    testedAt: now(),
  };
  const errors: string[] = [];
  const { profile } = await getModel(env, id, version);
  caps.tokenParameter =
    profile.capabilities.tokenParameter ?? "max_completion_tokens";
  try {
    try {
      await invoke(env, id, version, {
        messages: [{ role: "user", content: "Reply OK." }],
        maxTokens: 512,
      });
    } catch (error) {
      if (
        profile.protocol !== "chat" ||
        (error as Error).message !== "MODEL_HTTP_400"
      )
        throw error;
      caps.tokenParameter = "max_tokens";
      await invoke(env, id, version, {
        messages: [{ role: "user", content: "Reply OK." }],
        maxTokens: 512,
        tokenParameter: "max_tokens",
      });
    }
    caps.connection = true;
    await env.DB.prepare(
      "UPDATE model_profiles SET capabilities=? WHERE id=? AND version=?",
    )
      .bind(JSON.stringify(caps), id, version)
      .run();
  } catch (e) {
    errors.push((e as Error).message);
  }
  if (caps.connection) {
    try {
      const r = await invoke(env, id, version, {
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
      const r = await invoke(env, id, version, {
        messages: [{ role: "user", content: "Return JSON with ok true." }],
        schema: shape,
      });
      if (JSON.parse(r.text).ok === true) caps.structured = "schema";
    } catch {
      /* Explicitly probe JSON mode below. */
    }
    if (caps.structured === "none")
      try {
        const r = await invoke(env, id, version, {
          messages: [{ role: "user", content: 'Return JSON {"ok":true}.' }],
          jsonMode: true,
        });
        if (JSON.parse(r.text).ok === true) caps.structured = "json";
      } catch {
        errors.push("STRUCTURED_OUTPUT_UNSUPPORTED");
      }
  }
  if (errors.length) caps.error = errors.join(",");
  await env.DB.prepare(
    "UPDATE model_profiles SET capabilities=? WHERE id=? AND version=?",
  )
    .bind(JSON.stringify(caps), id, version)
    .run();
  return caps;
}
export async function storeModel(
  env: AppEnv,
  input: Record<string, unknown>,
  id = uid("model"),
) {
  const { modelInputSchema } =
    await import("../../../packages/contracts/src/index");
  const parsed = modelInputSchema.parse(input);
  // Accept a pasted endpoint, but store a base URL and never append it twice.
  const endpoint = new URL(parsed.baseUrl);
  const suffix = endpoint.pathname.match(/\/(chat\/completions|responses)\/?$/);
  if (suffix) {
    if ((suffix[1] === "responses") !== (parsed.protocol === "responses"))
      throw new Error("MODEL_PROTOCOL_MISMATCH");
    endpoint.pathname = endpoint.pathname.slice(0, -suffix[0].length) || "/";
  }
  if (endpoint.search || endpoint.hash)
    throw new Error("MODEL_BASE_URL_INVALID");
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
  const { profile } = await getModel(env, id);
  let vision = false;
  try {
    const r = await invoke(env, id, profile.version, {
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
    "UPDATE model_profiles SET capabilities=? WHERE id=? AND version=?",
  )
    .bind(JSON.stringify(capabilities), id, profile.version)
    .run();
  return capabilities;
}
