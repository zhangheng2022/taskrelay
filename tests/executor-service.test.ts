import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requestUrl } from "./http-fixture";
import {
  downloadServiceRelease,
  fetchServiceRelease,
  readServiceEnvironment,
  serveServiceCommands,
  WindowsService,
} from "../apps/desktop/src/main/windows-service";
import { transitionService } from "../apps/desktop/src/main/service-transition";
import { serveServiceUpdate } from "../apps/cloud/src/updates";
import {
  servicePackagePath,
  SERVICE_UPDATE_PATH,
  UPDATE_ORIGIN,
} from "../packages/contracts/src/updates";

const bytes = Buffer.from("test-only service artifact");
const artifact = {
  version: "0.27.0",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
  notes: "",
  publishedAt: "2026-11-17T00:00:00.000Z",
};

test("开机服务独立目录只提供锁定的安装包，并在写入后核验字节", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "taskrelay-service-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests: string[] = [];
  const upstream: typeof fetch = async (url, options) => {
    requests.push(requestUrl(url));
    assert.equal(options?.redirect, "manual");
    return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
  };
  const catalog = { latest: artifact.version, releases: [artifact] };
  const fetcher: typeof fetch = async (url) =>
    serveServiceUpdate(new Request(url), catalog, upstream);
  assert.deepEqual(await fetchServiceRelease(fetcher), artifact);
  const file = path.join(root, "service.exe");
  await downloadServiceRelease(artifact, file, fetcher);
  assert.deepEqual(await readFile(file), bytes);
  assert.match(requests[0], /v0\.27\.0\/TaskRelay\.Service\.Setup\.exe$/);
  const invalid = await serveServiceUpdate(
    new Request(UPDATE_ORIGIN + servicePackagePath(artifact).replace(".exe", ".zip")),
    catalog,
    upstream,
  );
  assert.equal(invalid.status, 404);
  assert.equal(requests.length, 1);
  await assert.rejects(
    downloadServiceRelease(
      artifact,
      path.join(root, "bad.exe"),
      async () =>
        new Response(Buffer.alloc(bytes.length), {
          headers: { "content-length": String(bytes.length) },
        }),
    ),
    /HASH_INVALID/,
  );
  await assert.rejects(
    downloadServiceRelease(
      artifact,
      path.join(root, "short.exe"),
      async () =>
        new Response(bytes.subarray(1), { headers: { "content-length": String(bytes.length) } }),
    ),
    /SIZE_INVALID/,
  );
  const unpublished = await serveServiceUpdate(
    new Request(UPDATE_ORIGIN + SERVICE_UPDATE_PATH + "/latest.json"),
    { latest: null, releases: [artifact] },
    upstream,
  );
  assert.deepEqual(await unpublished.json(), { release: null });
});

test("服务安装在排空之后交接，取消授权恢复旧执行器，关开关只改启动类型", async () => {
  const order: string[] = [];
  let installed: { mode: "auto" | "manual"; running: boolean } | null = null;
  let cancelled = true;
  let upgrade = false;
  const options = {
    enabled: true,
    upgrade,
    info: async () => installed,
    startup: async (value: boolean) => {
      order.push("startup:" + value);
    },
    start: async () => {
      order.push("start");
    },
    currentVersion: async () => "0.26.9",
    release: async () => artifact,
    prepare: async () => ({
      run: async () => {
        order.push("install");
        if (cancelled) throw Error("UAC_CANCELLED");
      },
      cleanup: async () => {
        order.push("cleanup");
      },
    }),
    drain: async () => {
      order.push("drain");
    },
    waitUntilIdle: async () => {
      order.push("idle");
    },
    stopPrevious: async () => {
      order.push("stop");
      return upgrade;
    },
    adopt: async () => {
      order.push("adopt");
    },
    restore: async (stopped: boolean) => {
      order.push("restore:" + stopped);
    },
  };
  await assert.rejects(transitionService(options), /UAC_CANCELLED/);
  assert.deepEqual(order.splice(0), [
    "drain",
    "idle",
    "stop",
    "install",
    "restore:false",
    "cleanup",
  ]);
  cancelled = false;
  await transitionService(options);
  assert.deepEqual(order.splice(0), ["drain", "idle", "stop", "install", "adopt", "cleanup"]);
  installed = { mode: "auto", running: true };
  await transitionService({ ...options, enabled: false });
  assert.deepEqual(order.splice(0), ["startup:false"]);
  upgrade = true;
  await transitionService({ ...options, upgrade });
  assert.deepEqual(order.splice(0), ["drain", "idle", "stop", "install", "adopt", "cleanup"]);
  installed = { mode: "manual", running: false };
  await transitionService({ ...options, enabled: true });
  assert.deepEqual(order, ["startup:true", "start"]);
});

test("服务内层端口拒绝未授权命令，并在回执写好后才完成退出", async () => {
  const key = Buffer.alloc(32, 3).toString("base64");
  const token = randomUUID().replaceAll("-", "");
  const settings = {
    TASKRELAY_SERVICE_CHANNEL: "TaskRelay.Executor.Worker." + token,
    TASKRELAY_SERVICE_KEY: key,
    TASKRELAY_SERVICE_DATA: "C:\\ProgramData\\TaskRelayService\\state",
  };
  const configuration = readServiceEnvironment(settings);
  assert.deepEqual(settings, {});
  assert.throws(() => readServiceEnvironment({}), /SERVICE_ENVIRONMENT_INVALID/);
  const socketPath =
    process.platform === "win32" ? "\\\\.\\pipe\\test-relay-" + token : "/tmp/relay-" + token;
  const calls: unknown[] = [];
  const server = serveServiceCommands(
    configuration,
    (method, input) => {
      calls.push(method, input);
      if (method === "unknown") throw Error("NOT_ALLOWED");
      return "done";
    },
    (method) => calls.push("after:" + method),
    socketPath,
  );
  await once(server, "listening");
  const call = (line: string) =>
    new Promise<string>((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.once("connect", () => socket.write(line + "\n"));
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.once("close", () => resolve(Buffer.concat(chunks).toString()));
      socket.once("error", reject);
    });
  try {
    assert.equal(await call('wrong {"method":"quit"}'), "");
    assert.deepEqual(calls, []);
    assert.deepEqual(JSON.parse(await call(key + ' {"method":"unknown"}')), {
      ok: false,
      error: "NOT_ALLOWED",
    });
    assert.deepEqual(JSON.parse(await call(key + ' {"method":"quit","input":true}')), {
      ok: true,
      value: "done",
    });
    assert.deepEqual(calls, ["unknown", undefined, "quit", true, "after:quit"]);
  } finally {
    server.close();
  }
});

test("Windows 适配器读取实际 SCM 状态，并只对校验过的服务入口发起提升", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "relay-windows-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let present = false;
  let reply = "absent";
  let registry = false;
  let sid = '"host\\fixture","S-1-5-21-1-2-3-1001"';
  let exit = 0;
  let script = "";
  const calls: string[] = [];
  const fixture = {
    exists: () => present,
    execute: async (file: string, args: string[]) => {
      calls.push(args[0]);
      if (file.endsWith("reg.exe") && !registry) throw Error("NOT_FOUND");
      if (file.endsWith("powershell.exe")) {
        script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
        if (exit) throw Object.assign(Error("WINDOWS_STATUS"), { code: exit });
      }
      return { stdout: file.endsWith("whoami.exe") ? sid : reply, stderr: "" };
    },
    spawn: () =>
      spawn(
        process.execPath,
        [
          "-e",
          "process.stdin.once('data',b=>{const m=JSON.parse(b);if(m.method==='stop')process.exit(5);process.stdout.write(JSON.stringify(m.method==='unknown'?{ok:false,error:'REJECTED'}:{ok:true,value:m.input}));});",
        ],
        { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
      ),
    download: async (_release: typeof artifact, destination: string) =>
      writeFile(destination, bytes),
  };
  const client = new WindowsService(true, fixture);
  assert.equal(await new WindowsService(false, fixture).info(), null);
  assert.equal(await client.info(), null);
  registry = true;
  await assert.rejects(client.info(), /安装不完整/);
  present = true;
  for (const mode of ["auto", "manual"] as const)
    for (const running of [true, false]) {
      reply = mode + (running ? " online" : " offline");
      assert.deepEqual(await client.info(), { mode, running });
    }
  reply = "denied";
  await assert.rejects(client.info(), /只有配置/);
  reply = "invalid";
  await assert.rejects(client.info(), /SERVICE_STATUS_INVALID/);
  await client.start();
  assert.equal(calls.at(-1), "start");
  assert.equal(await client.call("pause", true), true);
  await assert.rejects(client.call("unknown"), /REJECTED/);
  await assert.rejects(client.call("stop"), /未响应/);
  await client.setStartup(false);
  assert.match(script, /-ArgumentList 'disable' -Verb RunAs/);
  const prepared = await client.prepareInstall(artifact, root);
  for (const [code, message] of [
    [11, /签名或文件不匹配/],
    [12, /SERVICE_UAC_CANCELLED/],
    [13, /服务配置失败/],
  ] as const) {
    exit = code;
    await assert.rejects(prepared.run(), message);
  }
  assert.ok(script.includes(artifact.sha256));
  assert.match(script, /'S-1-5-21-1-2-3-1001'/);
  await prepared.cleanup();
  sid = "bad SID";
  await assert.rejects(client.prepareInstall(artifact, root), /无法识别/);
  assert.deepEqual(await readdir(root), []);
});
