import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

test("真实 Cloud 长连接区分更新与任务通知，断线重连重新通知补查", async (t) => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  t.after(() => server.close());
  const prefix = path.join(tmpdir(), "relay-update-events-");
  const directory = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(prefix));
    await rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, "electron.cjs");
  await writeFile(file, "exports.safeStorage = { decryptString: () => 'fixture-token' };");
  const electronFixture = pathToFileURL(file).href;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "electron")
        return {
          url: electronFixture,
          format: "commonjs",
          shortCircuit: true,
        };
      return next(specifier, context);
    },
  });
  let Cloud: typeof import("../apps/desktop/src/main/cloud").Cloud;
  try {
    ({ Cloud } = await import("../apps/desktop/src/main/cloud"));
  } finally {
    hook.deregister();
  }
  const cloud = new Cloud({
    get: (key: string) =>
      key === "cloudUrl"
        ? `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        : "ZmFrZQ==",
  } as unknown as ConstructorParameters<typeof Cloud>[0]);
  t.after(() => cloud.close());
  const events: string[] = [];
  const connected = once(server, "connection");
  cloud.watch((event) => events.push(event));
  const [socket] = await connected;
  socket.send("changed");
  socket.send(JSON.stringify({ type: "update.available", version: 1 }));
  socket.send(JSON.stringify({ type: "update.available", version: 2 }));
  socket.send("invalid-json");
  for (let i = 0; i < 100 && events.length < 3; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ["open", "changed", "update"]);
  const reconnected = once(server, "connection");
  socket.close();
  await reconnected;
  for (let i = 0; i < 100 && events.length < 4; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ["open", "changed", "update", "open"]);
});
