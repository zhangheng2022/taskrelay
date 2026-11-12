/** 模型流传输：官方 SDK 解析协议，收齐结束事件后才交付工具与结果；正文预览不代表执行成功。
 * 网络包装逐块计量并传播取消，禁止先缓存整段响应。 */
import type OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses";
import type { ModelResponse } from "./index";

export function boundedStream(
  response: Response,
  signal: AbortSignal,
  fail: (code: string) => void,
) {
  const reader = response.body?.getReader();
  if (!reader) throw Error("MODEL_STREAM_INCOMPLETE");
  let bytes = 0;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => signal.removeEventListener("abort", abort);
  const abort = () => {
    fail("MODEL_TIMEOUT");
    controller.error(Error("MODEL_TIMEOUT"));
    cleanup();
    void reader.cancel().catch(() => {});
  };
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(c) {
      try {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) {
          cleanup();
          c.close();
          return;
        }
        bytes += value.byteLength;
        if (bytes > 2_000_000) {
          fail("MODEL_RESPONSE_TOO_LARGE");
          throw Error("MODEL_RESPONSE_TOO_LARGE");
        }
        c.enqueue(value);
      } catch (error) {
        cleanup();
        if (!signal.aborted) {
          fail(bytes > 2_000_000 ? "MODEL_RESPONSE_TOO_LARGE" : "MODEL_CALL_OUTCOME_UNKNOWN");
          c.error(error);
        }
        await reader.cancel().catch(() => {});
      }
    },
    async cancel() {
      cleanup();
      await reader.cancel().catch(() => {});
    },
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, { status: response.status, headers });
}

export async function readModelStream(
  client: OpenAI,
  body: Record<string, unknown>,
  onText?: (text: string) => Promise<void>,
): Promise<ModelResponse> {
  let text = "";
  const stream = await client.responses.create(body as unknown as ResponseCreateParamsStreaming);
  let result: ModelResponse | undefined;
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      if (result) throw Error("MODEL_STREAM_INVALID");
      text += event.delta;
      await onText?.(text);
    } else if (event.type === "response.completed") {
      const r = event.response;
      result = {
        text: r.output
          .filter((item) => item.type === "message")
          .flatMap((item) => item.content)
          .filter((part) => part.type === "output_text")
          .map((part) => part.text)
          .join("\n"),
        calls: r.output
          .filter((item) => item.type === "function_call")
          .map((item) => ({ id: item.call_id, name: item.name, arguments: item.arguments })),
        usage: { input: r.usage?.input_tokens ?? null, output: r.usage?.output_tokens ?? null },
      };
    } else if (["response.failed", "response.incomplete", "error"].includes(event.type)) {
      throw Error("MODEL_STREAM_INCOMPLETE");
    }
  }
  if (!result) throw Error("MODEL_STREAM_INCOMPLETE");
  return result;
}
