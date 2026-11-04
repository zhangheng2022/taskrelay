import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Journal } from "../apps/desktop/src/main/journal";
import { productionModelFixture } from "./production-model-fixture";
import { egress } from "../apps/cloud/src/egress";
import { seal } from "../apps/cloud/src/crypto";
import { structuredGraph } from "../apps/cloud/src/ai/graph";
import { z } from "zod";

test("本地清理拒绝未发送 outbox 和未结束 journal；仅清历史，保留设备令牌和配置", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "taskrelay-ai-"));
  const journal = new Journal(dir);
  t.after(() => {
    journal.close();
    rmSync(dir, { recursive: true });
  });
  journal.set("token", "opaque-safeStorage-value");
  journal.set("cloudUrl", "https://cloud.example");
  journal.cache("snapshot", { old: true });
  journal.queue("out", "/finish", { epoch: 1 });
  assert.throws(() => journal.clearHistory(), /LOCAL_HISTORY_UNRESOLVED/);
  journal.remove("out");
  journal.checkpoint("run", "gen", 1, "intent", {});
  assert.throws(() => journal.clearHistory(), /LOCAL_HISTORY_UNRESOLVED/);
  journal.checkpoint("run", "gen", 1, "finished", {});
  journal.clearHistory();
  assert.equal(journal.get("token"), "opaque-safeStorage-value");
  assert.equal(journal.get("cloudUrl"), "https://cloud.example");
  assert.equal(journal.cached("snapshot"), null);
  assert.equal(journal.get("historyEpoch"), 3);
  assert.equal(journal.diagnostic().schema, 3);
});

test("更高版本 SQLite 不允许覆盖重建", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "taskrelay-ai-version-"));
  const db = new DatabaseSync(path.join(dir, "taskrelay.sqlite"));
  db.exec(
    "PRAGMA user_version=99;CREATE TABLE marker(value TEXT);INSERT INTO marker VALUES('keep');",
  );
  db.close();
  assert.throws(() => new Journal(dir), /CLIENT_UPGRADE_REQUIRED/);
  const check = new DatabaseSync(path.join(dir, "taskrelay.sqlite"));
  assert.equal(check.prepare("SELECT value FROM marker").get()!.value, "keep");
  check.close();
  rmSync(dir, { recursive: true });
});

test("旧设备原 token 升级须维护和本地就绪；旧协议请求继续被拒绝", async (t) => {
  const s = await productionModelFixture(t);
  s.sql.exec("UPDATE devices SET protocol_version=2");
  assert.equal(
    (await s.request("/api/device/status", undefined, "GET")).data.error,
    "DEVICE_UPGRADE_REQUIRED",
  );
  const body = { protocolVersion: 3, localReady: true };
  assert.equal(
    (await s.request("/api/device/upgrade", body)).data.error,
    "CUTOVER_NOT_READY",
  );
  s.sql.exec(
    "UPDATE runs SET status='succeeded';DELETE FROM account_locks;UPDATE settings SET value='1' WHERE key='maintenance';UPDATE settings SET value='0' WHERE key='claimsEnabled'",
  );
  assert.equal(
    (await s.request("/api/device/upgrade", { ...body, localReady: false }))
      .status,
    400,
  );
  assert.equal((await s.request("/api/device/upgrade", body)).status, 200);
  assert.equal(
    (await s.request("/api/device/status", undefined, "GET")).data
      .protocolVersion,
    3,
  );
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM devices").get()!.n, 1);
});

test("模型结果持久化失败绝不 ACK；成功保存之后才 ACK", async () => {
  const key = Buffer.alloc(32, 3).toString("base64"),
    events: string[] = [];
  const env = {
    MASTER_KEY: key,
    MODEL_EGRESS: {
      jurisdiction: () => ({
        getByName: () => ({
          submitAndWait: async (id: string) => ({
            status: "done",
            cipher: await seal({ ok: true }, key, `egress:${id}:response`),
          }),
          ack: async () => {
            events.push("ack");
          },
        }),
      }),
    },
  } as any;
  await assert.rejects(
    () =>
      egress(env, { kind: "trace" }, async () => {
        events.push("failed-save");
        throw new Error("DB_UNAVAILABLE");
      }),
    /DB_UNAVAILABLE/,
  );
  assert.deepEqual(events, ["failed-save"]);
  events.length = 0;
  await egress(env, { kind: "trace" }, async () => {
    events.push("save");
  });
  assert.deepEqual(events, ["save", "ack"]);
});

test("启用外部 tracing 的环境在 graph 开始前被拒绝，不上传会话", async (t) => {
  const s = await productionModelFixture(t),
    prior = process.env.LANGSMITH_TRACING;
  process.env.LANGSMITH_TRACING = "true";
  t.after(() => {
    if (prior === undefined) delete process.env.LANGSMITH_TRACING;
    else process.env.LANGSMITH_TRACING = prior;
  });
  await assert.rejects(
    () =>
      structuredGraph({
        env: s.env,
        owner: "legacy_owner",
        id: "private",
        kind: "chat",
        modelId: "model_test",
        version: 1,
        schema: z.object({ reply: z.string() }),
        messages: [{ role: "user", content: "private" }],
      }),
    /AI_EXTERNAL_TRACING_DISABLED/,
  );
  assert.equal(s.jobs(), 0);
});

test("长对话压缩历史但原文保持完整；后续上下文包含摘要和当前纠正", async (t) => {
  const s = await productionModelFixture(t);
  const th = (
    await s.request("/api/user/threads", {
      kind: "chat",
      modelId: "model_test",
      taskId: s.run.taskId,
    })
  ).data;
  for (let i = 1; i <= 10; i++)
    s.sql
      .prepare("INSERT INTO ai_messages VALUES(?,?,?,?,?,?,?)")
      .run(
        "old" + i,
        th.id,
        i,
        i % 2 ? "user" : "assistant",
        "旧信息".repeat(100),
        "seed",
        new Date().toISOString(),
      );
  s.sql.prepare("UPDATE ai_threads SET version=5 WHERE id=?").run(th.id);
  s.replies(
    '{"summary":"先前的要求已取消，使用用户最新纠正，来源1-7"}',
    '{"reply":"采用最新要求"}',
  );
  const result = await s.request(`/api/user/threads/${th.id}/messages`, {
    requestId: "correct",
    expectedVersion: 5,
    content: "纠正：以后只读，不执行提交",
  });
  assert.equal(result.data.status, "done", JSON.stringify(result.data));
  assert.equal(result.data.messages.length, 12);
  assert.equal(s.jobs(), 2);
  assert.match(JSON.stringify(s.requests[1].body), /先前的要求已取消/);
  assert.match(JSON.stringify(s.requests[1].body), /以后只读/);
  assert.ok(
    Number(
      s.sql.prepare("SELECT summary_seq FROM ai_threads WHERE id=?").get(th.id)!
        .summary_seq,
    ) > 0,
  );
});
