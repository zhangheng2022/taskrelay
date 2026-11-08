import { dbTime } from "../apps/cloud/src/database";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { app } from "../apps/cloud/src/index";
import type { AppEnv } from "../apps/cloud/src/env";
import { claim, enqueue, now, tick, type Row } from "../apps/cloud/src/store";
import { PROTOCOL_VERSION, type TaskRun } from "../packages/contracts/src/index";
import type { BrowserState } from "../packages/contracts/src/accounts";
import { hash } from "../packages/contracts/src/security";
import { testDb, insertTask, task } from "./helpers";
import { linkAccountSnapshot, publishBrowserState } from "../apps/cloud/src/browser-state";

// 真实云端路由与 SQLite 事务；DO 仅替换对象传输，不把本机 stand-in 当作 D1 并发/部署证据。
const accountInput = {
  name: "会话账号",
  origin: "https://shop.example.com",
  businessDomains: ["shop.example.com"],
  loginOrigins: ["https://login.example.com"],
  username: "state@example.com",
  password: "fixture-session-secret",
};
function state(value = "session"): BrowserState {
  return {
    version: 1,
    cookies: [
      {
        name: "session",
        value,
        domain: ".example.com",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "None",
      },
      {
        name: "partition",
        value: "one",
        domain: "login.example.com",
        path: "/",
        secure: true,
        partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: true },
      },
      { name: "other-site", value: "not-exported", domain: "unrelated.example.org", path: "/" },
    ],
    origins: [
      { origin: accountInput.origin, localStorage: [["token", value]] },
      { origin: "https://unrelated.example.org", localStorage: [["private", "not-exported"]] },
    ],
  };
}
async function fixture(t: TestContext, bound = true) {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  const objects = new Map<string, ArrayBuffer>(),
    reads: string[] = [];
  const env = {
    DB: db,
    MASTER_KEY: Buffer.alloc(32, 4).toString("base64"),
    DEV_MODE: "1",
    BROWSER_STATES: {
      getByName: (key: string) => ({
        put: async (name: string, value: ArrayBuffer) => {
          assert.equal(name, key);
          objects.set(key, value.slice(0));
        },
        get: async (name: string) => {
          assert.equal(name, key);
          reads.push(key);
          return objects.get(key)?.slice(0) ?? null;
        },
      }),
    },
  } as unknown as AppEnv;
  const token = "d".repeat(64);
  await db
    .prepare("INSERT INTO devices(id,name,token_hash,protocol_version) VALUES(?,?,?,?)")
    .bind("device_state", "fixture", await hash(token), PROTOCOL_VERSION)
    .run();
  const request = async (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await app.request(
      `http://localhost${path}`,
      {
        method,
        headers: {
          "content-type": "application/json",
          ...(path.startsWith("/api/runner/")
            ? { authorization: `Bearer ${token}`, "x-taskrelay-protocol": String(PROTOCOL_VERSION) }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
    return { status: response.status, data: (await response.json()) as Record<string, any> };
  };
  const accountId = bound ? (await request("/api/user/accounts", accountInput)).data.id : null;
  const definition = await insertTask(db, task({ accountId, entryUrl: accountInput.origin }));
  await db
    .prepare(
      `INSERT INTO ai_threads(id,user_id,task_id,kind,model_id,model_version,created_at,updated_at) VALUES('thread_state','fixture_owner',?,'chat','model_test',1,?,?)`,
    )
    .bind(definition.id, dbTime(now()), dbTime(now()))
    .run();
  let sequence = 0;
  const next = async () => {
    const n = ++sequence;
    await enqueue(db, definition, `state_${n}`);
    const run = await claim(db, "device_state", `state_claim_${n}`);
    assert.ok(run);
    return run;
  };
  const run = await next();
  const call = (run: TaskRun, path: string, body: Record<string, unknown> = {}) =>
    request(`/api/runner/runs/${run.id}/${path}`, { epoch: run.leaseEpoch, ...body });
  const upload = (run: TaskRun, value = state(), baseRevision = 0) =>
    call(run, "browser-state/upload", { state: value, baseRevision });
  const finish = async (run: TaskRun, key: string | null, status = "succeeded") =>
    call(run, "finish", {
      status,
      result: { summary: "结束", outcome: "reported", evidence: [] },
      stateCandidateKey: key,
    });
  const close = (run: TaskRun) => call(run, "browser-closed");
  const account = () =>
    sql.prepare("SELECT * FROM account_details WHERE id=?").get(accountId) as Row;
  return {
    db,
    sql,
    env,
    objects,
    reads,
    request,
    run,
    call,
    upload,
    finish,
    close,
    next,
    account,
    accountId,
  };
}

test("快照需finish及真实关闭确认才发布；候选隔离域名、分区Cookie并幂等释放", async (t) => {
  const s = await fixture(t),
    uploaded = await s.upload(s.run);
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  const key = uploaded.data.key;
  assert.equal(s.account().state_object_key, null);
  const candidate = JSON.parse(new TextDecoder().decode(s.objects.get(key)));
  assert.equal(candidate.cookies.length, 2);
  assert.equal(candidate.origins.length, 1);
  assert.deepEqual(candidate.cookies[1].partitionKey, {
    topLevelSite: "https://example.com",
    hasCrossSiteAncestor: true,
  });
  assert.equal((await s.finish(s.run, key)).status, 200);
  assert.equal(s.account().state_object_key, null);
  assert.ok(s.sql.prepare("SELECT * FROM account_locks WHERE run_id=?").get(s.run.id));
  const closed = await s.close(s.run);
  assert.equal(closed.status, 200);
  assert.equal(closed.data.synced, true);
  assert.equal(s.account().state_revision, 1);
  assert.equal(s.account().state_object_key, key);
  assert.equal(
    s.sql.prepare("SELECT * FROM account_locks WHERE run_id=?").get(s.run.id),
    undefined,
  );
  assert.equal((await s.close(s.run)).data.revision, 1);
  const next = await s.next(),
    access = await s.call(next, "browser-state");
  assert.equal(access.status, 200);
  assert.equal(access.data.state.cookies[0].value, "session");
  const before = s.reads.length;
  await s.call(next, "browser-state", { metadataOnly: true });
  assert.equal(s.reads.length, before, "只读取版本不访问DO");
});

test("清除状态或改凭据后旧执行不可上传或发布，旧候选不越过版本", async (t) => {
  const s = await fixture(t),
    uploaded = await s.upload(s.run);
  assert.equal(uploaded.status, 200);
  const clear = await s.request(`/api/user/accounts/${s.accountId}/clear-state`, {
    expectedStateEpoch: 1,
  });
  assert.equal(clear.status, 200);
  const stale = await s.upload(s.run);
  assert.equal(stale.status, 400);
  assert.equal(stale.data.error, "ACCOUNT_STATE_CHANGED");
  await s.finish(s.run, uploaded.data.key);
  const closed = await s.close(s.run);
  assert.equal(closed.data.synced, false);
  assert.equal(s.account().state_object_key, null);
  assert.equal(s.account().state_revision, 0);
  const next = await s.next();
  assert.equal(next.stateEpoch, 2);
  const newer = await s.upload(next, state("new"));
  assert.equal(newer.status, 200);
  const edit = await s.request(
    `/api/user/accounts/${s.accountId}`,
    { expectedCredentialVersion: 1, password: "new-password" },
    "PATCH",
  );
  assert.equal(edit.status, 200);
  await s.finish(next, newer.data.key);
  await s.close(next);
  assert.equal(s.account().state_object_key, null);
});

for (const late of [false, true]) {
  test(`跨域落点${late ? "晚确认" : "执行中确认"}保存后可恢复登录状态，其他访问域不随之同步`, async (t) => {
    const s = await fixture(t, false);
    const landing = "https://member.example.net";
    const offered = await s.call(s.run, "account-card", {
      kind: "save",
      requestId: "cross_origin_state",
      ...accountInput,
      verified: true,
      observedOrigin: landing,
      observedOrigins: [
        accountInput.origin,
        ...accountInput.loginOrigins,
        "https://unrelated.example.org",
      ],
      evidence: "实际提交凭据后已在跨域会员页登录",
    });
    assert.equal(offered.status, 200, JSON.stringify(offered.data));
    const confirm = () =>
      s.request(`/api/user/account-cards/${offered.data.cardId}/confirm`, accountInput);
    const savedEarly = late ? null : await confirm();
    if (savedEarly) assert.equal(savedEarly.status, 200, JSON.stringify(savedEarly.data));
    const metadata = await s.call(s.run, "browser-state", { metadataOnly: true });
    assert.equal(metadata.status, 200);
    assert.deepEqual(
      [...metadata.data.origins].sort((a: string, b: string) => a.localeCompare(b)),
      [accountInput.origin, ...accountInput.loginOrigins, landing].sort(),
    );
    const snapshot = state();
    snapshot.cookies.push({
      name: "landing-session",
      value: "fixture-landing-session",
      domain: "member.example.net",
      path: "/",
      secure: true,
    });
    snapshot.origins.push({
      origin: landing,
      localStorage: [["session", "fixture-landing-token"]],
    });
    const uploaded = await s.upload(s.run, snapshot);
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
    const candidate = JSON.parse(new TextDecoder().decode(s.objects.get(uploaded.data.key)));
    assert.deepEqual(
      candidate.origins.map((entry: { origin: string }) => entry.origin),
      [accountInput.origin, landing],
    );
    assert.ok(
      candidate.cookies.some((cookie: { name: string }) => cookie.name === "landing-session"),
    );
    assert.ok(!candidate.cookies.some((cookie: { name: string }) => cookie.name === "other-site"));
    assert.equal((await s.finish(s.run, uploaded.data.key)).status, 200);
    assert.equal((await s.close(s.run)).status, 200);
    const saved = savedEarly ?? (await confirm());
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.resumed, false);
    const account = s.sql
      .prepare("SELECT * FROM account_details WHERE id=?")
      .get(saved.data.accountId)!;
    assert.equal(account.state_object_key, uploaded.data.key);
    assert.equal(account.sync_status, "synced");
    assert.deepEqual(JSON.parse(String(account.state_origins)), [landing]);
    assert.deepEqual(JSON.parse(String(account.login_origins)), accountInput.loginOrigins);
    const definition = await insertTask(
      s.db,
      task({
        id: "task_cross_origin_restore",
        accountId: saved.data.accountId,
        entryUrl: accountInput.origin,
      }),
    );
    await enqueue(s.db, definition, "cross_origin_restore");
    const next = (await claim(s.db, "device_state", "cross_origin_restore_claim"))!;
    assert.ok(next);
    const access = await s.call(next, "browser-state");
    assert.equal(access.status, 200);
    assert.equal(
      access.data.state.cookies.find(
        (cookie: { name: string }) => cookie.name === "landing-session",
      ).value,
      "fixture-landing-session",
    );
    assert.deepEqual(
      access.data.state.origins.find((entry: { origin: string }) => entry.origin === landing)
        .localStorage,
      [["session", "fixture-landing-token"]],
    );
    assert.equal(
      (await s.call(next, "credentials", { url: landing })).data.error,
      "CREDENTIAL_ORIGIN_MISMATCH",
    );
    assert.equal(
      (await s.call(next, "credentials", { url: accountInput.loginOrigins[0] })).data.account
        .password,
      accountInput.password,
    );
    await s.finish(next, null);
    await s.close(next);
    const clear = await s.request(`/api/user/accounts/${saved.data.accountId}/clear-state`, {
      expectedStateEpoch: 1,
    });
    assert.equal(clear.status, 200);
    assert.equal(
      s.sql.prepare("SELECT state_origins FROM accounts WHERE id=?").get(saved.data.accountId)!
        .state_origins,
      "[]",
    );
  });
}

test("空快照清除上一份有效状态，损坏时也不能重新登录旧会话", async (t) => {
  const s = await fixture(t),
    first = await s.upload(s.run);
  await s.finish(s.run, first.data.key);
  await s.close(s.run);
  const next = await s.next(),
    empty = await s.upload(
      next,
      { version: 1, cookies: [], origins: [{ origin: accountInput.origin, localStorage: [] }] },
      1,
    );
  assert.equal(empty.status, 200);
  await s.finish(next, empty.data.key);
  await s.close(next);
  assert.equal(s.account().state_object_key, empty.data.key);
  assert.equal(s.account().previous_state_object_key, null);
  s.objects.delete(empty.data.key);
  s.reads.length = 0;
  const third = await s.next(),
    access = await s.call(third, "browser-state");
  assert.equal(access.data.state, null);
  assert.equal(access.data.restoreFailed, true);
  assert.deepEqual(s.reads, [empty.data.key]);
});

test("退出后仅删除认证Cookie而保留其他状态，也禁止回退旧认证", async (t) => {
  const s = await fixture(t),
    first = await s.upload(s.run);
  await s.finish(s.run, first.data.key);
  await s.close(s.run);
  const next = await s.next(),
    afterLogout = state();
  afterLogout.cookies = afterLogout.cookies.filter((cookie) => cookie.name !== "session");
  const uploaded = await s.upload(next, afterLogout, 1);
  assert.equal(uploaded.status, 200);
  await s.finish(next, uploaded.data.key);
  await s.close(next);
  assert.equal(s.account().state_object_key, uploaded.data.key);
  assert.equal(s.account().previous_state_object_key, null);
  s.objects.delete(uploaded.data.key);
  s.reads.length = 0;
  const third = await s.next(),
    access = await s.call(third, "browser-state");
  assert.equal(access.data.state, null);
  assert.deepEqual(s.reads, [uploaded.data.key]);
});

test("过期、撤回、未知结果和候选基准过旧均不能发布新状态", async (t) => {
  const s = await fixture(t),
    first = await s.upload(s.run);
  await s.finish(s.run, first.data.key);
  await s.close(s.run);
  const next = await s.next(),
    stale = await s.upload(next, state("stale"), 0);
  await s.finish(next, stale.data.key);
  await s.close(next);
  assert.equal(s.account().state_object_key, first.data.key);
  assert.equal(s.account().state_revision, 1);
  const third = await s.next(),
    unknown = await s.upload(third, state("unknown"), 1);
  await s.finish(third, unknown.data.key, "unknown");
  await s.close(third);
  assert.equal(s.account().state_object_key, first.data.key);
  assert.ok(s.sql.prepare("SELECT * FROM account_locks WHERE run_id=?").get(third.id));
  s.sql
    .prepare("UPDATE runs SET status='failed',state_candidate_key=? WHERE id=?")
    .run(unknown.data.key, third.id);
  s.sql
    .prepare("UPDATE browser_state_candidates SET expires_at=? WHERE object_key=?")
    .run(dbTime("2000-01-01"), unknown.data.key);
  await publishBrowserState(s.env, third.id);
  assert.equal(s.account().state_revision, 1);
  s.sql
    .prepare("UPDATE browser_state_candidates SET expires_at=? WHERE object_key=?")
    .run(dbTime("2999-01-01"), unknown.data.key);
  s.sql.prepare("UPDATE runs SET context_withdrawn=1 WHERE id=?").run(third.id);
  await publishBrowserState(s.env, third.id);
  assert.equal(s.account().state_revision, 1);
});

test("其他账号的候选不能借当前run发布，晚确认仅把该run已完成快照归属新账号", async (t) => {
  const s = await fixture(t, false);
  const offered = await s.call(s.run, "account-card", {
    kind: "save",
    requestId: "late_save",
    ...accountInput,
    verified: true,
    observedOrigin: "https://login.example.com",
    evidence: "实际登录成功",
  });
  assert.equal(offered.status, 200);
  const uploaded = await s.upload(s.run);
  assert.equal(uploaded.status, 200);
  await s.finish(s.run, uploaded.data.key);
  await s.close(s.run);
  const saved = await s.request(
    `/api/user/account-cards/${offered.data.cardId}/confirm`,
    accountInput,
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.resumed, false);
  const account = s.sql
    .prepare("SELECT * FROM account_details WHERE id=?")
    .get(saved.data.accountId)!;
  assert.equal(account.state_object_key, uploaded.data.key);
  assert.notEqual(account.profile_id, s.run.profileId);
  // 即便设备猜到其他用户的账号ID，链接函数仍要求原用户一致。
  s.sql.prepare("INSERT INTO members(id) VALUES('state_other')").run();
  s.sql
    .prepare("UPDATE accounts SET user_id=? WHERE id=?")
    .run("state_other", saved.data.accountId);
  s.sql
    .prepare("UPDATE browser_state_candidates SET account_id=NULL,retired=0 WHERE object_key=?")
    .run(uploaded.data.key);
  await linkAccountSnapshot(s.env, {
    runId: s.run.id,
    accountId: saved.data.accountId,
    credentialVersion: 1,
    stateEpoch: 1,
  });
  assert.equal(
    s.sql
      .prepare("SELECT account_id FROM browser_state_candidates WHERE object_key=?")
      .get(uploaded.data.key)!.account_id,
    null,
  );
});

test("同步失败仅保存固定公开分类；成功、清除和凭据变更会清掉旧错误", async (t) => {
  const s = await fixture(t);
  const invalid = await s.call(s.run, "browser-state/sync-failed", {
    reason: "Cookie secret=DO_NOT_STORE_THIS",
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.error, "INVALID_INPUT");
  assert.equal(s.account().sync_error, null);
  assert.equal(
    (await s.call(s.run, "browser-state/sync-failed", { reason: "TOO_LARGE" })).status,
    200,
  );
  assert.equal(s.account().sync_error, "TOO_LARGE");
  const details = await s.request(`/api/user/accounts/${s.accountId}`);
  assert.equal(details.data.account.syncError, "TOO_LARGE");
  assert.ok(!JSON.stringify(s.account()).includes("DO_NOT_STORE_THIS"));
  assert.equal(
    (await s.request(`/api/user/accounts/${s.accountId}/clear-state`, { expectedStateEpoch: 1 }))
      .status,
    200,
  );
  assert.equal(s.account().sync_error, null);
  await s.call(s.run, "browser-state/sync-failed", { reason: "TOO_LARGE" });
  assert.equal(s.account().sync_error, null, "旧状态版本不能回写失败分类");
  await s.finish(s.run, null);
  await s.close(s.run);
  const next = await s.next();
  await s.call(next, "browser-state/sync-failed", { reason: "UNSUPPORTED_COOKIE" });
  assert.equal(s.account().sync_error, "UNSUPPORTED_COOKIE");
  const uploaded = await s.upload(next);
  assert.equal(uploaded.status, 200);
  await s.finish(next, uploaded.data.key);
  await s.close(next);
  assert.equal(s.account().sync_status, "synced");
  assert.equal(s.account().sync_error, null);
  const third = await s.next();
  await s.call(third, "browser-state/sync-failed");
  assert.equal(s.account().sync_error, "SYNC_FAILED");
  await s.request(
    `/api/user/accounts/${s.accountId}`,
    { expectedCredentialVersion: 1, password: "changed-secret" },
    "PATCH",
  );
  assert.equal(s.account().sync_error, null);
  await s.call(third, "browser-state/sync-failed", { reason: "TOO_LARGE" });
  assert.equal(s.account().sync_error, null, "旧凭据版本不能回写失败分类");
});

test("不可导出的opaque分区Cookie被拒绝，不降级成普通Cookie保存", async (t) => {
  const s = await fixture(t);
  const response = await s.call(s.run, "browser-state/upload", {
    baseRevision: 0,
    state: {
      version: 1,
      cookies: [
        {
          name: "opaque",
          value: "opaque-secret",
          domain: "login.example.com",
          path: "/",
          secure: true,
          partitionKeyOpaque: true,
        },
      ],
      origins: [],
    },
  });
  assert.equal(response.status, 400);
  assert.equal(response.data.error, "INVALID_INPUT");
  assert.equal(s.objects.size, 0);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM browser_state_candidates").get()!.n, 0);
  assert.equal(s.account().state_object_key, null);
});

test("发布暂时失败时关闭事实可重试，定时维护不能提前释放账号", async (t) => {
  const s = await fixture(t),
    uploaded = await s.upload(s.run);
  await s.finish(s.run, uploaded.data.key);
  let failed = false;
  const queries = new WeakMap<D1PreparedStatement, string>();
  s.env.DB = {
    prepare: (query: string) => {
      const statement = s.db.prepare(query);
      queries.set(statement, query);
      return statement;
    },
    batch: async (statements: D1PreparedStatement[]) => {
      if (
        !failed &&
        statements.some((item) =>
          queries.get(item)?.includes("UPDATE accounts SET previous_state_object_key="),
        )
      ) {
        failed = true;
        throw Error("Injected transport failure");
      }
      return s.db.batch(statements);
    },
  } as D1Database;
  assert.equal((await s.close(s.run)).status, 500);
  const cleanup = s.sql
    .prepare("SELECT cleanup_pending,cleanup_confirmed FROM runs WHERE id=?")
    .get(s.run.id)!;
  assert.equal(cleanup.cleanup_pending, 1);
  assert.equal(cleanup.cleanup_confirmed, 1);
  await tick(s.db);
  await enqueue(s.db, s.run.task, "after_failed_publish");
  const attempt = await s.request("/api/runner/claim", {
    requestId: "blocked_after_publish_failure",
    protocolVersion: PROTOCOL_VERSION,
  });
  assert.equal(attempt.data.run, null);
  assert.ok(s.sql.prepare("SELECT * FROM account_locks WHERE run_id=?").get(s.run.id));
  assert.equal((await s.close(s.run)).data.synced, true);
  assert.equal(s.account().state_object_key, uploaded.data.key);
  const next = await s.request("/api/runner/claim", {
    requestId: "after_publish_retry",
    protocolVersion: PROTOCOL_VERSION,
  });
  assert.ok(next.data.run);
  assert.equal(s.account().state_owner_run_id, next.data.run.id);
});

test("晚确认创建账号后新执行先领取，旧候选即使基准版本未变也不可迟到发布", async (t) => {
  const s = await fixture(t, false);
  const offered = await s.call(s.run, "account-card", {
    kind: "save",
    requestId: "late_claim_race",
    ...accountInput,
    verified: true,
    observedOrigin: "https://login.example.com",
    evidence: "实际登录成功",
  });
  const uploaded = await s.upload(s.run);
  await s.finish(s.run, uploaded.data.key);
  await s.close(s.run);
  let next: TaskRun | null = null,
    interleaved = false;
  const queries = new WeakMap<D1PreparedStatement, string>();
  s.env.DB = {
    prepare: (query: string) => {
      const statement = s.db.prepare(query);
      queries.set(statement, query);
      return statement;
    },
    batch: async (statements: D1PreparedStatement[]) => {
      const result = await s.db.batch(statements);
      if (
        !interleaved &&
        statements.some((item) =>
          queries.get(item)?.includes("UPDATE account_cards SET status='saved'"),
        )
      ) {
        interleaved = true;
        const accountId = s.sql
          .prepare("SELECT result_account_id FROM account_cards WHERE id=?")
          .get(offered.data.cardId)!.result_account_id as string;
        await enqueue(s.db, { ...s.run.task, accountId }, "new_owner_before_late_link");
        const claimed = await s.request("/api/runner/claim", {
          requestId: "new_owner_before_late_link",
          protocolVersion: PROTOCOL_VERSION,
        });
        next = claimed.data.run;
        assert.ok(next);
      }
      return result;
    },
  } as D1Database;
  const confirmed = await s.request(
    `/api/user/account-cards/${offered.data.cardId}/confirm`,
    accountInput,
  );
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  assert.ok(next);
  const account = () =>
    s.sql.prepare("SELECT * FROM account_details WHERE id=?").get(confirmed.data.accountId)!;
  assert.equal(account().state_revision, 0);
  assert.equal(account().state_object_key, null);
  assert.equal(account().state_owner_run_id, (next as TaskRun).id);
  await s.finish(next, null);
  await s.close(next);
  assert.equal(
    s.sql.prepare("SELECT * FROM account_locks WHERE account_key=?").get(confirmed.data.accountId),
    undefined,
  );
  await s.close(s.run);
  await linkAccountSnapshot(s.env, {
    runId: s.run.id,
    accountId: confirmed.data.accountId,
    credentialVersion: 1,
    stateEpoch: 1,
  });
  assert.equal(account().state_revision, 0);
  assert.equal(account().state_object_key, null, "新执行释放锁后旧发布权仍不能复活");
});
