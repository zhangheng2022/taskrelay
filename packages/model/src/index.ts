/**
 * 模型协议适配：官方 OpenAI SDK 承接 Responses，集中处理兼容服务差异。
 * 仅由区域出站入口调用，SDK 不重试、不记录正文；边界负责禁止重定向、超时、大小限制与固定错误。
 */
import type { ModelProfile } from "../../contracts/src/index";
import { outputSchema } from "./schema";
import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { readModelStream, boundedStream } from "./stream";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  content_blocks?: Array<
    { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
  >;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface Inference {
  messages: Message[];
  image?: string;
  imageRef?: { artifactId: string; epoch: number };
  tools?: Tool[];
  toolChoice?: "auto" | "required";
  schema?: Record<string, unknown>;
  jsonMode?: boolean;
  maxTokens?: number;
  /** 仅内部能力探测指定；普通调用由固定配置版本的能力决定。 */
  stream?: boolean;
}
export interface ModelResponse {
  text: string;
  calls: { id: string; name: string; arguments: string }[];
  usage: { input: number | null; output: number | null };
  structured?: unknown;
}
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
class ModelBoundaryError extends Error {}
export async function infer(
  profile: { baseUrl: string } & Pick<ModelProfile, "protocol" | "model"> &
    Partial<Pick<ModelProfile, "capabilities">>,
  key: string,
  request: Inference,
  fetcher: Fetcher = fetch,
  onText?: (text: string) => Promise<void>,
): Promise<ModelResponse> {
  if (profile.protocol !== "responses") throw Error("MODEL_PROTOCOL_RETIRED");
  if (request.imageRef) throw Error("IMAGE_REFERENCE_UNRESOLVED");
  // 从尾部单次扫描，避免未匹配的长斜杠序列触发正则反复回溯。
  let end = profile.baseUrl.length;
  while (end > 0 && profile.baseUrl[end - 1] === "/") end--;
  const root = profile.baseUrl.slice(0, end);
  const streaming =
    request.stream ?? profile.capabilities?.streaming?.[streamKind(request)] === "supported";
  const input: unknown[] = [];
  for (const m of request.messages) {
    if (m.role === "tool")
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: m.content,
      });
    else if (m.role === "assistant" && m.tool_calls?.length) {
      if (m.content) input.push({ role: "assistant", content: m.content });
      for (const t of m.tool_calls as {
        id: string;
        function: { name: string; arguments: string };
      }[])
        input.push({
          type: "function_call",
          call_id: t.id,
          name: t.function.name,
          arguments: t.function.arguments,
        });
    } else
      input.push({
        role: m.role,
        content:
          m.content_blocks?.map((part) =>
            part.type === "text"
              ? { type: m.role === "assistant" ? "output_text" : "input_text", text: part.text }
              : { type: "input_image", image_url: part.image_url.url, detail: "low" },
          ) ?? m.content,
      });
  }
  const body: Record<string, unknown> = {
    model: profile.model,
    input,
    store: false,
    max_output_tokens: request.maxTokens ?? 4096,
  };
  if (request.image)
    input.push({
      role: "user",
      content: [{ type: "input_image", image_url: request.image, detail: "low" }],
    });
  if (request.tools?.length) {
    body.tools = request.tools.map((t) => ({
      type: "function",
      ...t,
      parameters: outputSchema(t.parameters),
      strict: true,
    }));
    body.tool_choice = request.toolChoice ?? "required";
    body.parallel_tool_calls = false;
  }
  if (request.schema)
    body.text = {
      format: {
        type: "json_schema",
        name: "result",
        strict: true,
        schema: outputSchema(request.schema),
      },
    };
  else if (request.jsonMode) body.text = { format: { type: "json_object" } };
  // SDK 只在 ModelEgress 的 alarm 内创建；禁用环境默认账号与日志，避免额外凭据和正文外流。
  if (streaming) body.stream = true;
  // fetch 边界同时覆盖响应正文读取，SDK 的连接超时不能代替整个请求的时间限制。
  let transportFailure: string | undefined;
  // SDK 要求非空凭据；无密钥兼容端点使用占位值，并在网络边界删除整个 Authorization。
  const client = new OpenAI({
    apiKey: key || "taskrelay-keyless-endpoint",
    baseURL: root,
    organization: null,
    project: null,
    adminAPIKey: null,
    maxRetries: 0,
    timeout: 60_000,
    logLevel: "off",
    fetch: async (input, init) => {
      const signal = AbortSignal.any([
        ...(init?.signal ? [init.signal] : []),
        AbortSignal.timeout(60_000),
      ]);
      try {
        const headers = new Headers(init?.headers);
        if (!key) headers.delete("authorization");
        const response = await fetcher(input instanceof Request ? input.url : input.toString(), {
          ...init,
          headers,
          redirect: "manual",
          signal,
        });
        if (streaming && response.ok) {
          if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
            await response.body?.cancel();
            throw new ModelBoundaryError("MODEL_STREAM_UNSUPPORTED");
          }
          return boundedStream(response, signal, (code) => {
            transportFailure = code;
          });
        }
        return await boundedResponse(response, signal);
      } catch (error) {
        transportFailure = signal.aborted
          ? "MODEL_TIMEOUT"
          : error instanceof ModelBoundaryError
            ? error.message
            : "MODEL_CALL_OUTCOME_UNKNOWN";
        throw new Error(transportFailure);
      }
    },
  });
  try {
    if (streaming) return await readModelStream(client, body, onText);
    const data = await client.responses.create(body as unknown as ResponseCreateParamsNonStreaming);
    if (!data || !Array.isArray(data.output)) throw new ModelBoundaryError("MODEL_EMPTY_RESPONSE");
    // 部分兼容服务省略 object:'response'，SDK 不生成 output_text；集中保留这一个兼容分支。
    const text =
      data.output_text ??
      data.output
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content)
        .filter((part) => part.type === "output_text")
        .map((part) => part.text)
        .join("\n");
    return {
      text,
      calls: data.output
        .filter((item) => item.type === "function_call")
        .map((item) => ({ id: item.call_id, name: item.name, arguments: item.arguments })),
      usage: { input: data.usage?.input_tokens ?? null, output: data.usage?.output_tokens ?? null },
    };
  } catch (error) {
    // 不把 SDK APIError（可能包含请求密钥或上游回显）交给日志、调用方或诊断包。
    if (transportFailure) throw Error(transportFailure);
    if (error instanceof OpenAI.APIError)
      throw Error(
        error.status ? httpError(error.status, error.code) : "MODEL_CALL_OUTCOME_UNKNOWN",
      );
    if (error instanceof ModelBoundaryError) throw error;
    if (
      error instanceof Error &&
      ["MODEL_STREAM_INCOMPLETE", "MODEL_STREAM_INVALID"].includes(error.message)
    )
      throw Error(error.message);
    throw Error("MODEL_INVALID_RESPONSE");
  }
}

export function streamKind(request: Inference): "text" | "tools" | "structured" {
  return request.schema || request.jsonMode
    ? "structured"
    : request.tools?.length
      ? "tools"
      : "text";
}

function httpError(status: number, code: unknown) {
  const suffix = (
    {
      unsupported_country_region_territory: "UNSUPPORTED_REGION",
      model_not_found: "MODEL_UNAVAILABLE",
      invalid_api_key: "INVALID_KEY",
      insufficient_quota: "QUOTA",
      permission_denied: "PERMISSION",
      organization_restricted: "ORGANIZATION_RESTRICTED",
      access_terminated: "ACCOUNT_RESTRICTED",
    } as Record<string, string>
  )[typeof code === "string" ? code.toLowerCase() : ""];
  return `MODEL_HTTP_${status}${suffix ? "_" + suffix : ""}`;
}

async function boundedResponse(response: Response, signal: AbortSignal): Promise<Response> {
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new ModelBoundaryError("MODEL_REDIRECT_BLOCKED");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ModelBoundaryError("MODEL_EMPTY_RESPONSE");
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > (response.ok ? 2_000_000 : 64_000))
        throw new ModelBoundaryError(
          response.ok ? "MODEL_RESPONSE_TOO_LARGE" : `MODEL_HTTP_${response.status}`,
        );
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  // 兼容提供方可能未带 JSON Content-Type；只允许经过大小限制的 JSON 交给 SDK。
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    // Cloudflare REST 与兼容协议的错误信封不同；仅返回已知分类，避免 SDK 丢失计费错误。
    if (!response.ok) {
      const code = Number(body?.errors?.[0]?.code ?? body?.error?.code);
      if (code === 3036 && response.status === 429)
        throw new ModelBoundaryError("WORKERS_AI_FREE_LIMIT");
      if (code === 5035 && response.status === 403)
        throw new ModelBoundaryError("WORKERS_AI_PAID_MODEL");
      if (code === 2009 && response.status === 401)
        throw new ModelBoundaryError("MODEL_HTTP_401_INVALID_KEY");
    }
  } catch (error) {
    if (error instanceof ModelBoundaryError) throw error;
    throw new ModelBoundaryError(
      response.ok ? "MODEL_INVALID_RESPONSE" : `MODEL_HTTP_${response.status}_GATEWAY_DENIED`,
    );
  }
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Response(bytes, { status: response.status, headers });
}
