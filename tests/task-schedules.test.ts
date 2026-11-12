import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { productionModelFixture } from "./production-model-fixture";
import {
  previewSchedule,
  tickSchedules,
  resolveScheduleIntent,
} from "../apps/cloud/src/task-schedules";
import { localScheduleInstant } from "../packages/contracts/src/task-schedule";
import {
  executeLearning,
  queueLearning,
  learningSnapshot,
  readLearning,
} from "../apps/cloud/src/execution-learning";
import { seedMessage, insertTask, task } from "./helpers";
import { claim, taskFrom } from "../apps/cloud/src/store";
import { advanceDispatchGroups } from "../apps/cloud/src/account-dispatch";

async function fixture(t: TestContext) {
  const s = await productionModelFixture(t);
  s.sql
    .prepare(
      "INSERT INTO ai_threads(id,user_id,task_id,kind,model_id,model_version,created_at,updated_at) VALUES('schedule_thread','fixture_owner',?,'chat','model_test',1,?,?)",
    )
    .run(s.run.taskId, Date.now(), Date.now());
  s.sql.prepare("UPDATE runs SET thread_id='schedule_thread' WHERE id=?").run(s.run.id);
  const root = `/api/user/tasks/${s.run.taskId}/schedule`;
  const confirm = (seq = 0, changed = false) =>
    s.request(`/api/runner/runs/${s.run.id}/requirements`, {
      epoch: s.run.leaseEpoch,
      userSeq: seq,
      summary: "读取订单并整理结果",
      changed,
    });
  const finish = async () => {
    const r = await s.request(`/api/runner/runs/${s.run.id}/finish`, {
      epoch: s.run.leaseEpoch,
      status: "succeeded",
      result: {
        summary: "已回复，未确认业务全部完成",
        outcome: "reported",
        evidence: [],
        executionRecordCount: 1,
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    s.sql.prepare("UPDATE runs SET cleanup_pending=0 WHERE id=?").run(s.run.id);
    s.sql.prepare("DELETE FROM account_locks WHERE run_id=?").run(s.run.id);
  };
  return { ...s, root, confirm, finish };
}
test("频率预览按指定时区计算，月末跳过不存在日期，单次仅一个时间", () => {
  assert.deepEqual(
    previewSchedule(
      { kind: "monthly", day: 31, time: "09:00", timezone: "Asia/Shanghai" },
      new Date("2026-01-31T02:00:00Z"),
    ),
    ["2026-03-31T01:00:00.000Z", "2026-05-31T01:00:00.000Z", "2026-07-31T01:00:00.000Z"],
  );
  assert.equal(
    localScheduleInstant("2026-11-11T09:00", "Asia/Shanghai"),
    "2026-11-11T01:00:00.000Z",
  );
  assert.throws(() => localScheduleInstant("2026-03-08T02:30", "America/New_York"), /INVALID/);
  assert.deepEqual(
    previewSchedule(
      { kind: "once", at: "2026-11-11T01:00:00.000Z", timezone: "Asia/Shanghai" },
      new Date("2026-11-10"),
    ),
    ["2026-11-11T01:00:00.000Z"],
  );
  assert.throws(
    () => previewSchedule({ kind: "daily", time: "25:00", timezone: "Asia/Shanghai" }),
    /INVALID/,
  );
  assert.deepEqual(
    previewSchedule(
      { kind: "daily", time: "09:00", timezone: "America/New_York" },
      new Date("2026-03-07T15:00:00Z"),
    ),
    ["2026-03-08T13:00:00.000Z", "2026-03-09T13:00:00.000Z", "2026-03-10T13:00:00.000Z"],
  );
  assert.deepEqual(
    previewSchedule(
      { kind: "weekly", days: [1, 3], time: "09:00", timezone: "Asia/Shanghai" },
      new Date("2026-11-09T02:00:00Z"),
    ),
    ["2026-11-11T01:00:00.000Z", "2026-11-16T01:00:00.000Z", "2026-11-18T01:00:00.000Z"],
  );
});
test("需求确认绑定租约和用户消息，重复不增版本，卡片正文加密", async (t) => {
  const s = await fixture(t);
  assert.equal((await s.confirm()).status, 200);
  assert.equal((await s.confirm()).status, 200);
  assert.equal(s.sql.prepare("SELECT version FROM task_schedules").get()!.version, 1);
  assert.ok(
    !String(s.sql.prepare("SELECT summary FROM task_schedules").get()!.summary).includes("订单"),
  );
  seedMessage(s.sql, {
    id: "new_request",
    thread_id: "schedule_thread",
    turn_id: "fixture",
    seq: 1,
    role: "user",
    source: "user",
    content: "改为只读取昨天",
    at: Date.now(),
  });
  assert.notEqual((await s.confirm(0)).status, 200);
  assert.equal((await s.confirm(1, true)).status, 200);
  assert.equal(
    s.sql.prepare("SELECT requirement_revision FROM tasks").get()!.requirement_revision,
    1,
  );
  await s.confirm(1, true);
  assert.equal(
    s.sql.prepare("SELECT requirement_revision FROM tasks").get()!.requirement_revision,
    1,
  );
  s.sql
    .prepare(
      "INSERT INTO task_versions(task_id,version,definition,user_id,model_id,model_version) SELECT task_id,2,definition,user_id,model_id,model_version FROM task_versions WHERE task_id=? AND version=1",
    )
    .run(s.run.taskId);
  s.sql.prepare("UPDATE tasks SET version=2 WHERE id=?").run(s.run.taskId);
  assert.equal(
    s.sql.prepare("SELECT requirement_revision FROM tasks WHERE id=?").get(s.run.taskId)!
      .requirement_revision,
    0,
  );
  assert.notEqual((await s.confirm(1)).status, 200);
  assert.equal(s.sql.prepare("SELECT ready FROM task_schedules").get()!.ready, 0);
});
test("保存启用请求幂等，多页面冲突，暂停不取消当前运行", async (t) => {
  const s = await fixture(t);
  await s.confirm();
  const body = {
    requestId: "save_a",
    expectedVersion: 1,
    expectedTaskVersion: 1,
    enabled: true,
    frequency: { kind: "daily", time: "09:00", timezone: "Asia/Shanghai" },
  };
  const concurrent = await Promise.all([s.request(s.root, body), s.request(s.root, body)]);
  assert.ok(concurrent.every((r) => r.status === 200));
  assert.equal((await s.request(s.root, body)).status, 200);
  seedMessage(s.sql, {
    id: "ordinary",
    thread_id: "schedule_thread",
    turn_id: "fixture",
    seq: 1,
    role: "user",
    source: "user",
    content: "现在到哪一步了",
    at: Date.now(),
  });
  assert.equal((await s.confirm(1, false)).status, 200);
  assert.equal(
    s.sql.prepare("SELECT version FROM task_schedules").get()!.version,
    2,
    "普通问询不改变配置身份，也不能导致同一时间槽重新触发",
  );
  assert.notEqual((await s.request(s.root, { ...body, requestId: "save_b" })).status, 200);
  assert.equal(
    (
      await s.request(s.root, {
        requestId: "pause",
        expectedVersion: 2,
        expectedTaskVersion: 1,
        enabled: false,
      })
    ).status,
    200,
  );
  assert.equal(
    s.sql.prepare("SELECT cancel_requested FROM runs WHERE id=?").get(s.run.id)!.cancel_requested,
    0,
  );
  assert.notEqual(
    (
      await s.request(s.root, {
        ...body,
        requestId: "old_task",
        expectedVersion: 3,
        expectedTaskVersion: 2,
      })
    ).status,
    200,
    "配置版本相同也不能跨任务版本保存",
  );
});
test("调度路由拒绝访问其他用户任务", async (t) => {
  const s = await fixture(t);
  await s.confirm();
  s.sql.prepare("INSERT INTO members(id,email) VALUES('another','other@example.com')").run();
  await insertTask(s.db, task({ id: "foreign_task", accountId: null }), "another");
  assert.equal(
    (await s.request("/api/user/tasks/foreign_task/schedule", undefined, "GET")).status,
    404,
  );
});
test("定时重复触发只有一个运行，固定经验和偏好；旧执行器不能领取新定时", async (t) => {
  const s = await fixture(t);
  await s.confirm();
  await s.finish();
  const at = new Date(Date.now() - 2000).toISOString();
  s.sql
    .prepare("UPDATE task_schedules SET state='enabled',legacy=1,schedule=?,next_run_at=?")
    .run(JSON.stringify({ kind: "once", at }), Date.parse(at));
  await tickSchedules(s.env);
  await tickSchedules(s.env);
  const rows = s.sql.prepare("SELECT * FROM runs WHERE id<>?").all(s.run.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].requires_scheduling, 1);
  assert.equal(await claim(s.db, "device_test", "legacy_claim"), null);
  s.sql.prepare("UPDATE devices SET schedule_capable=1").run();
  assert.ok(await claim(s.db, "device_test", "new_claim"));
});
test("新消息处理期间不触发，咨询恢复，改需求暂停并清除旧经验资格", async (t) => {
  const s = await fixture(t);
  await s.confirm();
  await s.finish();
  const at = new Date(Date.now() - 2000).toISOString();
  s.sql
    .prepare("UPDATE task_schedules SET state='enabled',legacy=1,schedule=?,next_run_at=?")
    .run(JSON.stringify({ kind: "once", at }), Date.parse(at));
  seedMessage(s.sql, {
    id: "question",
    thread_id: "schedule_thread",
    turn_id: "fixture",
    seq: 2,
    role: "user",
    source: "user",
    content: "现在是什么状态",
    at: Date.now(),
  });
  await tickSchedules(s.env);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM runs").get()!.n, 1);
  await resolveScheduleIntent(s.env, s.run.taskId, "schedule_thread", false);
  assert.equal(s.sql.prepare("SELECT state FROM task_schedules").get()!.state, "enabled");
  seedMessage(s.sql, {
    id: "change",
    thread_id: "schedule_thread",
    turn_id: "fixture",
    seq: 3,
    role: "user",
    source: "user",
    content: "改为退款订单",
    at: Date.now(),
  });
  await resolveScheduleIntent(s.env, s.run.taskId, "schedule_thread", true);
  assert.deepEqual(
    { ...s.sql.prepare("SELECT state,ready,next_run_at FROM task_schedules").get() },
    { state: "paused", ready: 0, next_run_at: null },
  );
});
test("后台总结使用真实记录，固定模型版本，重复作业不重新调用，需求变化隔离迟到经验", async (t) => {
  const s = await fixture(t);
  await s.confirm();
  await s.request(`/api/runner/runs/${s.run.id}/context`, {
    epoch: s.run.leaseEpoch,
    after: 0,
    supportsScheduling: true,
  });
  await s.request(`/api/runner/runs/${s.run.id}/execution-record`, {
    epoch: s.run.leaseEpoch,
    callId: "read",
    content: "读取订单返回空列表；没有提交操作",
  });
  await s.finish();
  await queueLearning(s.env);
  s.replies(
    JSON.stringify({
      summary: "页面返回空列表，不能证明订单不存在",
      improvements: "先核对日期筛选再读取列表",
    }),
  );
  await executeLearning(s.env, s.run.id);
  const job = s.sql.prepare("SELECT state,error FROM execution_learning").get();
  assert.equal(job!.state, "done", JSON.stringify(job));
  const calls = s.jobs();
  await executeLearning(s.env, s.run.id);
  assert.equal(s.jobs(), calls);
  const definition = taskFrom((await s.db.prepare("SELECT * FROM task_details").first())!);
  const ids = await learningSnapshot(s.db, definition);
  assert.deepEqual(ids, [s.run.id]);
  assert.deepEqual(await readLearning(s.env, { ...definition, learningIds: ids }), [
    "先核对日期筛选再读取列表",
  ]);
  s.sql.prepare("UPDATE tasks SET requirement_revision=1").run();
  assert.deepEqual(await learningSnapshot(s.db, { ...definition, requirementRevision: 1 }), []);
  s.sql.prepare("UPDATE runs SET history_deleted=1 WHERE id=?").run(s.run.id);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM execution_learning").get()!.n, 0);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM execution_records").get()!.n, 0);
});
test("多账号定时使用执行组，首个账号清理后才创建下一个", async (t) => {
  const s = await fixture(t);
  await s.confirm();
  await s.finish();
  await insertTask(s.db, task({ id: "spare", accountId: "account_two" }));
  const def = { ...s.run.task, accountIds: [s.run.task.accountId, "account_two"] };
  s.sql
    .prepare("UPDATE task_versions SET definition=? WHERE task_id=?")
    .run(JSON.stringify(def), s.run.taskId);
  const at = new Date(Date.now() - 2000).toISOString();
  s.sql
    .prepare("UPDATE task_schedules SET state='enabled',schedule=?,next_run_at=?")
    .run(JSON.stringify({ kind: "once", at }), Date.parse(at));
  await tickSchedules(s.env);
  await tickSchedules(s.env);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM account_dispatch_groups").get()!.n, 1);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM account_dispatch_members").get()!.n, 2);
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM runs WHERE dispatch_group_id IS NOT NULL").get()!.n,
    1,
  );
  s.sql
    .prepare(
      "UPDATE runs SET status='succeeded',cleanup_pending=1 WHERE dispatch_group_id IS NOT NULL",
    )
    .run();
  await advanceDispatchGroups(s.db);
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM runs WHERE dispatch_group_id IS NOT NULL").get()!.n,
    1,
  );
  s.sql.prepare("UPDATE runs SET cleanup_pending=0 WHERE dispatch_group_id IS NOT NULL").run();
  await advanceDispatchGroups(s.db);
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM runs WHERE dispatch_group_id IS NOT NULL").get()!.n,
    2,
  );
});

test("旧定时增量迁移保留原频率、启停、未来触发时间且不启用普通任务", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    const root = new URL("../apps/cloud/migrations/", import.meta.url);
    for (const file of readdirSync(root)
      .filter((f) => f.endsWith(".sql") && f < "0005")
      .sort())
      sql.exec(readFileSync(new URL(file, root), "utf8"));
    sql.exec("BEGIN; INSERT INTO members(id,scheduled_tasks) VALUES('owner',20);");
    sql
      .prepare(
        "INSERT INTO model_profile_versions(id,version,config,secret,capabilities,created_at) VALUES('model',1,'{}','fixture','{}',?)",
      )
      .run(Date.now());
    const at = Date.now() + 86400000,
      schedule = { kind: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" };
    for (const id of ["old", "manual", "daily", "weekly", "monthly"]) {
      sql
        .prepare(
          "INSERT INTO tasks(id,user_id,version,title,schedule_kind,status,next_run_at,created_at,updated_at,confirmed_condition) VALUES(?,'owner',1,'旧任务','cron','active',?,?,?,?)",
        )
        .run(id, at, Date.now(), Date.now(), id !== "manual" ? "old_confirmation" : null);
      sql
        .prepare(
          "INSERT INTO task_versions(task_id,version,definition,user_id) VALUES(?,1,?,'owner')",
        )
        .run(
          id,
          JSON.stringify({
            schedule: {
              ...schedule,
              expression:
                (
                  { daily: "0 9 * * *", weekly: "15 8 * * 1,3", monthly: "30 7 31 * *" } as Record<
                    string,
                    string
                  >
                )[id] ?? schedule.expression,
            },
          }),
        );
      sql
        .prepare(
          "INSERT INTO ai_threads(id,user_id,task_id,kind,model_id,model_version,created_at,updated_at) VALUES(?,'owner',?,'chat','model',1,?,?)",
        )
        .run(`thread_${id}`, id, Date.now(), Date.now());
      seedMessage(sql, {
        id: `message_${id}`,
        thread_id: `thread_${id}`,
        turn_id: "fixture",
        seq: 7,
        role: "user",
        source: "user",
        content: "已有用户交办",
        at: Date.now(),
      });
    }
    sql.exec("COMMIT");
    sql.exec(readFileSync(new URL("0005_task_schedules.sql", root), "utf8"));
    const row = sql
      .prepare("SELECT state,schedule,next_run_at,legacy FROM task_schedules WHERE task_id='old'")
      .get()!;
    assert.deepEqual(
      { ...row },
      { state: "enabled", schedule: JSON.stringify(schedule), next_run_at: at, legacy: 1 },
    );
    assert.equal(
      sql.prepare("SELECT COUNT(*) n FROM task_schedules WHERE task_id='manual'").get()!.n,
      0,
    );
    for (const kind of ["daily", "weekly", "monthly"]) {
      const mapped = sql
        .prepare("SELECT frequency,legacy,next_run_at FROM task_schedules WHERE task_id=?")
        .get(kind)!;
      assert.equal(mapped.legacy, 0);
      assert.equal(JSON.parse(String(mapped.frequency)).kind, kind);
      assert.equal(mapped.next_run_at, at);
      assert.equal(
        sql.prepare("SELECT confirmed_seq FROM task_schedules WHERE task_id=?").get(kind)!
          .confirmed_seq,
        7,
      );
    }
  } finally {
    sql.close();
  }
});
test("unknown 及清理未完成阻止后续定时，也不补跑一小时前单次", async (t) => {
  const s = await fixture(t);
  await s.confirm();
  const at = new Date(Date.now() - 2000).toISOString();
  s.sql.prepare("UPDATE runs SET status='unknown' WHERE id=?").run(s.run.id);
  s.sql
    .prepare("UPDATE task_schedules SET state='enabled',schedule=?,next_run_at=?")
    .run(JSON.stringify({ kind: "once", at }), Date.parse(at));
  await tickSchedules(s.env);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM runs").get()!.n, 1);
  s.sql.prepare("UPDATE runs SET status='succeeded',cleanup_pending=1 WHERE id=?").run(s.run.id);
  s.sql.prepare("UPDATE task_schedules SET next_run_at=?").run(Date.parse(at));
  await tickSchedules(s.env);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM runs").get()!.n, 1);
  const old = new Date(Date.now() - 7200000).toISOString();
  s.sql.prepare("UPDATE runs SET status='failed',cleanup_pending=0 WHERE id=?").run(s.run.id);
  s.sql
    .prepare("UPDATE task_schedules SET schedule=?,next_run_at=?")
    .run(JSON.stringify({ kind: "once", at: old }), Date.parse(old));
  await tickSchedules(s.env);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM runs").get()!.n, 1);
});
test("后台总结失败保留失败状态，不自动重发未知模型调用", async (t) => {
  const s = await fixture(t);
  await s.confirm();
  await s.request(`/api/runner/runs/${s.run.id}/context`, {
    epoch: s.run.leaseEpoch,
    after: 0,
    supportsScheduling: true,
  });
  await s.finish();
  await queueLearning(s.env);
  s.replies(new Error("connection lost"));
  await executeLearning(s.env, s.run.id);
  const job = s.sql.prepare("SELECT state,error FROM execution_learning").get()!;
  assert.equal(job.state, "failed");
  assert.equal(job.error, "MODEL_CALL_OUTCOME_UNKNOWN");
  const calls = s.jobs();
  await executeLearning(s.env, s.run.id);
  assert.equal(s.jobs(), calls);
});
