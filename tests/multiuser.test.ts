import { dbTime } from "../apps/cloud/src/database";
import { finishRequest, browserClosedRequest } from "./runner-request";
import { PROTOCOL_VERSION } from "../packages/contracts/src/index";
import { commitDecision } from "../apps/cloud/src/ai/commands";
import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword } from "better-auth/crypto";
import { app } from "../apps/cloud/src/index";
import type { AppEnv } from "../apps/cloud/src/env";
import { testDb, task, insertTask } from "./helpers";
import { claim, enqueue, queueReasons } from "../apps/cloud/src/store";
import { quotaDay, quotaReset, reserve, quotaSummary } from "../apps/cloud/src/tenancy";
import { hash } from "../packages/contracts/src/security";

async function fixture() {
  const { db, sql } = testDb();
  const env = {
    DB: db,
    DEV_MODE: "0",
    AUTH_BASE_URL: "http://localhost",
    AUTH_SECRET: "multiuser-test-secret-at-least-32-characters",
    OWNER_EMAIL: "owner@example.com",
    MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
    REGISTRATION_OPEN: "0",
  } as unknown as AppEnv;
  const password = "fixture-long-password";
  const digest = await hashPassword(password);
  async function request(
    path: string,
    cookie = "",
    body?: unknown,
    method = body ? "POST" : "GET",
  ) {
    return app.request(
      "http://localhost" + path,
      {
        method,
        headers: { "Content-Type": "application/json", Origin: "http://localhost", Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  }
  const cookies: Record<string, string> = {};
  for (const [id, email] of [
    ["alice", "alice@example.com"],
    ["bob", "bob@example.com"],
    ["owner", "owner@example.com"],
  ]) {
    const at = Date.now();
    sql
      .prepare(
        "INSERT INTO auth_user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)",
      )
      .run(id, id, email, dbTime(at), dbTime(at));
    sql
      .prepare(
        "INSERT INTO auth_account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,'credential',?,?,?,?)",
      )
      .run(id, id, id, digest, dbTime(at), dbTime(at));
    const login = await request("/api/auth/sign-in/email", "", { email, password });
    assert.equal(login.status, 200, await login.clone().text());
    cookies[id] = login.headers
      .getSetCookie()
      .map((x) => x.split(";")[0])
      .join("; ");
    const me = await request("/api/user/me", cookies[id]);
    assert.equal(me.status, 200, await me.clone().text());
  }
  for (const d of ["d1", "d2"])
    sql
      .prepare(
        "INSERT INTO devices(id,name,token_hash,protocol_version,last_seen) VALUES(?,?,?,?,?)",
      )
      .run(
        d,
        d,
        await hash((d === "d1" ? "a" : "b").repeat(64)),
        PROTOCOL_VERSION,
        dbTime(new Date().toISOString()),
      );
  async function ownedTask(user: string, id: string, accountId: string | null = null) {
    const t = await insertTask(db, task({ id, accountId }), user);
    return t;
  }
  return { db, sql, env, request, cookies, ownedTask };
}

test("发布恢复记录拥有领取开关，管理员不能覆盖进行中的暂停", async (context) => {
  const s = await fixture();
  context.after(() => s.sql.close());
  s.sql
    .prepare("INSERT INTO settings(key,value) VALUES('productionRelease',?)")
    .run(JSON.stringify({ phase: "paused" }));
  const blocked = await s.request(
    "/api/admin/pool",
    s.cookies.owner,
    { claimsEnabled: true },
    "PUT",
  );
  assert.equal(blocked.status, 409);
  assert.deepEqual(await blocked.json(), { error: "RELEASE_IN_PROGRESS" });
  s.sql
    .prepare("UPDATE settings SET value=? WHERE key='productionRelease'")
    .run(JSON.stringify({ phase: "complete" }));
  assert.equal(
    (await s.request("/api/admin/pool", s.cookies.owner, { claimsEnabled: true }, "PUT")).status,
    200,
  );
  assert.equal(
    s.sql.prepare("SELECT value FROM settings WHERE key='claimsEnabled'").get()!.value,
    "1",
  );
});

test("个人日限额支持到期或手动恢复，不绕过用户隔离、禁用、并发", async () => {
  const s = await fixture();
  try {
    const task = await s.ownedTask("alice", "paused_quota_task");
    s.sql
      .prepare(
        "UPDATE members SET daily_quota_paused=0,daily_runs=0,daily_models=0,daily_chat=0 WHERE id='alice'",
      )
      .run();
    const queued = await enqueue(s.db, task, "pause-a");
    assert.equal(await claim(s.db, "d1", "before-pause"), null);
    await assert.rejects(() => reserve(s.env, "alice", "chat"), /CHAT_QUOTA_EXCEEDED/);
    const until = new Date(Date.now() + 3600000).toISOString();
    s.sql
      .prepare("UPDATE members SET daily_quota_paused_until=? WHERE id='alice'")
      .run(dbTime(until));
    assert.equal((await quotaSummary(s.db, "alice")).pausedUntil, until);
    assert.doesNotMatch((await queueReasons(s.db, "alice")).get(queued.id)!, /额度已用完/);
    await reserve(s.env, "alice", "chat");
    await reserve(s.env, "alice", "model");
    const run = (await claim(s.db, "d1", "paused-claim"))!;
    assert.equal(run.id, queued.id);
    const next = await enqueue(s.db, task, "manual:pause-b");
    assert.equal(await claim(s.db, "d2", "still-single"), null);
    s.sql.prepare("UPDATE members SET daily_quota_paused=0,daily_chat=0 WHERE id='bob'").run();
    await assert.rejects(() => reserve(s.env, "bob", "chat"), /CHAT_QUOTA_EXCEEDED/);
    await reserve(s.env, "alice", "model");
    s.sql.prepare("UPDATE members SET disabled=1 WHERE id='alice'").run();
    await assert.rejects(() => reserve(s.env, "alice", "chat"), /CHAT_QUOTA_EXCEEDED/);
    s.sql
      .prepare(
        "UPDATE members SET disabled=0,daily_quota_paused_until=946684800000 WHERE id='alice'",
      )
      .run();
    assert.equal(
      (
        await finishRequest(s.db, run, "succeeded", {
          summary: "read only",
          evidence: [],
          outcome: "reported",
        })
      ).status,
      200,
    );
    assert.equal((await browserClosedRequest(s.db, run)).status, 200);
    assert.equal((await quotaSummary(s.db, "alice")).pausedUntil, null);
    assert.equal((await quotaSummary(s.db, "alice")).limits.runs, 0, "原额度没有被覆盖");
    assert.equal(await claim(s.db, "d1", "expired-pause"), null);
    await assert.rejects(() => reserve(s.env, "alice", "chat"), /CHAT_QUOTA_EXCEEDED/);
    assert.throws(
      () =>
        s.sql
          .prepare("UPDATE runs SET status='running',started_day=? WHERE id=?")
          .run(quotaDay(), next.id),
      /RUN_QUOTA_EXCEEDED/,
    );
    s.sql.prepare("UPDATE members SET daily_quota_paused=1 WHERE id='alice'").run();
    const manual = await quotaSummary(s.db, "alice");
    assert.equal(manual.paused, true);
    assert.equal(manual.pausedUntil, null, "手动关闭不受已到期时间影响");
    await reserve(s.env, "alice", "chat");
    const resumed = (await claim(s.db, "d1", "manual-pause"))!;
    assert.equal(resumed.id, next.id);
    assert.equal(
      (
        await finishRequest(s.db, resumed, "succeeded", {
          summary: "read only",
          evidence: [],
          outcome: "reported",
        })
      ).status,
      200,
    );
    assert.equal((await browserClosedRequest(s.db, resumed)).status, 200);
    s.sql.prepare("UPDATE members SET daily_quota_paused=0 WHERE id='alice'").run();
    assert.equal((await quotaSummary(s.db, "alice")).paused, false);
    await assert.rejects(() => reserve(s.env, "alice", "chat"), /CHAT_QUOTA_EXCEEDED/);
  } finally {
    s.sql.close();
  }
});

test("真实登录会话隔离任务、运行、对话、协助、证据和用量；设备不能管理用户", async () => {
  const s = await fixture();
  const ta = await s.ownedTask("alice", "ta"),
    tb = await s.ownedTask("bob", "tb");
  const a = await enqueue(s.db, ta, "alice-key"),
    b = await enqueue(s.db, tb, "bob-key");
  s.sql
    .prepare(
      "INSERT INTO artifacts(id,run_id,object_key,content_type,expires_at) VALUES('artifact_b',?,'private','image/png',4070908800000)",
    )
    .run(b.id);
  for (const who of ["alice", "owner"]) {
    for (const path of [
      `/tasks/${tb.id}`,
      `/tasks/${tb.id}/conversation`,
      `/runs/${b.id}`,
      `/runs/${b.id}/usage`,
      `/artifacts/artifact_b`,
    ]) {
      assert.equal((await s.request("/api/user" + path, s.cookies[who])).status, 404, path);
    }
  }
  const snapshot = (await (await s.request("/api/user/snapshot", s.cookies.alice)).json()) as any;
  assert.deepEqual(
    snapshot.tasks.map((x: any) => x.id),
    [ta.id],
  );
  assert.deepEqual(
    snapshot.runs.map((x: any) => x.id),
    [a.id],
  );
  assert.deepEqual(snapshot.devices, []);
  assert.equal((await s.request("/api/admin/operations", s.cookies.alice)).status, 403);
  assert.equal((await s.request("/api/admin/operations", s.cookies.owner)).status, 200);
  for (const path of ["/api/user/snapshot", "/api/admin/operations", "/api/device/user/snapshot"]) {
    const r = await app.request(
      "http://localhost" + path,
      {
        headers: {
          "x-taskrelay-protocol": String(PROTOCOL_VERSION),
          Authorization: "Bearer " + "a".repeat(64),
        },
      },
      s.env,
    );
    assert.equal(r.status, 403, path);
  }
});

test("两用户两设备公平领取，并发一，领取重试只记一次额度", async () => {
  const s = await fixture();
  const ta = await s.ownedTask("alice", "ta"),
    tb = await s.ownedTask("bob", "tb");
  s.sql.prepare("UPDATE members SET last_claim_at=1767225600000 WHERE id='alice'").run();
  await enqueue(s.db, ta, "a1");
  await enqueue(s.db, ta, "a2");
  await enqueue(s.db, tb, "b1");
  const first = (await claim(s.db, "d1", "first"))!;
  assert.equal(first.userId, "bob");
  const second = (await claim(s.db, "d2", "second"))!;
  assert.equal(second.userId, "alice");
  assert.equal((await claim(s.db, "d1", "first"))?.id, first.id);
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM runs WHERE started_day IS NOT NULL").get()!.n,
    2,
  );
  s.sql.prepare("UPDATE runs SET status='waiting_user' WHERE id=?").run(second.id);
  assert.equal(
    (
      await finishRequest(s.db, first, "succeeded", {
        summary: "done",
        evidence: [],
        outcome: "reported",
      })
    ).status,
    200,
  );
  assert.equal((await browserClosedRequest(s.db, first)).status, 200);
  assert.equal(await claim(s.db, "d1", "third"), null);
});

test("个人模型额度并发预占与上海跨日，不因未知结果返还", async () => {
  const s = await fixture();
  s.sql.prepare("UPDATE members SET daily_quota_paused=0,daily_models=2 WHERE id='alice'").run();
  const attempts = await Promise.allSettled(
    Array.from({ length: 6 }, () => reserve(s.env, "alice", "model")),
  );
  assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 2);
  await reserve(s.env, "bob", "model");
  s.sql.prepare("UPDATE quota_reservations SET day='2000-01-01'").run();
  await reserve(s.env, "bob", "model");
  assert.equal(quotaDay(Date.parse("2026-11-03T15:59:59Z")), "2026-11-03");
  assert.equal(quotaDay(Date.parse("2026-11-03T16:00:00Z")), "2026-11-04");
  assert.equal(quotaReset(Date.parse("2026-11-03T15:59:59Z")), "2026-11-03T16:00:00.000Z");
});

test("修改密码的数据库提交同时撤销所有会话", async () => {
  const s = await fixture();
  const r = await s.request("/api/auth/change-password", s.cookies.alice, {
    currentPassword: "fixture-long-password",
    newPassword: "replacement-long-password",
    revokeOtherSessions: true,
  });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await s.request("/api/user/me", s.cookies.alice)).status, 401);
  assert.equal((await s.request("/api/user/me", s.cookies.bob)).status, 200);
});

test("两用户使用同一幂等编号仍各自创建任务；账号、协助、证据和含用量报告互相隔离", async () => {
  const s = await fixture();
  s.env.EVIDENCE_STORE = {
    getByName: () => ({ get: async () => new Uint8Array([1, 2, 3]).buffer }),
  } as any;
  s.sql
    .prepare(
      "INSERT INTO model_profile_versions(id,version,config,connection_id,effective_region,capabilities,created_at) VALUES(?,1,?,'conn_test','us',?,?)",
    )
    .run(
      "model_test",
      JSON.stringify({
        name: "shared",
        region: "inherit",
        model: "test",
        protocol: "responses",
        inputPrice: 1,
        outputPrice: 1,
      }),
      JSON.stringify({
        connection: true,
        tools: true,
        structured: "schema",
        vision: false,
        testedAt: null,
      }),
      dbTime(new Date().toISOString()),
    );
  async function create(who: string, input: any, requestId: string) {
    const thread = (await (
      await s.request("/api/user/threads", s.cookies[who], { modelId: "model_test" })
    ).json()) as any;
    const turnId = thread.id + "_" + requestId;
    s.sql.prepare("UPDATE ai_threads SET active_turn=? WHERE id=?").run(turnId, thread.id);
    const t = s.sql.prepare("SELECT * FROM ai_threads WHERE id=?").get(thread.id)!;
    const { modelId: _modelId, ...task } = input;
    await commitDecision({ ...s.env, requestUserId: who }, t, turnId, task);
    await commitDecision({ ...s.env, requestUserId: who }, t, turnId, task);
    return String(
      s.sql.prepare("SELECT task_id FROM ai_threads WHERE id=?").get(thread.id)!.task_id,
    );
  }
  const accounts: Record<string, string> = {},
    tasks: Record<string, string> = {},
    runs: Record<string, string> = {};
  for (const who of ["alice", "bob"]) {
    const created = await s.request("/api/user/accounts", s.cookies[who], {
      name: who,
      origin: "https://example.com",
      username: "fixture",
      password: "fixture",
    });
    assert.equal(created.status, 201);
    accounts[who] = ((await created.json()) as any).id;
  }
  const input = (accountId: string) => ({
    title: "read",
    goal: "Read status",
    entryUrl: "https://example.com/",
    accountId,
    modelId: "model_test",
    allowedActions: ["read", "navigate"],
    verification: { kind: "goal", value: "Example Domain" },
    schedule: { kind: "manual" },
  });
  for (const who of ["alice", "bob"]) {
    const other = who === "alice" ? "bob" : "alice";
    await assert.rejects(
      () => create(who, input(accounts[other]), "foreign_account"),
      /ACCOUNT_ORIGIN_MISMATCH/,
    );
    tasks[who] = await create(who, input(accounts[who]), "same_request_id");
    const snapshot = (await (await s.request("/api/user/snapshot", s.cookies[who])).json()) as any;
    assert.deepEqual(
      snapshot.accounts.map((a: any) => a.id),
      [accounts[who]],
    );
    runs[who] = snapshot.runs[0].id;
    s.sql
      .prepare(
        "INSERT INTO artifacts(id,run_id,object_key,content_type,expires_at) VALUES(?,?,?,?,?)",
      )
      .run("image_" + who, runs[who], who, "image/png", dbTime("2099-01-01"));
    s.sql
      .prepare(
        "INSERT INTO model_usage(id,run_id,model_id,model_version,input_tokens,output_tokens,at,user_id) VALUES(?,?,?,1,11,20,?,?)",
      )
      .run("usage_" + who, runs[who], "model_test", dbTime(new Date().toISOString()), who);
  }
  assert.notEqual(tasks.alice, tasks.bob);
  for (const who of ["alice", "bob"]) {
    const other = who === "alice" ? "bob" : "alice",
      cookie = s.cookies[who];
    assert.equal(
      (await s.request("/api/user/threads", cookie, { taskId: tasks[who], modelId: "model_test" }))
        .status,
      200,
    );
    assert.equal((await s.request("/api/user/artifacts/image_" + who, cookie)).status, 200);
    const report = await s.request("/api/user/runs/" + runs[who], cookie);
    assert.equal(report.status, 200);
    assert.equal(((await report.json()) as any).usage.length, 1);
    for (const [path, body] of [
      [`/tasks/${tasks[other]}/chat`, undefined],
      [`/runs/${runs[other]}`, undefined],
      [`/runs/${runs[other]}/cancel`, {}],
      [`/artifacts/image_${other}`, undefined],
    ] as const) {
      assert.equal((await s.request("/api/user" + path, cookie, body)).status, 404, path);
    }
  }
});
