/** 官方认证客户端只处理认证协议；成员权限仍由 /user/me 复核。请求边界保留超时与未确认写入语义。 */
import { createAuthClient } from "better-auth/react";
import { requestJson } from "./request";

export const authClient = createAuthClient({
  sessionOptions: { refetchOnWindowFocus: false, refetchWhenOffline: false },
  fetchOptions: {
    retry: 0,
    timeout: 30000,
    redirect: "error",
    customFetchImpl: async (input, init) => {
      const data = await requestJson(String(input), {
        method: init?.method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers: Object.fromEntries(new Headers(init?.headers)),
        timeoutMs: 30000,
        signal: init?.signal ?? undefined,
      });
      return Response.json(data);
    },
  },
});

export async function authResult<T extends { error?: { code?: string; status?: number } | null }>(
  pending: Promise<T>,
) {
  const result = await pending;
  if (result.error)
    throw Error(
      result.error.code && /^[A-Z][A-Z0-9_]+$/.test(result.error.code)
        ? result.error.code
        : "AUTH_REQUEST_FAILED",
    );
  return result;
}
export const botHeaders = (token: string) => ({ headers: { "x-turnstile-token": token } });
