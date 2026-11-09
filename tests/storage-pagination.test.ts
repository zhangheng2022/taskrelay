import test from "node:test";
import assert from "node:assert/strict";
import { productionModelFixture } from "./production-model-fixture";
import { insertTask, task } from "./helpers";
import { invoke } from "../apps/cloud/src/models";
import { app } from "../apps/cloud/src/index";
import { tick } from "../apps/cloud/src/store";

test("重复设备就绪轮询不反复写行，暂停即时生效；新成员的个人次数限制默认关闭", async (t) => {
  const s = await productionModelFixture(t);
  assert.equal(
    s.sql.prepare("SELECT daily_quota_paused value FROM members WHERE id='fixture_owner'").get()!
      .value,
    1,
  );
  assert.equal((await s.request("/api/device/readiness", { ready: true })).status, 200);
  const before = Number(s.sql.prepare("SELECT total_changes() n").get()!.n);
  assert.equal((await s.request("/api/device/readiness", { ready: true })).status, 200);
  assert.equal(Number(s.sql.prepare("SELECT total_changes() n").get()!.n), before);
  assert.equal((await s.request("/api/device/readiness", { ready: false })).status, 200);
  assert.equal(s.sql.prepare("SELECT claim_ready value FROM devices").get()!.value, 0);
});

test("已确认周期任务启用及 tick 使用毫秒写入，配对接口仍输出 ISO 到期时间", async (t) => {
  const s = await productionModelFixture(t),
    scheduled = await insertTask(
      s.db,
      task({
        id: "scheduled",
        accountId: null,
        schedule: { kind: "cron", expression: "* * * * *", timezone: "Asia/Shanghai" },
      }),
    );
  s.sql.prepare("UPDATE tasks SET confirmed_condition='confirmed' WHERE id=?").run(scheduled.id);
  const enabled = await s.request("/api/user/tasks/scheduled/state", { enabled: true });
  assert.equal(enabled.status, 200);
  assert.equal(
    s.sql.prepare("SELECT typeof(next_run_at) type FROM tasks WHERE id='scheduled'").get()!.type,
    "integer",
  );
  s.sql.prepare("UPDATE tasks SET next_run_at=? WHERE id='scheduled'").run(Date.now() - 1);
  await tick(s.db);
  assert.equal(
    s.sql.prepare("SELECT typeof(next_run_at) type FROM tasks WHERE id='scheduled'").get()!.type,
    "integer",
  );
  const pairing = await s.request("/api/pair/start", { name: "fixture", protocolVersion: 19 });
  assert.equal(pairing.status, 200);
  const read = await s.request("/api/admin/pairings/" + pairing.data.code, undefined, "GET");
  assert.equal(read.status, 200);
  assert.match(read.data.expiresAt, /T.*Z$/);
});

test("任务/聊天使用时间及 ID 稳定分页，50 条边界无遗漏，游标不能扩大用户归属", async (t) => {
  const s = await productionModelFixture(t),
    at = "2026-11-01T00:00:00.000Z";
  for (let i = 0; i < 64; i++)
    await insertTask(
      s.db,
      task({ id: "page_" + String(i).padStart(3, "0"), accountId: null, createdAt: at }),
    );
  s.sql.prepare("INSERT INTO members(id) VALUES('other')").run();
  await insertTask(s.db, task({ id: "foreign", accountId: null, createdAt: at }), "other");
  const first = (await s.request("/api/user/tasks", undefined, "GET")).data;
  assert.equal(first.items.length, 50);
  assert.ok(first.nextCursor);
  const second = (await s.request("/api/user/tasks?before=" + first.nextCursor, undefined, "GET"))
    .data;
  assert.equal(new Set([...first.items, ...second.items].map((r) => r.id)).size, 65);
  assert.ok(![...first.items, ...second.items].some((r) => r.id === "foreign"));
  assert.equal(second.nextCursor, null);
  assert.notEqual(
    (await s.request("/api/user/tasks?before=invalid", undefined, "GET")).status,
    200,
  );
  for (let i = 0; i < 63; i++)
    s.sql
      .prepare(
        "INSERT INTO ai_threads(id,user_id,kind,model_id,model_version,created_at,updated_at) VALUES(?,'fixture_owner','chat','model_test',1,?,?)",
      )
      .run("thread_" + String(i).padStart(3, "0"), Date.parse(at), Date.parse(at));
  const threads = (
    await s.request("/api/user/threads?modelId=model_test&unattached=true", undefined, "GET")
  ).data;
  const older = (
    await s.request(
      "/api/user/threads?modelId=model_test&unattached=true&before=" + threads.nextCursor,
      undefined,
      "GET",
    )
  ).data;
  assert.equal(threads.items.length, 50);
  assert.equal(older.items.length, 13);
  assert.equal(new Set([...threads.items, ...older.items].map((r) => r.id)).size, 63);
});

test("生产模型调用缓存分块保留长结果，同请求不重复出站，缺片明确阻断", async (t) => {
  const s = await productionModelFixture(t),
    text = "完整响应😀".repeat(110_000),
    request = { messages: [{ role: "user" as const, content: "测试" }] };
  s.replies(text);
  const first = await invoke(s.env, "model_test", 1, request, s.run.id, "large-cache");
  assert.equal(first.text, text);
  assert.ok(
    Number(
      s.sql.prepare("SELECT count(*) n FROM call_result_chunks WHERE id='large-cache'").get()!.n,
    ) > 1,
  );
  const count = s.jobs();
  const repeated = await invoke(s.env, "model_test", 1, request, s.run.id, "large-cache");
  assert.equal(repeated.text, text);
  assert.equal(s.jobs(), count);
  s.sql.prepare("DELETE FROM call_result_chunks WHERE id='large-cache' AND part=0").run();
  await assert.rejects(
    invoke(s.env, "model_test", 1, request, s.run.id, "large-cache"),
    /MODEL_CALL_PAYLOAD_MISSING/,
  );
  assert.equal(s.jobs(), count);
});

test("冻结转换只开放管理员核验，未核验对象阻止激活，激活仍保留维护/领取屏障", async (t) => {
  const s = await productionModelFixture(t);
  s.sql.exec(
    "UPDATE runs SET status='failed',cleanup_pending=0;INSERT INTO settings VALUES('storageFrozen','1');UPDATE settings SET value='1' WHERE key='maintenance';UPDATE settings SET value='0' WHERE key='claimsEnabled'",
  );
  assert.equal((await s.request("/api/user/tasks", undefined, "GET")).status, 503);
  assert.equal((await s.request("/api/auth/config", undefined, "GET")).status, 200);
  s.sql
    .prepare(
      "INSERT INTO artifacts(id,run_id,object_key,content_type,expires_at) VALUES('image',?,'fixture','image/png',4070908800000)",
    )
    .run(s.run.id);
  assert.notEqual(
    (
      await s.request("/api/admin/storage/activate", {
        objectsVerified: true,
        clientsPrepared: true,
      })
    ).status,
    200,
  );
  const pending = (await s.request("/api/admin/storage/status", undefined, "GET")).data;
  assert.equal(pending.pending.length, 1);
  s.sql.prepare("INSERT INTO storage_object_checks VALUES('evidence','fixture',?)").run(Date.now());
  assert.equal(
    (
      await s.request("/api/admin/storage/activate", {
        objectsVerified: true,
        clientsPrepared: true,
      })
    ).status,
    200,
  );
  assert.equal(
    s.sql.prepare("SELECT value FROM settings WHERE key='maintenance'").get()!.value,
    "1",
  );
  assert.equal(
    s.sql.prepare("SELECT value FROM settings WHERE key='claimsEnabled'").get()!.value,
    "0",
  );
  const device = await app.request(
    "http://localhost/api/admin/storage/status",
    { headers: { Authorization: "Bearer " + "c".repeat(64), "x-taskrelay-protocol": "19" } },
    s.env,
  );
  assert.equal(device.status, 403);
});
