import { socketText } from "./http-fixture";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import WebSocket, { WebSocketServer } from "ws";
import type { Socket } from "node:net";
import { LocalCdp } from "../apps/desktop/src/main/local-cdp";

async function fixture(t: TestContext) {
  let target: string | undefined;
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        webSocketDebuggerUrl:
          target ?? `${origin.replace("http:", "ws:")}/devtools/browser/fixture`,
      }),
    );
  });
  const sockets = new WebSocketServer({ noServer: true });
  const connections = new Set<Socket>();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });
  server.on("upgrade", (req, socket, head) =>
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws, req)),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    for (const socket of connections) socket.destroy();
    sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    origin,
    server,
    sockets,
    target: (value: string) => {
      target = value;
    },
  };
}

test("CDP SDK 按调用编号配对乱序响应并隔离 session 事件", async (t) => {
  const f = await fixture(t);
  f.sockets.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(socketText(raw));
      setTimeout(
        () => {
          socket.send(
            JSON.stringify({
              method: "Page.loadEventFired",
              params: { timestamp: 1 },
              sessionId: message.sessionId,
            }),
          );
          socket.send(JSON.stringify({ id: message.id, result: { value: message.params.value } }));
        },
        message.params.value === 1 ? 30 : 0,
      );
    }),
  );
  const cdp = await LocalCdp.connect(f.origin);
  t.after(() => cdp.close());
  const sessions: string[] = [];
  const off = cdp.on((event) => sessions.push(event.sessionId!));
  assert.deepEqual(
    await Promise.all([
      cdp.send("Browser.getVersion", { value: 1 }, "a"),
      cdp.send("Browser.getVersion", { value: 2 }, "b"),
    ]),
    [{ value: 1 }, { value: 2 }],
  );
  assert.deepEqual(sessions, ["b", "a"]);
  off();
});

test("CDP 回复早于发送回调时仍完成同一次调用，不丢响应或重发", async (t) => {
  const f = await fixture(t);
  let received = 0;
  f.sockets.on("connection", (socket) =>
    socket.on("message", (raw) => {
      received++;
      const message = JSON.parse(socketText(raw));
      socket.send(JSON.stringify({ id: message.id, result: { value: "first-response" } }));
    }),
  );
  const cdp = await LocalCdp.connect(f.origin);
  t.after(() => cdp.close());
  // 保留真实 WebSocket 通信，只延后写完成通知，复现 Windows 快速回复先到的顺序。
  const sdkRequire = createRequire(
    createRequire(import.meta.url).resolve("chrome-remote-interface"),
  );
  const SdkWebSocket = sdkRequire("ws") as typeof WebSocket;
  // oxlint-disable-next-line typescript/unbound-method -- 原方法通过 call(this) 保留实际 socket。
  const send = SdkWebSocket.prototype.send;
  t.mock.method(
    SdkWebSocket.prototype,
    "send",
    function (this: WebSocket, ...args: Parameters<WebSocket["send"]>) {
      const [data, options, callback] = args;
      const complete = typeof options === "function" ? options : callback;
      if (!complete) return send.call(this, data, options);
      return send.call(this, data, typeof options === "function" ? {} : options, (error) => {
        setTimeout(() => complete(error), 50);
      });
    },
  );
  assert.deepEqual(await cdp.send("Storage.clearCookies", {}, undefined, 300), {
    value: "first-response",
  });
  assert.equal(received, 1);
});
test("断连拒绝等待命令，超时关闭连接且不能发送下一命令", async (t) => {
  const f = await fixture(t);
  f.sockets.on("connection", (socket) =>
    socket.on("message", (raw) => {
      if (JSON.parse(socketText(raw)).params.disconnect) socket.terminate();
    }),
  );
  const disconnected = await LocalCdp.connect(f.origin);
  await assert.rejects(
    disconnected.send("Browser.getVersion", { disconnect: true }),
    /CDP_(DISCONNECTED|COMMAND_FAILED)/,
  );
  await disconnected.close();
  const cdp = await LocalCdp.connect(f.origin);
  t.after(() => cdp.close());
  await assert.rejects(cdp.send("Browser.getVersion", {}, undefined, 30), /CDP_TIMEOUT/);
  await assert.rejects(cdp.send("Browser.getVersion"), /CDP_DISCONNECTED/);
});
test("拒绝非本机、端口不符及 HTTP/WS 重定向，不连接跳转目标", async (t) => {
  const f = await fixture(t);
  let redirected = 0;
  f.server.on("request", (req) => {
    if (req.url === "/escape") redirected++;
  });
  await assert.rejects(LocalCdp.connect("http://localhost:9222"), /CDP_ENDPOINT_INVALID/);
  f.target("ws://127.0.0.1:1/devtools/browser/fixture");
  await assert.rejects(LocalCdp.connect(f.origin), /CDP_ENDPOINT_INVALID/);
  f.target(`${f.origin.replace("http:", "ws:")}/devtools/browser/fixture`);
  f.server.removeAllListeners("upgrade");
  f.server.on("upgrade", (_req, socket) => {
    socket.end(`HTTP/1.1 302 Found\r\nLocation: ${f.origin}/escape\r\nContent-Length: 0\r\n\r\n`);
  });
  await assert.rejects(LocalCdp.connect(f.origin), /CDP_CONNECT_FAILED/);
  f.server.removeAllListeners("request");
  f.server.on("request", (_req, res) => {
    res.writeHead(302, { Location: `${f.origin}/escape` });
    res.end();
  });
  await assert.rejects(LocalCdp.connect(f.origin), /CDP_DISCOVERY_FAILED/);
  assert.equal(redirected, 0);
});
test("握手无响应时 SDK 自行关闭连接", { timeout: 7000 }, async (t) => {
  const f = await fixture(t);
  f.server.removeAllListeners("upgrade");
  let ended: Promise<unknown> | undefined;
  f.server.on("upgrade", (_req, socket) => {
    ended = once(socket, "end");
    socket.on("end", () => socket.end());
    socket.resume();
  });
  const started = Date.now();
  await assert.rejects(LocalCdp.connect(f.origin), /CDP_CONNECT_FAILED/);
  await ended;
  assert.ok(Date.now() - started < 6000);
});
