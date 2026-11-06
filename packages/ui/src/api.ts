/** Hono RPC 只携带类型与路径定义；实际发送仍由宿主 Transport 管理超时、取消和未确认写入。 */
import { hc } from "hono/client";
import type { BrowserApi } from "../../../apps/cloud/src/browser-api";
import type { Transport } from "../../contracts/src/index";

export function createApi(transport: Transport) {
  return hc<BrowserApi>("https://taskrelay.invalid", {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== "https://taskrelay.invalid") throw Error("API_PATH_INVALID");
      const data = await transport.request<unknown>(
        init?.method ?? "GET",
        url.pathname + url.search,
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        { signal: init?.signal ?? undefined },
      );
      return Response.json(data ?? null);
    },
  });
}
export async function rpcData<R extends { json: () => Promise<unknown> }>(
  request: Promise<R>,
): Promise<Awaited<ReturnType<R["json"]>>> {
  // HTTP 错误由 Transport 归一化；聊天的 200/202 业务结果可以包含 error，必须交给原协议处理。
  return (await request).json() as Promise<Awaited<ReturnType<R["json"]>>>;
}
