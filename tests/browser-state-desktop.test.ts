import { socketText } from "./http-fixture";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import WebSocket from "ws";
import { BrowserStateAdapter } from "../apps/desktop/src/main/browser-state";
import { LocalCdp } from "../apps/desktop/src/main/local-cdp";
import { ProtectedStateFiles } from "../apps/desktop/src/main/protected-state";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const executable = path.resolve("resources/browser/chrome-win64/chrome.exe");
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
test(
  "正式状态适配器在独立 Chromium 恢复分区 Cookie、HttpOnly 和页面首读 Local Storage",
  { skip: process.platform !== "win32" || !existsSync(executable), timeout: 45_000 },
  async (t) => {
    // Runner 故障只记录固定命令名，不输出 Cookie、存储值或响应正文。
    const sendCommand = LocalCdp.prototype.send;
    t.mock.method(
      LocalCdp.prototype,
      "send",
      async function (this: LocalCdp, ...args: Parameters<LocalCdp["send"]>) {
        try {
          return await sendCommand.apply(this, args);
        } catch (error) {
          throw new Error(`状态迁移命令失败：${args[0]}`, { cause: error });
        }
      },
    );
    const directory = await mkdtemp(path.join(tmpdir(), "relay-state-cdp-"));
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end('<script>document.title=localStorage.getItem("token")||"missing";</script>');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const source = path.join(directory, "source");
    const child = spawn(
      executable,
      [
        `--user-data-dir=${source}`,
        "--remote-debugging-port=0",
        "--headless=new",
        "--no-first-run",
        "--disable-background-networking",
        "about:blank",
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    const children = [child];
    let socket: WebSocket | undefined, adapter: BrowserStateAdapter | undefined;
    t.after(async () => {
      await adapter?.close();
      socket?.close();
      for (const owned of children)
        if (owned.exitCode === null && owned.pid)
          await new Promise<void>((resolve) =>
            execFile(
              "taskkill.exe",
              ["/PID", String(owned.pid), "/T", "/F"],
              { windowsHide: true },
              () => resolve(),
            ),
          );
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    let active = "";
    for (let i = 0; i < 100; i++) {
      try {
        active = await readFile(path.join(source, "DevToolsActivePort"), "utf8");
        break;
      } catch {
        await delay(100);
      }
    }
    assert.ok(active);
    let cdpUrl = `http://127.0.0.1:${active.split("\n")[0].trim()}`;
    adapter = await BrowserStateAdapter.connect(cdpUrl);
    const cookies = [
      {
        name: "httpOnly",
        value: "fixture-secret",
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        expires: Date.now() / 1000 + 600,
      },
      ...["https://one-fixture.test", "https://two-fixture.test"].map((topLevelSite) => ({
        name: "partition",
        value: topLevelSite,
        domain: ".fixture.test",
        path: "/",
        secure: true,
        httpOnly: true,
        partitionKey: { topLevelSite, hasCrossSiteAncestor: true },
      })),
    ];
    t.diagnostic("恢复源环境");
    await adapter.restore({
      version: 1,
      cookies,
      origins: [{ origin, localStorage: [["token", "restored-before-first-script"]] }],
    });
    t.diagnostic("读取源环境");
    const exported = await adapter.capture([origin, "https://fixture.test"]);
    assert.equal(exported.cookies.filter((cookie) => cookie.name === "partition").length, 2);
    assert.deepEqual(
      new Set(
        exported.cookies
          .filter((cookie) => cookie.name === "partition")
          .map((cookie) => cookie.partitionKey?.topLevelSite),
      ),
      new Set(["https://one-fixture.test", "https://two-fixture.test"]),
    );
    assert.equal(exported.cookies.find((cookie) => cookie.name === "httpOnly")?.httpOnly, true);
    assert.deepEqual(exported.origins.find((entry) => entry.origin === origin)?.localStorage, [
      ["token", "restored-before-first-script"],
    ]);
    // 在另一份全新 Profile 中恢复源浏览器导出值，再检查网站首次脚本读取。
    const destination = path.join(directory, "destination");
    children.push(
      spawn(
        executable,
        [
          `--user-data-dir=${destination}`,
          "--remote-debugging-port=0",
          "--headless=new",
          "--no-first-run",
          "--disable-background-networking",
          "about:blank",
        ],
        { windowsHide: true, stdio: "ignore" },
      ),
    );
    active = "";
    for (let i = 0; i < 100; i++) {
      try {
        active = await readFile(path.join(destination, "DevToolsActivePort"), "utf8");
        break;
      } catch {
        await delay(100);
      }
    }
    assert.ok(active);
    cdpUrl = `http://127.0.0.1:${active.split("\n")[0].trim()}`;
    await adapter.close();
    adapter = await BrowserStateAdapter.connect(cdpUrl);
    t.diagnostic("恢复独立环境");
    await adapter.restore(exported);
    const migrated = await adapter.capture([origin, "https://fixture.test"]);
    assert.deepEqual(migrated, exported);
    const info = (await (await fetch(`${cdpUrl}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    socket = new WebSocket(info.webSocketDebuggerUrl);
    await once(socket, "open");
    let seq = 0;
    const pending = new Map<number, (value: any) => void>();
    socket.on("message", (data) => {
      const message = JSON.parse(socketText(data));
      if (Number.isSafeInteger(message.id)) {
        const reply = pending.get(message.id);
        if (typeof reply === "function") reply(message);
        pending.delete(message.id);
      }
    });
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<any>((resolve, reject) => {
        const id = ++seq;
        pending.set(id, (message) =>
          message.error ? reject(Error(JSON.stringify(message.error))) : resolve(message.result),
        );
        socket!.send(JSON.stringify({ id, method, params, sessionId }));
      });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" }),
      { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.navigate", { url: origin }, sessionId);
    let title = "";
    for (let i = 0; i < 50; i++) {
      title = (
        await send(
          "Runtime.evaluate",
          { expression: "document.title", returnByValue: true },
          sessionId,
        )
      ).result.value;
      if (title === "restored-before-first-script") break;
      await delay(50);
    }
    assert.equal(title, "restored-before-first-script");
    // Chromium 非正常退出可能没有刷盘；同版本干净环境补齐 Cookie，但不覆盖网站已刷新值。
    await send("Storage.clearCookies");
    await adapter.restoreMissingCookies(exported);
    assert.equal((await adapter.capture([origin, "https://fixture.test"])).cookies.length, 3);
    await send("Storage.setCookies", { cookies: [{ ...cookies[0], value: "newer-local-token" }] });
    await adapter.restoreMissingCookies(exported);
    assert.equal(
      (await adapter.capture([origin])).cookies.find((cookie) => cookie.name === "httpOnly")?.value,
      "newer-local-token",
    );
    // 空快照清除会话 Cookie；Local Storage 的空数组也是真实删除。
    await adapter.restore({ version: 1, cookies: [], origins: [{ origin, localStorage: [] }] });
    const empty = await adapter.capture([origin, "https://fixture.test"]);
    assert.equal(empty.cookies.length, 0);
    assert.equal(empty.origins.find((entry) => entry.origin === origin)?.localStorage.length, 0);
  },
);

test("系统加密适配器只暂存密文，异常恢复清理孤儿，不接受路径穿越", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-state-sealed-")),
    key = randomBytes(32);
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  const files = new ProtectedStateFiles(directory, {
    isEncryptionAvailable: () => true,
    encryptString: (value) => {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString: (value) => {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString();
    },
  });
  const id = await files.put({ cookie: "do-not-log-secret" }),
    bytes = await readFile(path.join(directory, `${id}.state`));
  assert.equal(bytes.includes(Buffer.from("do-not-log-secret")), false);
  assert.deepEqual(await files.read(id), { cookie: "do-not-log-secret" });
  await assert.rejects(files.read("../outside"), /STATE_REFERENCE_INVALID/);
  await files.recover();
  await assert.rejects(readFile(path.join(directory, `${id}.state`)), /ENOENT/);
});
