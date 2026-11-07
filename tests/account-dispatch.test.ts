import { dbTime } from "../apps/cloud/src/database";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { app } from "../apps/cloud/src/index";
import type { AppEnv } from "../apps/cloud/src/env";
import { commitDecision, drainCommands } from "../apps/cloud/src/ai/commands";
import { promoteInbox } from "../apps/cloud/src/ai/conversations";
import { advanceDispatchGroups } from "../apps/cloud/src/account-dispatch";
import { enqueue, claim, tick } from "../apps/cloud/src/store";
import { PROTOCOL_VERSION, type TaskRun } from "../packages/contracts/src/index";
import { hash } from "../packages/contracts/src/security";
import { seal } from "../apps/cloud/src/crypto";
import { testDb, insertTask, task } from "./helpers";

async function fixture(t: TestContext) {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  const env = {
    DB: db,
    DEV_MODE: "1",
    MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  } as AppEnv;
  const tokens = { d1: "a".repeat(64), d2: "b".repeat(64) };
  for (const [id, token] of Object.entries(tokens))
    sql
      .prepare(
        "INSERT INTO devices(id,name,token_hash,protocol_version,last_seen) VALUES(?,?,?,?,?)",
      )
      .run(id, id, await hash(token), PROTOCOL_VERSION, dbTime(new Date().toISOString()));
  async function request(
    path: string,
    body?: unknown,
    device?: keyof typeof tokens,
    method = body === undefined ? "GET" : "POST",
  ) {
    const response = await app.request(
      "http://localhost" + path,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(device
            ? {
                "x-taskrelay-protocol": String(PROTOCOL_VERSION),
                Authorization: "Bearer " + tokens[device],
              }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
    return { status: response.status, data: (await response.json()) as any };
  }
  const accounts: string[] = [];
  for (const name of ["甲账号", "乙账号", "丙账号"]) {
    const result = await request("/api/user/accounts", {
      name,
      origin: "https://example.com",
      username: name,
      password: "fixture-secret",
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    accounts.push(result.data.id);
  }
  sql
    .prepare(
      "INSERT INTO model_profile_versions(id,version,config,secret,capabilities,created_at) VALUES(?,1,?,?,?,?)",
    )
    .run(
      "model_test",
      JSON.stringify({
        name: "test",
        baseUrl: "https://provider.example/v1",
        model: "fixture",
        protocol: "chat",
        inputPrice: null,
        outputPrice: null,
      }),
      await seal("fixture-key", env.MASTER_KEY, "model:model_test:1"),
      JSON.stringify({
        connection: true,
        tools: true,
        structured: "schema",
        vision: false,
        testedAt: null,
      }),
      dbTime(new Date().toISOString()),
    );
  const created = await request("/api/user/threads", { modelId: "model_test" });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const turnId = "dispatch_turn";
  sql.prepare("UPDATE ai_threads SET active_turn=? WHERE id=?").run(turnId, created.data.id);
  const thread = sql.prepare("SELECT * FROM ai_threads WHERE id=?").get(created.data.id)!;
  assert.equal(typeof thread.id, "string");
  const input = {
    title: "读取账号状态",
    goal: "依次读取这些账号的状态",
    entryUrl: "https://example.com",
    accountId: accounts[0],
    allowedActions: ["read", "navigate"] as ("read" | "navigate")[],
    verification: { kind: "goal" as const, value: "读取状态" },
    schedule: { kind: "manual" as const },
  };
  async function start(ids = accounts) {
    await commitDecision(env, thread, turnId, input, { accountIds: ids });
  }
  async function take(device: keyof typeof tokens, id: string) {
    const result = await request(
      "/api/runner/claim",
      { requestId: id, protocolVersion: PROTOCOL_VERSION },
      device,
    );
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data.run as TaskRun | null;
  }
  return {
    db,
    sql,
    env,
    accounts,
    thread: { ...thread, id: thread.id as string },
    turnId,
    input,
    request,
    start,
    take,
  };
}

test("多账号交办固定成员，重试只投递首项，未开始成员没有过期窗口", async (t) => {
  const s = await fixture(t);
  await s.start();
  await s.start();
  await drainCommands(s.env);
  await advanceDispatchGroups(s.db);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM runs").get()!.n, 1);
  assert.deepEqual(
    s.sql
      .prepare("SELECT account_id,state FROM account_dispatch_members ORDER BY position")
      .all()
      .map((r) => [r.account_id, r.state]),
    s.accounts.map((id, i) => [id, i === 0 ? "enqueued" : "pending"]),
  );
  const run = (await s.take("d1", "first"))!;
  assert.equal(run.accountId, s.accounts[0]);
  assert.equal(run.dispatchTotal, 3);
  assert.equal(run.dispatchIndex, 0);
  assert.equal(run.accountName, "甲账号");
  assert.equal(run.task.accountIds, undefined);
  assert.equal(await s.take("d2", "cannot-parallel"), null);
  const snapshot = await s.request("/api/user/snapshot");
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.data.runs[0].dispatchGroupActive, true);
  assert.equal(snapshot.data.runs[0].dispatchTotal, 3);
});

test("业务终态仍保留账号占用，关闭确认后才推进；普通失败继续", async (t) => {
  const s = await fixture(t);
  await s.start();
  const first = (await s.take("d1", "first"))!;
  const finished = await s.request(
    `/api/runner/runs/${first.id}/finish`,
    {
      epoch: first.leaseEpoch,
      status: "failed",
      result: { summary: "此账号暂不可用", outcome: "reported", evidence: [] },
    },
    "d1",
  );
  assert.equal(finished.status, 200, JSON.stringify(finished.data));
  await tick(s.db);
  await advanceDispatchGroups(s.db);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM runs").get()!.n, 1);
  assert.ok(s.sql.prepare("SELECT run_id FROM account_locks WHERE run_id=?").get(first.id));
  assert.equal(await s.take("d2", "before-close"), null);
  const closed = await s.request(
    `/api/runner/runs/${first.id}/browser-closed`,
    { epoch: first.leaseEpoch },
    "d1",
  );
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  await tick(s.db);
  await Promise.all([advanceDispatchGroups(s.db), advanceDispatchGroups(s.db)]);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM runs").get()!.n, 2);
  const second = (await s.take("d2", "after-close"))!;
  assert.equal(second.accountId, s.accounts[1]);
  assert.notEqual(first.profileId, second.profileId);
  assert.equal(second.dispatchIndex, 1);
});

test("结果未知暂停整组，用户停止取消剩余成员但不释放未知账号锁", async (t) => {
  const s = await fixture(t);
  await s.start();
  const first = (await s.take("d1", "first"))!;
  const finished = await s.request(
    `/api/runner/runs/${first.id}/finish`,
    {
      epoch: first.leaseEpoch,
      status: "unknown",
      result: { summary: "提交结果未返回", outcome: "unconfirmed", evidence: [] },
    },
    "d1",
  );
  assert.equal(finished.status, 200, JSON.stringify(finished.data));
  const closed = await s.request(
    `/api/runner/runs/${first.id}/browser-closed`,
    { epoch: first.leaseEpoch },
    "d1",
  );
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  await tick(s.db);
  await advanceDispatchGroups(s.db);
  assert.equal(s.sql.prepare("SELECT state FROM account_dispatch_groups").get()!.state, "paused");
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM runs").get()!.n, 1);
  const stopped = await s.request(`/api/user/runs/${first.id}/cancel`, {});
  assert.equal(stopped.status, 200, JSON.stringify(stopped.data));
  await advanceDispatchGroups(s.db);
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM account_dispatch_members WHERE state='pending'").get()!.n,
    0,
  );
  assert.ok(s.sql.prepare("SELECT run_id FROM account_locks WHERE run_id=?").get(first.id));
});

test("首选设备在线空闲时保留分配，暂停或离线时自动换设备", async (t) => {
  const s = await fixture(t);
  s.sql.prepare("UPDATE accounts SET last_device_id=? WHERE id=?").run("d1", s.accounts[0]);
  await s.start([s.accounts[0]]);
  assert.equal(await s.take("d2", "prefer-original"), null);
  s.sql.prepare("UPDATE devices SET claim_ready=0 WHERE id='d1'").run();
  const run = (await s.take("d2", "original-paused"))!;
  assert.equal(run.deviceId, "d2");
  assert.equal(
    s.sql.prepare("SELECT assigned_device_id FROM accounts WHERE id=?").get(s.accounts[0])!
      .assigned_device_id,
    "d2",
  );
});

test("域名按精确host匹配，拒绝跨用户和后缀伪装账号", async (t) => {
  const s = await fixture(t);
  await assert.rejects(
    () =>
      commitDecision(
        s.env,
        s.thread,
        s.turnId,
        { ...s.input, entryUrl: "https://example.com.evil.example.net" },
        { accountIds: [s.accounts[0]] },
      ),
    /ACCOUNT_ORIGIN_MISMATCH/,
  );
  s.sql.prepare("INSERT INTO members(id) VALUES('other_user')").run();
  s.sql.prepare("UPDATE accounts SET user_id=? WHERE id=?").run("other_user", s.accounts[1]);
  await assert.rejects(() => s.start([s.accounts[0], s.accounts[1]]), /ACCOUNT_ORIGIN_MISMATCH/);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM account_dispatch_groups").get()!.n, 0);
});

test("聊天关闭在事务中退休未开始成员，旧投递命令不能继续创建运行", async (t) => {
  const s = await fixture(t);
  await s.start();
  s.sql.prepare("UPDATE ai_threads SET closed=1 WHERE id=?").run(s.thread.id);
  await drainCommands(s.env);
  await advanceDispatchGroups(s.db);
  assert.equal(s.sql.prepare("SELECT state FROM account_dispatch_groups").get()!.state, "retired");
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM account_dispatch_members WHERE state='pending'").get()!.n,
    0,
  );
  assert.equal(await s.take("d1", "after-retire"), null);
});

test("租约过期且无写操作也必须等待旧浏览器清理，不能换机重叠运行", async (t) => {
  const s = await fixture(t);
  const definition = await insertTask(s.db, task({ id: "standalone", accountId: s.accounts[0] }));
  await enqueue(s.db, definition, "lease-old");
  const first = (await claim(s.db, "d1", "lease-claim"))!;
  s.sql.prepare("UPDATE runs SET lease_expires_at=946684800000 WHERE id=?").run(first.id);
  await tick(s.db);
  await enqueue(s.db, definition, "lease-new");
  assert.equal(s.sql.prepare("SELECT status FROM runs WHERE id=?").get(first.id)!.status, "failed");
  assert.ok(s.sql.prepare("SELECT run_id FROM account_locks WHERE run_id=?").get(first.id));
  assert.equal(await claim(s.db, "d2", "no-overlap"), null);
});

test("未绑定账号的运行不复用已转正目录，领取重试仍返回同一目录", async (t) => {
  const s = await fixture(t);
  const definition = await insertTask(s.db, task({ id: "temporary", accountId: null }));
  const one = await enqueue(s.db, definition, "temporary-one");
  const retry = await enqueue(s.db, definition, "temporary-one");
  const two = await enqueue(s.db, definition, "temporary-two");
  assert.equal(one.profileId, retry.profileId);
  assert.notEqual(one.profileId, two.profileId);
  s.sql.prepare("UPDATE accounts SET profile_id=? WHERE id=?").run(one.profileId, s.accounts[0]);
  const next = await enqueue(s.db, definition, "temporary-after-save");
  assert.notEqual(next.profileId, one.profileId);
});

test("账号执行组完成后立即运行复用整组，重复请求不新增执行", async (t) => {
  const s = await fixture(t);
  await s.start(s.accounts.slice(0, 2));
  for (let index = 0; index < 2; index++) {
    const run = (await s.take("d1", `group-${index}`))!;
    assert.equal(
      (
        await s.request(
          `/api/runner/runs/${run.id}/finish`,
          {
            epoch: run.leaseEpoch,
            status: "succeeded",
            result: { summary: "已读", outcome: "reported", evidence: [] },
          },
          "d1",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await s.request(
          `/api/runner/runs/${run.id}/browser-closed`,
          { epoch: run.leaseEpoch },
          "d1",
        )
      ).status,
      200,
    );
  }
  const taskId = s.sql
    .prepare("SELECT task_id FROM ai_threads WHERE id=?")
    .get(s.thread.id)!.task_id;
  assert.equal(typeof taskId, "string");
  const first = await s.request(`/api/user/tasks/${taskId as string}/run`, {
    requestId: "rerun-both",
  });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const repeat = await s.request(`/api/user/tasks/${taskId as string}/run`, {
    requestId: "rerun-both",
  });
  assert.equal(repeat.status, 200);
  assert.equal(first.data.id, repeat.data.id);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM account_dispatch_groups").get()!.n, 2);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM runs").get()!.n, 3);
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM account_dispatch_members WHERE state='pending'").get()!.n,
    1,
  );
});

test("管理员确认停机迁移保留已发布状态并退休旧候选，迟到关闭不能重新发布", async (t) => {
  const s = await fixture(t);
  await s.start([s.accounts[0]]);
  const run = (await s.take("d1", "first"))!;
  s.sql
    .prepare("UPDATE accounts SET state_revision=3,state_object_key='published_fixture' WHERE id=?")
    .run(s.accounts[0]);
  const at = new Date().toISOString();
  s.sql
    .prepare(
      `INSERT INTO browser_state_candidates(object_key,user_id,account_id,run_id,device_id,lease_epoch,credential_version,state_epoch,base_revision,origins,created_at,expires_at)
    VALUES('candidate_before_migrate','fixture_owner',?,?,?,?,1,1,3,'["https://example.com"]',?,4070908800000)`,
    )
    .run(s.accounts[0], run.id, "d1", run.leaseEpoch, dbTime(at));
  s.sql
    .prepare("UPDATE runs SET state_candidate_key='candidate_before_migrate' WHERE id=?")
    .run(run.id);
  assert.equal(
    (
      await s.request(
        `/api/runner/runs/${run.id}/finish`,
        {
          epoch: run.leaseEpoch,
          status: "failed",
          result: { summary: "执行已结束", outcome: "reported", evidence: [] },
        },
        "d1",
      )
    ).status,
    200,
  );
  const moved = await s.request(`/api/admin/accounts/${s.accounts[0]}/migrate`, {
    deviceId: "d2",
    oldExecutionStopped: true,
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.data.requiresLogin, false);
  assert.equal(
    s.sql.prepare("SELECT profile_id FROM accounts WHERE id=?").get(s.accounts[0])!.profile_id,
    run.profileId,
  );
  assert.equal(
    s.sql
      .prepare(
        "SELECT retired FROM browser_state_candidates WHERE object_key='candidate_before_migrate'",
      )
      .get()!.retired,
    1,
  );
  assert.equal(
    (await s.request(`/api/runner/runs/${run.id}/browser-closed`, { epoch: run.leaseEpoch }, "d1"))
      .status,
    200,
  );
  const saved = s.sql
    .prepare("SELECT state_revision,state_object_key FROM accounts WHERE id=?")
    .get(s.accounts[0])!;
  assert.equal(saved.state_revision, 3);
  assert.equal(saved.state_object_key, "published_fixture");
});

test("成员关闭间隙的补充交给后继账号，不另起冲突规划", async (t) => {
  const s = await fixture(t);
  await s.start(s.accounts.slice(0, 2));
  const first = (await s.take("d1", "first"))!;
  assert.equal(
    (
      await s.request(
        `/api/runner/runs/${first.id}/finish`,
        {
          epoch: first.leaseEpoch,
          status: "succeeded",
          result: { summary: "甲已读", outcome: "reported", evidence: [] },
        },
        "d1",
      )
    ).status,
    200,
  );
  const sent = await s.request(`/api/user/threads/${s.thread.id}/messages`, {
    requestId: "between-members",
    content: "后续账号也请读取余额",
  });
  assert.equal(sent.status, 202, JSON.stringify(sent.data));
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ai_turns").get()!.n, 0);
  assert.equal(
    s.sql.prepare("SELECT content FROM message_details WHERE role='user'").get()!.content,
    "[用户已提供私密信息]",
  );
  assert.equal(
    (
      await s.request(
        `/api/runner/runs/${first.id}/browser-closed`,
        { epoch: first.leaseEpoch },
        "d1",
      )
    ).status,
    200,
  );
  const next = (await s.take("d1", "second"))!;
  const context = await s.request(
    `/api/runner/runs/${next.id}/context`,
    { epoch: next.leaseEpoch, after: 0 },
    "d1",
  );
  assert.equal(context.status, 200, JSON.stringify(context.data));
  assert.ok(JSON.stringify(context.data).includes("后续账号也请读取余额"));
});

test("最终成员关闭前的新交办留在inbox，关闭后才开始规划", async (t) => {
  const s = await fixture(t);
  await s.start([s.accounts[0]]);
  const run = (await s.take("d1", "first"))!;
  s.sql.prepare("UPDATE ai_threads SET active_turn=NULL WHERE id=?").run(s.thread.id);
  assert.equal(
    (
      await s.request(
        `/api/runner/runs/${run.id}/finish`,
        {
          epoch: run.leaseEpoch,
          status: "succeeded",
          result: { summary: "已完成", outcome: "reported", evidence: [] },
        },
        "d1",
      )
    ).status,
    200,
  );
  s.env.AI_TURNS = {
    getByName: () => ({ enqueue: async () => {} }),
  } as unknown as AppEnv["AI_TURNS"];
  const sent = await s.request(`/api/user/threads/${s.thread.id}/messages`, {
    requestId: "after-last",
    content: "再查看另一个网站",
  });
  assert.equal(sent.status, 202, JSON.stringify(sent.data));
  assert.equal(s.sql.prepare("SELECT status FROM conversation_inbox").get()!.status, "pending");
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ai_turns").get()!.n, 0);
  assert.equal(
    (await s.request(`/api/runner/runs/${run.id}/browser-closed`, { epoch: run.leaseEpoch }, "d1"))
      .status,
    200,
  );
  await promoteInbox(s.env, String(s.thread.id));
  assert.equal(s.sql.prepare("SELECT status FROM conversation_inbox").get()!.status, "processing");
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ai_turns").get()!.n, 1);
});

test("交办落地后已有排队消息成为完整加密补充，并清除inbox原文副本", async (t) => {
  const s = await fixture(t);
  await s.start([s.accounts[0]]);
  const content = "补充原文：登录后先查看通知，再读取余额。";
  s.sql
    .prepare(
      "INSERT INTO conversation_inbox(id,thread_id,request_id,digest,content,created_at) VALUES('queued_extra',?,'queued-extra',?,?,?)",
    )
    .run(s.thread.id, await hash(content), content, dbTime(new Date().toISOString()));
  await promoteInbox(s.env, String(s.thread.id));
  await promoteInbox(s.env, String(s.thread.id));
  const inbox = s.sql
    .prepare("SELECT status,content FROM conversation_inbox WHERE id='queued_extra'")
    .get()!;
  assert.equal(inbox.status, "done");
  assert.equal(inbox.content, "");
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM ai_messages WHERE id='queued_extra_user'").get()!.n,
    1,
  );
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ai_turns").get()!.n, 0);
  const run = (await s.take("d1", "with-extra"))!;
  const context = await s.request(
    `/api/runner/runs/${run.id}/context`,
    { epoch: run.leaseEpoch, after: 0 },
    "d1",
  );
  assert.equal(
    context.data.messages.find((message: { id: string }) => message.id === "queued_extra_user")
      .content,
    content,
  );
});
