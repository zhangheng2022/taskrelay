import { test } from "node:test";
import assert from "node:assert/strict";
import { requestJson } from "../packages/ui/src/request";

test("网络失败区分只读失败与未确认写入，任何请求均不自动重试", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new TypeError("network failure");
  });
  await assert.rejects(requestJson("/read"), /OFFLINE/);
  await assert.rejects(
    requestJson("/write", { method: "POST", body: { content: "test" } }),
    /REQUEST_UNCONFIRMED/,
  );
  assert.equal(calls, 2);
});
test("读取超时与异常服务响应具有独立反馈；响应正文中断也不误判为未发送", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    await new Promise((r) => setTimeout(r, 10));
    throw init.signal?.reason;
  });
  await assert.rejects(requestJson("/read", { timeoutMs: 1 }), /REQUEST_TIMEOUT/);
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("<html>upstream</html>", {
        status: 503,
        headers: { "content-type": "text/html" },
      }),
  );
  await assert.rejects(requestJson("/read"), /SERVER_RESPONSE_INVALID/);
  await assert.rejects(requestJson("/write", { method: "POST" }), /REQUEST_UNCONFIRMED/);
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error("lost body"));
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  await assert.rejects(requestJson("/write", { method: "POST" }), /REQUEST_UNCONFIRMED/);
});
