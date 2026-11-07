import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Journal } from "../apps/desktop/src/main/journal";
import { ExecutionClock } from "../apps/desktop/src/executor/timing";
import { recentSpanLimit } from "../apps/desktop/src/shared/execution-timing";
import { productionModelFixture } from "./production-model-fixture";
import { egress } from "../apps/cloud/src/egress";
import { seal } from "../apps/cloud/src/crypto";
import { planConversation } from "../apps/cloud/src/ai/planning-graph";

test("诊断保留有界嵌套计时并过滤未知字段和旧检查点", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "taskrelay-timing-"));
  const journal = new Journal(dir);
  t.after(() => {
    journal.close();
    rmSync(dir, { recursive: true });
  });
  const clock = new ExecutionClock();
  t.after(() => clock.close());
  for (let i = 0; i < recentSpanLimit; i++) await clock.measure("context", async () => undefined);
  await assert.rejects(
    clock.measure("act", () =>
      clock.measure("stagehandModel", async () => {
        throw Error("fixture-secret");
      }),
    ),
  );
  const report = clock.report();
  assert.equal(report.recent.length, recentSpanLimit);
  assert.equal(report.recent.at(-2)!.parent, report.recent.at(-1)!.id);
  assert.equal(report.phases.stagehandModel!.failures, 1);
  assert.equal(report.phases.context!.calls, recentSpanLimit);
  journal.checkpoint("legacy", "g", 1, "finished", {});
  journal.checkpoint("valid", "g", 1, "finished", { timing: report, other: "fixture-secret" });
  journal.checkpoint("invalid", "g", 1, "finished", {
    timing: { ...report, other: "fixture-secret" },
  });
  const rows = journal.diagnostic().journal;
  assert.deepEqual(rows.find((row) => row.run_id === "valid")?.timing, report);
  assert.ok(rows.filter((row) => row.run_id !== "valid").every((row) => !("timing" in row)));
  assert.doesNotMatch(JSON.stringify(rows), /fixture-secret/);
});

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
  assert.equal(journal.get("historyEpoch"), 4);
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
  const body = { protocolVersion: 17, localReady: true };
  assert.equal((await s.request("/api/device/upgrade", body)).data.error, "CUTOVER_NOT_READY");
  s.sql.exec(
    "UPDATE runs SET status='succeeded';DELETE FROM account_locks;UPDATE settings SET value='1' WHERE key='maintenance';UPDATE settings SET value='0' WHERE key='claimsEnabled'",
  );
  assert.equal(
    (await s.request("/api/device/upgrade", { ...body, localReady: false })).status,
    400,
  );
  assert.equal((await s.request("/api/device/upgrade", body)).status, 200);
  assert.equal((await s.request("/api/device/status", undefined, "GET")).data.protocolVersion, 17);
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
      planConversation(
        {
          env: s.env,
          owner: "legacy_owner",
          id: "private",
          threadId: "private",
          kind: "chat",
          guard: async () => {},
        },
        { model_id: "model_test", model_version: 1 },
        [{ role: "user", content: "private" }],
      ),
    /AI_EXTERNAL_TRACING_DISABLED/,
  );
  assert.equal(s.jobs(), 0);
});

test("历史保持完整，云端意图检查收到当前纠正", async (t) => {
  const s = await productionModelFixture(t);
  s.sql
    .prepare(
      "UPDATE model_profiles SET config=json_set(config,'$.contextTokens',20000,'$.outputTokens',2048) WHERE id='model_test' AND version=1",
    )
    .run();
  const th = (
    await s.request("/api/user/threads", {
      modelId: "model_test",
      taskId: s.run.taskId,
    })
  ).data;
  for (let i = 1; i <= 10; i++)
    s.sql
      .prepare(
        "INSERT INTO ai_messages(id,thread_id,seq,role,content,turn_id,at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        "old" + i,
        th.id,
        i,
        i % 2 ? "user" : "assistant",
        "旧信息".repeat(400),
        "seed",
        new Date().toISOString(),
      );
  s.sql.prepare("UPDATE ai_threads SET version=5 WHERE id=?").run(th.id);
  s.sql.exec("UPDATE runs SET status='succeeded'");
  s.respond((body) =>
    JSON.stringify(
      JSON.stringify(body).includes('"summary"')
        ? { summary: "历史要求摘要，保留当前用户纠正。" }
        : {
            reply: "采用最新要求",
            start: false,
            title: null,
            goal: null,
            entryUrl: null,
            accountId: null,
            executionOutline: [],
          },
    ),
  );
  const result = await s.request(`/api/user/threads/${th.id}/messages`, {
    requestId: "correct",
    content: "纠正：以后只读，不执行提交",
  });
  assert.equal(result.data.status, "done", JSON.stringify(result.data));
  assert.equal(result.data.messages.length, 12);
  assert.ok(s.jobs() > 1);
  assert.match(JSON.stringify(s.requests.at(-1)!.body), /以后只读/);
  const payload = JSON.parse(s.requests.at(-1)!.body.messages.at(-1).content);
  assert.equal(payload.userMessages.length, 6);
  assert.ok(
    payload.userMessages
      .slice(0, 5)
      .every((message: { content: string }) => message.content === "旧信息".repeat(400)),
  );
  assert.equal(payload.userMessages.at(-1).content, "纠正：以后只读，不执行提交");
});
