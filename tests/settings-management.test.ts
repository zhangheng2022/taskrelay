/** 设置接口覆盖真实事务、归属、停用停止与偏好执行链路；不使用真实服务商。 */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { productionModelFixture } from "./production-model-fixture";
import { enqueue, tick } from "../apps/cloud/src/store";
import { task } from "./helpers";
import { accountManagement, modelManagement } from "../apps/cloud/src/resource-management";
import { preferences, capturePreferences, readPreferences } from "../apps/cloud/src/ai/preferences";
import { D1MemoryStore } from "../apps/cloud/src/ai/memory";
import { drainHistoryCleanups } from "../apps/cloud/src/history-cleanup";
import type { AppEnv, Variables } from "../apps/cloud/src/env";
import { readFileSync, readdirSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { applicationDb } from "../apps/cloud/src/database";
import { insertTask } from "./helpers";
import { createAccount } from "../apps/cloud/src/accounts";

for (const kind of ["accounts", "models"] as const) {
  test(`${kind} 停用原子失败排队与执行，保留未知操作锁；恢复不重试且冲突不再停止`, async (t) => {
    const s = await productionModelFixture(t);
    if (kind === "models")
      s.sql
        .prepare(
          "UPDATE model_profile_versions SET capabilities=json_set(capabilities,'$.questionAnswered',json('true')) WHERE id='model_test'",
        )
        .run();
    await enqueue(s.db, task(), "queued_before_disable");
    s.sql.prepare("UPDATE runs SET write_pending=1,may_have_written=1 WHERE id=?").run(s.run.id);
    const id = kind === "accounts" ? "account_test" : "model_test";
    const path = `/api/${kind === "accounts" ? "user" : "admin"}/${kind}/${id}`;
    const version = s.sql.prepare(`SELECT management_version v FROM ${kind} WHERE id=?`).get(id)!.v;
    assert.equal(
      (await s.request(path + "/state", { enabled: false, expectedVersion: version }, "PUT"))
        .status,
      200,
    );
    assert.deepEqual(
      s.sql
        .prepare("SELECT DISTINCT status,cancel_requested FROM runs")
        .all()
        .map((r) => ({ ...r })),
      [{ status: "failed", cancel_requested: 1 }],
    );
    assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM run_results").get()!.n, 2);
    await tick(s.db);
    assert.equal(
      s.sql.prepare("SELECT COUNT(*) n FROM account_locks WHERE run_id=?").get(s.run.id)!.n,
      1,
    );
    if (kind === "accounts") {
      assert.equal(
        (await s.request(path, { expectedVersion: Number(version) + 1 }, "DELETE")).data.error,
        "RESOURCE_IN_USE",
      );
    }
    await assert.rejects(
      enqueue(s.db, task(), "disabled_new"),
      kind === "accounts" ? /ACCOUNT_DISABLED/ : /MODEL_DISABLED/,
    );
    assert.equal(
      (
        await s.request(
          path + "/state",
          { enabled: true, expectedVersion: Number(version) + 1 },
          "PUT",
        )
      ).status,
      200,
    );
    assert.equal(
      (await s.request(path + "/state", { enabled: false, expectedVersion: version }, "PUT"))
        .status,
      409,
    );
    assert.equal(s.sql.prepare(`SELECT enabled FROM ${kind} WHERE id=?`).get(id)!.enabled, 1);
    assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM runs WHERE status='queued'").get()!.n, 0);
  });
}

test("账号编辑管理版本防覆盖；空账号可删除，其他用户不可修改", async (t) => {
  const s = await productionModelFixture(t);
  const created = await s.request("/api/user/accounts", {
    name: "空账号",
    origin: "https://example.com",
    username: "user",
    password: "password",
  });
  const id = created.data.id;
  const edit = { name: "新名称", expectedCredentialVersion: 1, expectedManagementVersion: 1 };
  assert.equal((await s.request(`/api/user/accounts/${id}`, edit, "PATCH")).status, 200);
  assert.equal(
    (await s.request(`/api/user/accounts/${id}`, { ...edit, name: "旧表单" }, "PATCH")).data.error,
    "ACCOUNT_VERSION_CONFLICT",
  );
  const other = new Hono<{ Bindings: AppEnv; Variables: Variables }>();
  other.use("*", async (c, next) => {
    c.set("userId", "other");
    await next();
  });
  other.route("/accounts", accountManagement);
  assert.equal(
    (
      await other.request(
        `/accounts/${id}/state`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false, expectedVersion: 2 }),
        },
        s.env,
      )
    ).status,
    409,
  );
  assert.equal(
    (await s.request(`/api/user/accounts/${id}`, { expectedVersion: 2 }, "DELETE")).status,
    200,
  );
  assert.equal(s.sql.prepare("SELECT id FROM accounts WHERE id=?").get(id), undefined);
});

test("模型配置编辑 CAS 保留固定版本，并拒绝过期表单", async (t) => {
  const s = await productionModelFixture(t);
  const version = s.sql
    .prepare("SELECT management_version v FROM models WHERE id='model_test'")
    .get()!.v;
  const input = {
    name: "新版",
    connectionId: "conn_test",
    model: "test",
    protocol: "responses",
    contextTokens: 16000,
    outputTokens: 4096,
    inputPrice: null,
    outputPrice: null,
    expectedVersion: version,
  };
  const saved = await s.request("/api/admin/models/model_test", input, "PUT");
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.version, 3);
  assert.equal(
    (await s.request("/api/admin/models/model_test", input, "PUT")).data.error,
    "RESOURCE_VERSION_CONFLICT",
  );
  assert.equal(
    s.sql.prepare("SELECT task_snapshot FROM run_snapshots WHERE run_id=?").get(s.run.id)!
      .task_snapshot as string,
    JSON.stringify(s.run.task),
  );
});

test("记忆完整分页、旧条目默认停用、版本冲突与跨用户隔离", async (t) => {
  const s = await productionModelFixture(t);
  const store = new D1MemoryStore(s.db, "fixture_owner", s.env.MASTER_KEY);
  for (let i = 0; i < 105; i++)
    await store.put(["preferences"], `memory_${i}`, { text: `偏好 ${i}` });
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await s.request(
      "/api/user/memory-page" + (cursor ? "?before=" + encodeURIComponent(cursor) : ""),
      undefined,
      "GET",
    );
    for (const m of page.data.items) {
      ids.add(m.id);
      assert.equal(m.enabled, false);
    }
    cursor = page.data.nextCursor;
  } while (cursor);
  assert.equal(ids.size, 105);
  const path = "/api/user/memories/memory_0",
    input = { text: "用于后续任务", confirmed: true, enabled: true, expectedVersion: 1 };
  assert.equal((await s.request(path, input, "PUT")).status, 200);
  assert.equal((await s.request(path, input, "PUT")).status, 409);
  const enabled = await s.request("/api/user/memory-page?state=enabled", undefined, "GET");
  assert.deepEqual(
    enabled.data.items.map((m: { id: string }) => m.id),
    ["memory_0"],
  );
  assert.equal(enabled.data.nextCursor, null);
  const searched = await s.request(
    "/api/user/memory-page?q=" + encodeURIComponent("偏好 104"),
    undefined,
    "GET",
  );
  assert.deepEqual(
    searched.data.items.map((m: { id: string }) => m.id),
    ["memory_104"],
  );
  const other = new Hono<{ Bindings: AppEnv; Variables: Variables }>();
  other.use("*", async (c, next) => {
    c.set("userId", "other");
    await next();
  });
  other.route("/", preferences);
  assert.deepEqual(
    ((await (await other.request("/memory-page", {}, s.env)).json()) as { items: unknown[] }).items,
    [],
  );
  assert.equal(
    (
      await other.request(
        "/memories/memory_0",
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedVersion: 2 }),
        },
        s.env,
      )
    ).status,
    409,
  );
});

test("启用偏好进入规划、实际运行上下文与协助，同一交办快照稳定且清理密文", async (t) => {
  const s = await productionModelFixture(t);
  const text = "偏好：请使用简洁中文，但以本次要求为准";
  await s.request("/api/user/memories/style", { text, confirmed: true, enabled: true }, "PUT");
  s.replies(
    JSON.stringify({
      reply: "开始",
      start: true,
      title: "查公告",
      goal: "查询公告",
      entryUrl: "https://example.com",
      accountId: null,
      accountIds: [],
      executionOutline: ["读取公告"],
    }),
  );
  const th = (await s.request("/api/user/threads", { modelId: "model_test" })).data;
  const result = await s.request(`/api/user/threads/${th.id}/messages`, {
    requestId: "memory_turn",
    content: "本次请用英文，查询公告",
  });
  assert.equal(result.data.status, "done", JSON.stringify(result.data));
  assert.match(JSON.stringify(s.requests[0].body), /本次请用英文/);
  assert.match(JSON.stringify(s.requests[0].body), /taskPreferences/);
  assert.match(JSON.stringify(s.requests[0].body), /偏好：请使用简洁中文/);
  const snapshot = s.sql
    .prepare("SELECT id,value FROM preference_snapshots WHERE thread_id=?")
    .get(th.id)!;
  assert.ok(!(snapshot.value as string).includes(text));
  const saved = await readPreferences(s.env, "fixture_owner", snapshot.id as string);
  await s.request(
    "/api/user/memories/style",
    { text: "已经改为别的偏好", confirmed: true, enabled: false, expectedVersion: 1 },
    "PUT",
  );
  assert.deepEqual(
    await capturePreferences(s.env, "fixture_owner", th.id, snapshot.id as string),
    saved,
  );
  await assert.rejects(readPreferences(s.env, "other", snapshot.id as string), /UNAVAILABLE/);
  // 将该快照接入已领取的生产执行入口，沿用同一设备租约。
  s.sql.prepare("UPDATE runs SET thread_id=? WHERE id=?").run(th.id, s.run.id);
  s.sql
    .prepare(
      "UPDATE run_snapshots SET task_snapshot=json_set(task_snapshot,'$.preferenceSnapshotId',?) WHERE run_id=?",
    )
    .run(snapshot.id, s.run.id);
  const context = await s.request(`/api/runner/runs/${s.run.id}/context`, {
    epoch: s.run.leaseEpoch,
    after: 0,
  });
  assert.deepEqual(context.data.preferenceSnapshot, saved);
  assert.ok(!JSON.stringify(context.data.messages).includes(text));
  s.replies(JSON.stringify({ message: "继续读取", askUser: false, accountId: null }));
  assert.equal(
    (
      await s.request(`/api/runner/runs/${s.run.id}/help`, {
        epoch: s.run.leaseEpoch,
        id: "help_memory",
        origin: "https://example.com",
        message: "如何继续",
      })
    ).status,
    200,
  );
  assert.ok(JSON.stringify(s.requests.at(-1)!.body).includes(text));
  assert.ok(
    !JSON.stringify(s.sql.prepare("SELECT definition FROM task_versions").all()).includes(text),
  );
  await s.request(`/api/user/threads/${th.id}`, undefined, "DELETE");
  await drainHistoryCleanups(s.env);
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM preference_snapshots WHERE thread_id=?").get(th.id)!.n,
    0,
  );
});

test("真实 D1 删除与任务版本提交竞争不留下 JSON 悬空账号", { timeout: 60000 }, async (t) => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
      workers: [
        {
          name: "settings-race",
          modules: true,
          script: "export default {fetch(){return new Response('fixture')}}",
          compatibilityDate: "2026-11-03",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
        },
      ],
    }),
  );
  t.after(() => mf.dispose());
  const raw = await mf.getD1Database("DB"),
    dir = new URL("../apps/cloud/migrations/", import.meta.url);
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await raw.exec(
      readFileSync(new URL(name, dir), "utf8")
        .replace(/--[^\n]*/g, "")
        .replace(/\r?\n/g, " "),
    );
  await raw.prepare("INSERT INTO members(id,role) VALUES('fixture_owner','admin')").run();
  const db = applicationDb(raw),
    env = { DB: db, MASTER_KEY: Buffer.alloc(32, 9).toString("base64") } as AppEnv;
  await insertTask(db, task({ accountId: null }));
  const routes = new Hono<{ Bindings: AppEnv; Variables: Variables }>();
  routes.use("*", async (c, next) => {
    c.set("userId", "fixture_owner");
    await next();
  });
  routes.route("/accounts", accountManagement);
  routes.route("/models", modelManagement);
  for (let i = 0; i < 3; i++) {
    const { id } = await createAccount(env, "fixture_owner", {
      name: "race",
      origin: "https://example.com",
      username: "",
      password: "",
    });
    const definition = task({ id: "race_" + i, accountId: id });
    const submit = () =>
      db.batch([
        db
          .prepare(
            "INSERT INTO tasks(id,version,title,schedule_kind,status,created_at,updated_at,user_id) VALUES(?,1,'race','manual','active',1,1,'fixture_owner')",
          )
          .bind(definition.id),
        db
          .prepare(
            "INSERT INTO task_versions(task_id,version,definition,user_id,model_id,model_version) VALUES(?,1,?,'fixture_owner','model_test',1)",
          )
          .bind(definition.id, JSON.stringify(definition)),
      ]);
    const remove = async () =>
      routes.request(
        `/accounts/${id}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedVersion: 1 }),
        },
        env,
      );
    const results = await Promise.allSettled(i % 2 ? [submit(), remove()] : [remove(), submit()]);
    const deletion = results[i % 2 ? 1 : 0],
      submission = results[i % 2 ? 0 : 1];
    assert.equal(deletion.status, "fulfilled");
    const account = await db.prepare("SELECT id FROM accounts WHERE id=?").bind(id).first();
    const saved = await db.prepare("SELECT id FROM tasks WHERE id=?").bind(definition.id).first();
    if (deletion.status === "fulfilled" && (deletion.value as Response).status === 200) {
      assert.equal(account, null);
      assert.equal(saved, null);
      assert.equal(submission.status, "rejected");
    } else {
      assert.ok(account);
      assert.ok(saved);
      assert.equal(submission.status, "fulfilled");
    }
  }
  // 在实际 D1 上确认触发器错误映射、RETURNING 和外键在管理删除事务中一致。
  const deleteModel = (expectedVersion: number) =>
    routes.request(
      "/models/model_test",
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion }),
      },
      env,
    );
  const version = await raw
    .prepare("SELECT management_version FROM models WHERE id='model_test'")
    .first<number>("management_version");
  assert.ok(version);
  const active = await deleteModel(version);
  assert.deepEqual(await active.json(), { error: "MODEL_DISABLE_BEFORE_DELETE" });
  await raw.prepare("UPDATE models SET enabled=0 WHERE id='model_test'").run();
  assert.equal((await deleteModel(version)).status, 200);
  assert.equal(
    await raw
      .prepare("SELECT config FROM model_profile_versions WHERE id='model_test' AND version=1")
      .first("config"),
    "{}",
  );
  assert.deepEqual((await raw.prepare("PRAGMA foreign_key_check").all()).results, []);
});

test("停用命中执行中通过账号卡绑定的账号，不依赖旧任务快照", async (t) => {
  const s = await productionModelFixture(t);
  s.sql
    .prepare(
      "UPDATE run_snapshots SET task_snapshot=json_set(task_snapshot,'$.accountId',null,'$.accountIds',json('[]')) WHERE run_id=?",
    )
    .run(s.run.id);
  assert.equal(
    (
      await s.request(
        "/api/user/accounts/account_test/state",
        { enabled: false, expectedVersion: 1 },
        "PUT",
      )
    ).status,
    200,
  );
  assert.equal(s.sql.prepare("SELECT status FROM runs WHERE id=?").get(s.run.id)!.status, "failed");
});

test("过量记忆在首次模型请求前失败，保留用户原文与完整快照", async (t) => {
  const s = await productionModelFixture(t),
    store = new D1MemoryStore(s.db, "fixture_owner", s.env.MASTER_KEY);
  for (let i = 0; i < 30; i++)
    await store.put(["preferences"], "long_" + i, { text: "中文偏好".repeat(250) });
  s.sql.exec("UPDATE ai_memories SET enabled=1");
  const th = (await s.request("/api/user/threads", { modelId: "model_test" })).data;
  const result = await s.request(`/api/user/threads/${th.id}/messages`, {
    requestId: "too_large",
    content: "我的原话不能被覆盖",
  });
  assert.equal(result.data.error, "PREFERENCES_TOO_LARGE");
  assert.equal(s.jobs(), 0);
  const row = s.sql.prepare("SELECT id FROM preference_snapshots WHERE thread_id=?").get(th.id)!;
  assert.equal((await readPreferences(s.env, "fixture_owner", row.id as string)).length, 30);
  assert.ok(JSON.stringify(result.data.messages).includes("我的原话不能被覆盖"));
});

test("停用后删除曾使用的模型，保留账目、历史聊天和共用连接", async (t) => {
  const s = await productionModelFixture(t);
  const path = "/api/admin/models/model_test";
  const version = Number(
    s.sql.prepare("SELECT management_version AS v FROM models WHERE id='model_test'").get()!.v,
  );
  const thread = (await s.request("/api/user/threads", { modelId: "model_test" })).data;
  s.sql
    .prepare(
      "UPDATE model_profile_versions SET config=json_set(config,'$.inputPrice',2,'$.outputPrice',3) WHERE id='model_test' AND version=1",
    )
    .run();
  const env = { ...s.env, requestUserId: "fixture_owner" };
  const { getModelProfile, recordUsage } = await import("../apps/cloud/src/models");
  const { profile } = await getModelProfile(env, "model_test", 1);
  const record = (callId: string) =>
    recordUsage(
      env,
      profile,
      { text: "ok", calls: [], usage: { input: 10, output: 5 } },
      s.run.id,
      "fixture_owner",
      {
        callId,
        inferenceStartedAt: new Date().toISOString(),
        providerStartedAt: new Date().toISOString(),
      },
    );
  await record("before_delete");
  assert.equal(
    (await s.request(path, { expectedVersion: version }, "DELETE")).data.error,
    "MODEL_DISABLE_BEFORE_DELETE",
  );
  assert.equal(
    (await s.request(path + "/state", { expectedVersion: version, enabled: false }, "PUT")).status,
    200,
  );
  assert.equal((await s.request(path, { expectedVersion: version }, "DELETE")).status, 409);
  assert.equal((await s.request(path, { expectedVersion: version + 1 }, "DELETE")).status, 200);
  assert.equal((await s.request(path, { expectedVersion: version + 1 }, "DELETE")).status, 409);
  await record("inflight_receipt");
  assert.deepEqual(
    s.sql
      .prepare("SELECT retired_cost FROM model_usage WHERE model_id='model_test' ORDER BY id")
      .all()
      .map((r) => r.retired_cost),
    [0.000035, 0.000035],
  );
  assert.equal(
    s.sql
      .prepare(
        "SELECT count(*) n FROM model_profile_versions WHERE id='model_test' AND (config<>'{}' OR capabilities<>'{}' OR connection_id IS NOT NULL OR effective_region IS NOT NULL)",
      )
      .get()!.n,
    0,
  );
  assert.ok(s.sql.prepare("SELECT id FROM model_connections WHERE id='conn_test'").get());
  assert.strictEqual(
    (await s.request("/api/user/threads/" + thread.id, undefined, "GET")).status,
    200,
  );
  assert.ok(
    !(await s.request("/api/user/snapshot", undefined, "GET")).data.models.some(
      (m: { id: string }) => m.id === "model_test",
    ),
  );
  await assert.rejects(getModelProfile(env, "model_test", 1), /MODEL_PROTOCOL_RETIRED/);
  assert.deepEqual(s.sql.prepare("PRAGMA foreign_key_check").all(), []);
});
test("管理员可删除未使用的平台网关模型及版本", async (t) => {
  const s = await productionModelFixture(t);
  const model = await s.request("/api/admin/models", {
    name: "unused",
    model: "unused",
    protocol: "responses",
    connectionId: "conn_test",
  });
  assert.equal(model.status, 201);
  assert.equal(
    (await s.request(`/api/admin/models/${model.data.id}`, { expectedVersion: 1 }, "DELETE"))
      .status,
    200,
  );
  assert.equal(
    s.sql.prepare("SELECT id FROM model_profile_versions WHERE id=?").get(model.data.id),
    undefined,
  );
});
