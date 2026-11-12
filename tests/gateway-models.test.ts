import { readFileSync } from "node:fs";
import { enqueue } from "../apps/cloud/src/store";
import test from "node:test";
import assert from "node:assert/strict";
import { testDb, insertTask, task } from "./helpers";
import { attachTestEgress } from "./egress-helpers";
import { invoke, storeModel, probe } from "../apps/cloud/src/models";
import { createConnection, gatewayTransport } from "../apps/cloud/src/model-gateway";
import type { AppEnv } from "../apps/cloud/src/env";
import { app } from "../apps/cloud/src/index";

test("移除 Chat 协议只退休固定到旧版本的运行，保留历史和同模型新版本", async (t) => {
  const migration = "0008_responses_only.sql";
  const { db, sql } = testDb(migration);
  t.after(() => sql.close());
  const env = {
    DB: db,
    DEV_MODE: "1",
    requestUserId: "fixture_owner",
    MASTER_KEY: Buffer.alloc(32, 4).toString("base64"),
  } as AppEnv;
  attachTestEgress(env);
  const input = { name: "fixture", connectionId: "conn_test", model: "same" };
  await assert.rejects(storeModel(env, { ...input, protocol: "chat" }));
  const old = await storeModel(env, input);
  const mixed = await storeModel(env, input);
  const current = await storeModel(env, input, mixed.id, 1);
  assert.equal(current.protocol, "responses");
  const retired = task({ id: "old_task", modelId: mixed.id, accountId: null });
  const kept = task({ id: "new_task", modelId: mixed.id, modelVersion: 2, accountId: null });
  for (const snapshot of [retired, kept]) {
    await insertTask(db, snapshot);
    await enqueue(db, snapshot, snapshot.id);
    sql
      .prepare(
        "INSERT INTO task_schedules(task_id,task_version,state,ready) VALUES(?,1,'enabled',1)",
      )
      .run(snapshot.id);
  }
  sql
    .prepare(
      "INSERT INTO ai_threads(id,user_id,kind,model_id,model_version,created_at,updated_at) VALUES('historic','fixture_owner','chat',?,1,1,1)",
    )
    .run(mixed.id);
  sql
    .prepare(
      "UPDATE model_profile_versions SET config=json_set(config,'$.protocol','chat') WHERE id IN (?,?) AND version=1",
    )
    .run(old.id, mixed.id);
  sql.exec(readFileSync(new URL("../apps/cloud/migrations/" + migration, import.meta.url), "utf8"));
  assert.equal(sql.prepare("SELECT enabled FROM models WHERE id=?").get(old.id)!.enabled, 0);
  assert.equal(sql.prepare("SELECT enabled FROM models WHERE id=?").get(mixed.id)!.enabled, 1);
  assert.equal(
    sql.prepare("SELECT status FROM runs WHERE task_id=?").get(retired.id)!.status,
    "failed",
  );
  assert.equal(
    sql.prepare("SELECT state FROM task_schedules WHERE task_id=?").get(retired.id)!.state,
    "paused",
  );
  assert.equal(
    sql.prepare("SELECT status FROM runs WHERE task_id=?").get(kept.id)!.status,
    "queued",
  );
  assert.equal(
    sql.prepare("SELECT state FROM task_schedules WHERE task_id=?").get(kept.id)!.state,
    "enabled",
  );
  assert.match(
    String(sql.prepare("SELECT result FROM run_results").get()!.result),
    /MODEL_PROTOCOL_RETIRED/,
  );
  await assert.rejects(enqueue(db, retired, "again"), /MODEL_PROTOCOL_RETIRED/);
  await assert.rejects(invoke(env, mixed.id, 1, { messages: [] }), /MODEL_PROTOCOL_RETIRED/);
  assert.equal(sql.prepare("SELECT count(*) n FROM ai_calls").get()!.n, 0);
  const runId = String(sql.prepare("SELECT id FROM runs WHERE task_id=?").get(retired.id)!.id);
  sql
    .prepare(
      "UPDATE model_profile_versions SET config=json_set(config,'$.inputPrice',2,'$.outputPrice',3) WHERE version=1 AND id IN (?,?)",
    )
    .run(old.id, mixed.id);
  const usage = sql.prepare(
    "INSERT INTO model_usage(id,run_id,model_id,model_version,user_id,input_tokens,output_tokens,at) VALUES(?,?,?,1,'fixture_owner',10,5,1)",
  );
  usage.run("usage_only", null, old.id);
  usage.run("historical_charge", runId, mixed.id);
  sql.exec("BEGIN");
  sql.exec(
    readFileSync(
      new URL("../apps/cloud/migrations/0009_remove_retired_models.sql", import.meta.url),
      "utf8",
    ),
  );
  sql.exec("COMMIT");
  assert.equal(sql.prepare("SELECT id FROM models WHERE id=?").get(old.id), undefined);
  assert.equal(
    sql.prepare("SELECT * FROM model_profile_versions WHERE id=?").get(old.id),
    undefined,
  );
  const reference = sql
    .prepare(
      "SELECT config,capabilities,connection_id,effective_region FROM model_profile_versions WHERE id=? AND version=1",
    )
    .get(mixed.id)!;
  assert.deepEqual(
    { ...reference },
    { config: "{}", capabilities: "{}", connection_id: null, effective_region: null },
  );
  assert.equal(
    sql.prepare("SELECT retired_cost FROM model_usage WHERE id='usage_only'").get()!.retired_cost,
    0.000035,
  );
  assert.deepEqual(sql.prepare("PRAGMA foreign_key_check").all(), []);
  await assert.rejects(invoke(env, mixed.id, 1, { messages: [] }), /MODEL_PROTOCOL_RETIRED/);
  assert.equal((await storeModel(env, input, mixed.id, 2)).version, 3);
  const runPage = await app.request("http://localhost/api/user/runs/" + runId, {}, env);
  assert.equal(runPage.status, 200);
  assert.equal(((await runPage.json()) as { usage: { cost: number }[] }).usage[0]?.cost, 0.000035);
  const page = await app.request("http://localhost/api/user/threads/historic", {}, env);
  assert.equal(page.status, 200);
  assert.equal(((await page.json()) as { id: string }).id, "historic");
});
test("发布模型固定连接和有效区域，原生网关、托管密钥、Workers AI 请求边界", async (t) => {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  const env = {
    DB: db,
    MASTER_KEY: Buffer.alloc(32, 4).toString("base64"),
    requestUserId: "fixture_owner",
    DEV_MODE: "1",
  } as AppEnv;
  attachTestEgress(env);
  const regions: string[] = [];
  const byRegion = env.MODEL_EGRESS.jurisdiction.bind(env.MODEL_EGRESS);
  t.mock.method(env.MODEL_EGRESS, "jurisdiction", (region: "us" | "eu") => {
    regions.push(region);
    return byRegion(region);
  });
  const sent: { url: string; headers: Headers }[] = [];
  let reply = () =>
    Response.json({
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 2, output_tokens: 1 },
    });
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    if (String(input).startsWith("https://cloudflare-dns.com/"))
      return Response.json({ Status: 0, Answer: [{ type: 1, data: "8.8.8.8" }] });
    sent.push({ url: String(input), headers: new Headers(init?.headers) });
    assert.equal(init?.redirect, "manual");
    return reply();
  });
  const messages = { messages: [{ role: "user" as const, content: "hello" }], stream: false };
  const config = {
    name: "test",
    connectionId: "conn_test",
    model: "my-model",
    protocol: "responses",
  };
  const v1 = await storeModel(env, config);
  sql.prepare("UPDATE model_connections SET default_region='eu' WHERE id='conn_test'").run();
  const v2 = await storeModel(env, config, v1.id, 1);
  const v3 = await storeModel(env, { ...config, region: "auto" }, v1.id, 2);
  assert.deepEqual(
    [v1.effectiveRegion, v2.effectiveRegion, v3.effectiveRegion],
    ["us", "eu", "auto"],
  );
  for (const v of [v1, v2, v3]) await invoke(env, v.id, v.version, messages);
  assert.deepEqual(regions, ["us", "eu"]);
  assert.equal(sent.length, 3);
  for (const { url, headers } of sent) {
    assert.equal(
      url,
      "https://gateway.ai.cloudflare.com/v1/" + "f".repeat(32) + "/fixture/openai/responses",
    );
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("cf-aig-byok-alias"), "fixture-key");
    assert.equal(headers.get("cf-aig-authorization"), "Bearer fixture");
    assert.equal(headers.get("cf-aig-collect-log-payload"), "false");
    assert.equal(headers.get("cf-aig-max-attempts"), "1");
    assert.equal(headers.get("cf-aig-skip-cache"), "true");
  }
  const custom = await createConnection(env, {
    kind: "custom",
    name: "custom",
    defaultRegion: "auto",
    upstream: "https://public.example/api/v3/",
  });
  const cv = await storeModel(env, { ...config, connectionId: custom.id, protocol: "responses" });
  await assert.rejects(invoke(env, cv.id, 1, messages), /MODEL_GATEWAY_BINDING_REQUIRED/);
  assert.equal(sent.length, 3);
  sql.prepare("UPDATE model_connections SET binding_verified=1 WHERE id=?").run(custom.id);
  reply = () => Response.json({ output: [] });
  await invoke(env, cv.id, 1, messages);
  assert.ok(sent.at(-1)!.url.endsWith("/" + custom.gatewayProvider + "/api/v3/responses"));
  assert.equal(sent.at(-1)!.headers.get("cf-aig-byok-alias"), custom.keyAlias);
  assert.throws(
    () =>
      sql
        .prepare("UPDATE model_connections SET upstream='https://other.example' WHERE id=?")
        .run(custom.id),
    /IMMUTABLE/,
  );
  const w = await createConnection(env, { kind: "workers-ai", name: "WA", defaultRegion: "auto" });
  const transport = gatewayTransport(env, w, "@cf/vendor/example");
  assert.throws(
    () => transport.fetch(transport.baseUrl + "/chat/completions"),
    /MODEL_GATEWAY_ROUTE_INVALID/,
  );
  const model = await storeModel(env, {
    ...config,
    connectionId: w.id,
    model: "@cf/vendor/example",
    protocol: "responses",
  });
  await invoke(env, model.id, 1, messages);
  assert.equal(
    sent.at(-1)!.url,
    "https://api.cloudflare.com/client/v4/accounts/" + "f".repeat(32) + "/ai/v1/responses",
  );
  assert.equal(sent.at(-1)!.headers.get("cf-aig-gateway-id"), "fixture");
  assert.equal(sent.at(-1)!.headers.get("authorization"), "Bearer workers-fixture");
  assert.equal(sent.at(-1)!.headers.get("cf-aig-byok-alias"), null);
  reply = () =>
    Response.json({ errors: [{ code: 3036, message: "secret upstream body" }] }, { status: 429 });
  const count = sent.length;
  await assert.rejects(invoke(env, model.id, 1, messages), { message: "WORKERS_AI_FREE_LIMIT" });
  assert.equal(sent.length, count + 1);
  delete env.WORKERS_AI_TOKEN;
  await assert.rejects(invoke(env, model.id, 1, messages), {
    message: "MODEL_GATEWAY_NOT_CONFIGURED",
  });
  assert.equal(sent.length, count + 1);
});

test("个人模型按可信用户隔离，探测、选模、任务与最终调用各自检查归属", async (t) => {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  const env = {
    DB: db,
    DEV_MODE: "1",
    MASTER_KEY: Buffer.alloc(32, 6).toString("base64"),
  } as AppEnv;
  attachTestEgress(env);
  for (const owner of ["fixture_owner", "bob"]) {
    if (owner === "bob") sql.prepare("INSERT INTO members(id) VALUES(?)").run(owner);
    sql
      .prepare(
        "INSERT INTO model_connections(id,name,owner_user_id,kind,provider,key_alias,default_region,binding_verified) VALUES(?,?,?,'provider','openai',?,'us',1)",
      )
      .run("c_" + owner, owner, owner, "alias_" + owner);
    sql.exec("BEGIN");
    sql
      .prepare("INSERT INTO models(id,current_version,created_at,owner_user_id) VALUES(?,1,1,?)")
      .run("m_" + owner, owner);
    sql
      .prepare(
        "INSERT INTO model_profile_versions(id,version,created_at,config,capabilities,connection_id,effective_region) VALUES(?,1,1,?,?,?,'us')",
      )
      .run(
        "m_" + owner,
        JSON.stringify({ name: owner, protocol: "responses", model: "same" }),
        JSON.stringify({ connection: true, tools: true, structured: "schema" }),
        "c_" + owner,
      );
    sql.exec("COMMIT");
  }
  const aliases: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    aliases.push(new Headers(init?.headers).get("cf-aig-byok-alias")!);
    return Response.json({
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    });
  });
  const msg = { messages: [{ role: "user" as const, content: "ok" }], stream: false };
  for (const owner of ["fixture_owner", "bob"]) {
    const scoped = { ...env, requestUserId: owner };
    await invoke(scoped, "m_" + owner, 1, msg);
    const other = "m_" + (owner === "bob" ? "fixture_owner" : "bob");
    await assert.rejects(invoke(scoped, other, 1, msg), /MODEL_NOT_FOUND/);
    await assert.rejects(probe(scoped, other, 1), /MODEL_NOT_FOUND/);
  }
  assert.deepEqual(aliases, ["alias_fixture_owner", "alias_bob"]);
  const usage = sql
    .prepare("SELECT user_id,model_id FROM model_usage ORDER BY user_id")
    .all()
    .map((row) => [row.user_id, row.model_id]);
  assert.deepEqual(usage, [
    ["bob", "m_bob"],
    ["fixture_owner", "m_fixture_owner"],
  ]);
  const snapshot = await app.request("http://localhost/api/user/snapshot", {}, env);
  const data = (await snapshot.json()) as { models: { id: string }[] };
  assert.deepEqual(
    data.models.map((m) => m.id),
    ["m_fixture_owner"],
  );
  await assert.rejects(
    insertTask(db, task({ id: "denied", modelId: "m_bob", accountId: null })),
    /MODEL_NOT_FOUND/,
  );
  const rejected = await app.request(
    "http://localhost/api/user/threads",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ modelId: "m_bob" }),
    },
    env,
  );
  assert.equal(rejected.status, 404);
  const probeDenied = await app.request(
    "http://localhost/api/admin/models/m_bob/test",
    { method: "POST", headers: { Origin: "http://localhost" } },
    env,
  );
  assert.equal(probeDenied.status, 404);
  assert.deepEqual(aliases, ["alias_fixture_owner", "alias_bob"]);
  assert.throws(
    () =>
      sql
        .prepare(
          "INSERT INTO model_profile_versions(id,version,created_at,config,capabilities,connection_id,effective_region) VALUES('m_bob',2,1,'{}','{}','conn_test','us')",
        )
        .run(),
    /MODEL_CONNECTION_NOT_FOUND/,
  );
});

test("配置服务逐项比对自定义目的地、网关、供应商和托管密钥", async () => {
  const { verifyConnectionBinding, checkGateway } = await import(
    new URL("../scripts/prepare-model-gateway.mjs", import.meta.url).href
  );
  const row = {
    kind: "custom",
    provider: "custom-fixture",
    key_alias: "alias",
    upstream: "https://example.com/v1",
  };
  const provider = { slug: "fixture", enable: true, base_url: "https://example.com" };
  const key = {
    provider_slug: row.provider,
    alias: "alias",
    gateway_id: "taskrelay",
    secret_id: "fixture",
  };
  const api = async (path: string) => (path.includes("custom-providers") ? [provider] : [key]);
  await verifyConnectionBinding(row, api);
  key.alias = "other";
  await assert.rejects(verifyConnectionBinding(row, api), /KEY_BINDING_MISSING/);
  provider.base_url = "https://example.org";
  await assert.rejects(verifyConnectionBinding(row, api), /UPSTREAM_MISMATCH/);
  const gw = {
    id: "taskrelay",
    authentication: true,
    byok_only: true,
    cache_ttl: 0,
    retry_max_attempts: 1,
    workers_ai_billing_mode: "postpaid",
    collect_logs: true,
  };
  await checkGateway(false, async () => gw);
  await assert.rejects(
    checkGateway(false, async () => ({ ...gw, byok_only: false })),
    /SETTINGS_REQUIRED/,
  );
});
