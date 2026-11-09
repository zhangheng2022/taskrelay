import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { mkdir, readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import WebSocket from "ws";
import sharp from "sharp";
const out = ".cache/free-runtime";
await mkdir(out, { recursive: true });
await build({
  entryPoints: ["scripts/perf/free-runtime.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["workerd", "worker", "browser"],
  alias: { fs: "node:fs", "fs/promises": "node:fs/promises" },
  external: ["node:*", "cloudflare:*"],
  outfile: out + "/worker.js",
  banner: {
    js: "import * as fs from 'node:fs'; const require=n=>{if(n==='node:fs')return fs;throw Error('Unexpected require');};",
  },
});
const durableObjects = Object.fromEntries(
  Object.entries({
    REQUESTS: "RequestCoordinator",
    SCHEDULER: "Scheduler",
    AI_TURNS: "AiTurn",
    EVIDENCE_STORE: "Evidence",
    NOTIFICATIONS: "NotificationHub",
    MODEL_EGRESS: "ModelEgress",
  }).map(([k, className]) => [k, { className, useSQLite: true }]),
);
const mf = new Miniflare(
  convertV4MiniflareOptions({
    host: "127.0.0.1",
    port: 0,
    workers: [
      {
        name: "free-runtime-test",
        scriptPath: out + "/worker.js",
        modules: true,
        compatibilityDate: "2026-11-03",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        durableObjects,
        bindings: {
          DEV_MODE: "1",
          MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
          OWNER_EMAIL: "fixture@example.com",
        },
      },
    ],
  }),
);
try {
  const db = await mf.getD1Database("DB");
  for (const f of (await readdir("apps/cloud/migrations")).filter((x) => x.endsWith(".sql")).sort())
    await db.exec(
      (await readFile("apps/cloud/migrations/" + f, "utf8"))
        .replace(/--[^\n]*/g, "")
        .replace(/\r?\n/g, " "),
    );
  const origin = (await mf.ready).origin;
  const png = await sharp({ create: { width: 12, height: 7, channels: 4, background: "white" } })
    .png()
    .toBuffer();
  const checked = await fetch(origin + "/_image-validation", { method: "POST", body: png });
  assert.deepEqual(await checked.json(), { width: 12, height: 7, rejected: true });
  const request = async (path, body) => {
    const r = await fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(path.startsWith("/api/runner/")
          ? { Authorization: "Bearer " + "d".repeat(64), "x-taskrelay-protocol": "19" }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json();
    assert.ok(r.ok, JSON.stringify(data));
    return data;
  };
  await request("/_init");
  assert.equal((await request("/api/user/snapshot")).tasks.length, 0);
  assert.deepEqual(await request("/_schema"), { valid: { extraction: "fixture" }, rejected: true });
  const thread = await request("/api/user/threads", { modelId: "fixture" });
  // Real asynchronous turn with an isolated synthetic model adapter.
  const sent = await request(`/api/user/threads/${thread.id}/messages`, {
    requestId: "async-fixture",
    content: "请帮我设置一个任务",
  });
  assert.equal(sent.status, "running");
  let page;
  for (let i = 0; i < 30; i++) {
    page = await request(`/api/user/threads/${thread.id}`);
    if (!page.activeTurn) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(page.latestTurn.status, "done");
  assert.equal(page.messages.length, 2);
  const duplicate = await request(`/api/user/threads/${thread.id}/messages`, {
    requestId: "async-fixture",
    content: "请帮我设置一个任务",
  });
  assert.equal(duplicate.messages.length, 2);
  const { run } = await request("/_help-init", { threadId: thread.id });
  assert.ok(run);
  const helpPath = `/api/runner/runs/${run.id}/help`,
    help = {
      epoch: run.leaseEpoch,
      id: "workerd_help",
      origin: "https://example.com",
      message: "需要本次测试码",
    };
  assert.deepEqual(await request(helpPath, help), { ready: false });
  let diagnostic;
  for (let i = 0; i < 50; i++) {
    diagnostic = await request("/_help-diagnostics");
    if (["waiting", "failed", "unknown"].includes(diagnostic.graph?.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(diagnostic.graph?.status, "waiting", JSON.stringify(diagnostic));
  assert.ok(
    (await db.prepare("SELECT interrupt_id FROM execution_help WHERE id='workerd_help'").first())
      .interrupt_id,
  );
  await request(`/api/user/threads/${thread.id}/messages`, {
    requestId: "resume-fixture",
    content: "workerd-resume-code-0012，继续读取，不执行提交。",
  });
  let delivery;
  for (let i = 0; i < 50; i++) {
    delivery = await request(helpPath, help);
    if (delivery.ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(delivery.ready, true);
  assert.match(delivery.message, /完整回复/);
  assert.equal((await request("/_help-diagnostics")).graph.status, "done");
  assert.deepEqual(await request("/_evidence"), {
    size: 1100000,
    first: 51,
    other: null,
    removed: null,
  });
  assert.deepEqual(await request("/_checkpoint"), { intact: true, remaining: 0 });
  assert.deepEqual(
    await request("/_evidence-publication", { threadId: thread.id, runId: run.id }),
    { retained: 1100000, duplicateSafe: true, orphan: null, deleted: null, retired: 2 },
  );
  const ws = new WebSocket(origin.replace("http:", "ws:") + "/api/device/events", {
    headers: { Authorization: "Bearer " + "d".repeat(64), "x-taskrelay-protocol": "19" },
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const event = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Notification timeout")), 5000);
    ws.once("message", (m) => {
      clearTimeout(timer);
      if (!Buffer.isBuffer(m)) throw Error("PROFILE_MESSAGE_NOT_BUFFER");
      resolve(m.toString());
    });
  });
  await request("/_publish");
  assert.equal(await event, "changed");
  await db.prepare("UPDATE devices SET revoked=1 WHERE id='fixture'").run();
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Revocation timeout")), 40000);
    ws.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  await request("/_publish");
  assert.equal(await closed, 1008);
  console.log(
    "PASS: real workerd gateway, asynchronous alarm, durable help interrupt/resume, duplicate request, encrypted multi-chunk evidence and large checkpoints, staged evidence publication/orphan cleanup/duplicate alarm, cascading cleanup, WebSocket forwarding and revocation",
  );
} finally {
  await mf.dispose();
}
