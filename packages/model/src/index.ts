/**
 * 模型协议适配：把统一消息转换为 Chat Completions 或 Responses 请求，并归一化结果。
 * 此模块不决定路由或重试；生产由区域出站入口调用，公开错误仅返回固定分类。
 */
import type { ModelProfile } from "../../contracts/src/index";
import { outputSchema } from "./schema";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  content_blocks?: Array<{type:'text';text:string}|{type:'image_url';image_url:{url:string}}>;
  tool_call_id?: string;
  tool_calls?: Array<{id:string;type:'function';function:{name:string;arguments:string}}>;
}
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface Inference {
  messages: Message[];
  image?: string;
  tools?: Tool[];
  toolChoice?: "auto" | "required";
  schema?: Record<string, unknown>;
  jsonMode?: boolean;
  maxTokens?: number;
  tokenParameter?: "max_tokens" | "max_completion_tokens";
}
export interface ModelResponse {
  text: string;
  calls: { id: string; name: string; arguments: string }[];
  usage: { input: number | null; output: number | null };
  structured?: unknown;
}
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
export async function infer(
  profile: Pick<ModelProfile, "baseUrl" | "protocol" | "model"> &
    Partial<Pick<ModelProfile, "capabilities">>,
  key: string,
  request: Inference,
  fetcher: Fetcher = fetch,
): Promise<ModelResponse> {
  const root = profile.baseUrl.replace(/\/+$/, "");
  const tools = request.tools?.map((t) => ({
    type: "function",
    function: { ...t, parameters:outputSchema(t.parameters), strict: true },
  }));
  let body: Record<string, unknown>;
  if (profile.protocol === "chat") {
    body = {
      model: profile.model,
      messages: request.messages.map(({content_blocks,...message})=>({...message,content:content_blocks??message.content})),
      [request.tokenParameter ??
      profile.capabilities?.tokenParameter ??
      "max_completion_tokens"]: request.maxTokens ?? 4096,
      stream: false,
    };
    if (request.image)
      body.messages = [
        ...(body.messages as unknown[]),
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: request.image } }],
        },
      ];
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = request.toolChoice ?? "required";
      body.parallel_tool_calls = false;
    }
    if (request.schema)
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: "result",
          strict: true,
          schema: outputSchema(request.schema),
        },
      };
    else if (request.jsonMode) body.response_format = { type: "json_object" };
  } else {
    const input: unknown[] = [];
    for (const m of request.messages) {
      if (m.role === "tool")
        input.push({
          type: "function_call_output",
          call_id: m.tool_call_id,
          output: m.content,
        });
      else if (m.role === "assistant" && m.tool_calls?.length) {
        if(m.content)input.push({role:'assistant',content:m.content});
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
      } else input.push({ role: m.role, content: m.content_blocks?.map(part=>part.type==='text'?{type:m.role==='assistant'?'output_text':'input_text',text:part.text}:{type:'input_image',image_url:part.image_url.url,detail:'low'})??m.content });
    }
    body = {
      model: profile.model,
      input,
      store: false,
      max_output_tokens: request.maxTokens ?? 4096,
    };
    if (request.image)
      input.push({
        role: "user",
        content: [
          { type: "input_image", image_url: request.image, detail: "low" },
        ],
      });
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        ...t,
        parameters:outputSchema(t.parameters),
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
  }
  const response = await fetcher(
    `${root}/${profile.protocol === "chat" ? "chat/completions" : "responses"}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (response.status >= 300 && response.status < 400)
    throw new Error("MODEL_REDIRECT_BLOCKED");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("MODEL_EMPTY_RESPONSE");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > (response.ok ? 2_000_000 : 64_000))
        throw new Error(
          response.ok
            ? "MODEL_RESPONSE_TOO_LARGE"
            : `MODEL_HTTP_${response.status}`,
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let data: any;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(
      response.ok
        ? "MODEL_INVALID_RESPONSE"
        : `MODEL_HTTP_${response.status}_GATEWAY_DENIED`,
    );
  }
  if (!response.ok) {
    // Only a fixed classification is exposed. Provider messages can echo credentials.
    const reason = String(data?.error?.code ?? "").toLowerCase();
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
    )[reason];
    throw new Error(
      `MODEL_HTTP_${response.status}${suffix ? "_" + suffix : ""}`,
    );
  }
  if (profile.protocol === "chat") {
    const m = data.choices?.[0]?.message;
    if (!m) throw new Error("MODEL_EMPTY_RESPONSE");
    return {
      text: typeof m.content === "string" ? m.content : "",
      calls: (m.tool_calls ?? []).map((c: any) => ({
        id: c.id,
        name: c.function?.name,
        arguments: c.function?.arguments,
      })),
      usage: {
        input: data.usage?.prompt_tokens ?? null,
        output: data.usage?.completion_tokens ?? null,
      },
    };
  }
  return {
    text: (data.output ?? [])
      .filter((x: any) => x.type === "message")
      .flatMap((x: any) => x.content ?? [])
      .filter((x: any) => x.type === "output_text")
      .map((x: any) => x.text)
      .join("\n"),
    calls: (data.output ?? [])
      .filter((x: any) => x.type === "function_call")
      .map((x: any) => ({
        id: x.call_id,
        name: x.name,
        arguments: x.arguments,
      })),
    usage: {
      input: data.usage?.input_tokens ?? null,
      output: data.usage?.output_tokens ?? null,
    },
  };
}
