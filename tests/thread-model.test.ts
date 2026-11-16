/** 会话切换通过真实路由验证归属、空闲条件与固定历史快照。 */
import test from "node:test";
import assert from "node:assert/strict";
import { productionModelFixture } from "./production-model-fixture";
import { appendMessage } from "../apps/cloud/src/chat-messages";
import { app } from "../apps/cloud/src/index";

test("聊天只接受原模型版本已验证的档位，重绑模型时恢复默认", async (t) => {
  const s = await productionModelFixture(t);
  s.sql.exec("UPDATE models SET current_version=1 WHERE id='model_test'");
  const effort = { structured: "schema", vision: false, streaming: [] };
  s.sql
    .prepare(
      "UPDATE model_profile_versions SET capabilities=json_set(capabilities,'$.reasoningEfforts',json(?)) WHERE id='model_test' AND version=1",
    )
    .run(JSON.stringify({ low: effort, high: effort }));
  const create = (reasoningEffort: string) =>
    s.request("/api/user/threads", { modelId: "model_test", reasoningEffort });
  assert.equal((await create("max")).data.error, "MODEL_REASONING_EFFORT_UNSUPPORTED");
  const first = await create("low");
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.reasoningEffort, "low");
  assert.equal(first.data.modelAvailable, true);

  s.sql.exec("UPDATE models SET current_version=2 WHERE id='model_test'");
  s.sql.exec(
    "UPDATE model_profile_versions SET capabilities=json_set(capabilities,'$.connection',0) WHERE id='model_test' AND version=2",
  );
  const reopened = await s.request(`/api/user/threads/${first.data.id}`, undefined, "GET");
  assert.equal(reopened.data.modelAvailable, true, "新版本未验证不影响已绑定的旧版本");
  s.sql.exec(
    "UPDATE model_profile_versions SET capabilities=json_set(capabilities,'$.connection',1) WHERE id='model_test' AND version=2",
  );
  const path = `/api/user/threads/${first.data.id}/model`;
  const high = await s.request(
    path,
    { expectedVersion: first.data.version, reasoningEffort: "high" },
    "PUT",
  );
  assert.equal(high.status, 200, JSON.stringify(high.data));
  assert.equal(high.data.reasoningEffort, "high");
  assert.deepEqual(high.data.reasoningEfforts, { low: effort, high: effort });
  assert.equal((await create("high")).data.error, "MODEL_REASONING_EFFORT_UNSUPPORTED");
  assert.equal(
    (await s.request(path, { expectedVersion: first.data.version, reasoningEffort: null }, "PUT"))
      .status,
    409,
  );

  const cleared = await s.request(
    path,
    { expectedVersion: high.data.version, reasoningEffort: null },
    "PUT",
  );
  assert.equal(cleared.data.reasoningEffort, null);
  const selected = await s.request(
    path,
    { expectedVersion: cleared.data.version, reasoningEffort: "low" },
    "PUT",
  );
  const switched = await s.request(
    path,
    { expectedVersion: selected.data.version, modelId: "model_test" },
    "PUT",
  );
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  assert.equal(switched.data.reasoningEffort, null);
  assert.equal(switched.data.reasoningEfforts, undefined);
  assert.equal(s.requests.length, 0);
});

test("档位经管理员生产探测通过才可选，失败不登记", async (t) => {
  const s = await productionModelFixture(t);
  s.sql.exec("UPDATE models SET current_version=1 WHERE id='model_test'");
  const admin = "/api/admin/models/model_test/reasoning-effort?version=1";
  s.replies("not the probe answer");
  const failed = await s.request(admin, { effort: "high" });
  assert.equal(failed.data.error, "MODEL_REASONING_TEST_FAILED");
  assert.equal(
    (await s.request("/api/user/threads", { modelId: "model_test", reasoningEffort: "high" })).data
      .error,
    "MODEL_REASONING_EFFORT_UNSUPPORTED",
  );
  const output = [{ type: "message", content: [{ type: "output_text", text: "42" }] }];
  s.replies(Response.json({ output }));
  assert.equal(
    (await s.request(admin, { effort: "high" })).data.error,
    "MODEL_REASONING_EFFORT_MISMATCH",
  );
  s.sql.exec(
    "UPDATE model_profile_versions SET capabilities=json_set(capabilities,'$.streaming.text','supported') WHERE id='model_test' AND version=1",
  );
  const completed = {
    type: "response.completed",
    response: { output, reasoning: { effort: "low" } },
  };
  s.replies(
    "42",
    new Response(`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    }),
    JSON.stringify({
      __model: {
        text: "",
        calls: [{ id: "check_probe", name: "check", arguments: '{"ok":true}' }],
      },
    }),
    '{"ok":true}',
  );
  const passed = await s.request(admin, { effort: "low" });
  assert.equal(passed.status, 200, JSON.stringify(passed.data));
  assert.deepEqual(passed.data.reasoningEfforts, {
    low: { structured: "schema", vision: false, streaming: ["text"] },
  });
  assert.deepEqual(
    s.requests.map((entry) => entry.body.reasoning),
    ["high", "high", "low", "low", "low", "low"].map((effort) => ({ effort })),
  );
  assert.deepEqual(
    s.requests.map((entry) => entry.body.stream === true),
    [false, false, false, true, false, false],
  );
  const usable = await s.request("/api/user/threads", {
    modelId: "model_test",
    reasoningEffort: "low",
  });
  assert.equal(usable.status, 200, JSON.stringify(usable.data));
});

test("停用模型的旧会话可切换，保留消息、任务和运行快照", async (t) => {
  const s = await productionModelFixture(t);
  const created = await s.request("/api/user/threads", {
    modelId: "model_test",
    taskId: s.run.taskId,
  });
  assert.equal(created.status, 200);
  const page = created.data;
  await appendMessage(s.env, page.id, {
    id: "history_model_switch",
    source: "cloud",
    content: "保留旧会话内容",
  });
  s.sql.exec("UPDATE runs SET status='succeeded',cleanup_pending=0");
  s.sql.exec("BEGIN");
  s.sql.exec(
    "INSERT INTO models(id,current_version,created_at,enabled) VALUES('model_next',2,1,1)",
  );
  s.sql.exec(
    "INSERT INTO model_profile_versions(id,version,config,connection_id,effective_region,capabilities,created_at) SELECT 'model_next',2,json_set(config,'$.model','next-model'),connection_id,effective_region,capabilities,created_at FROM model_profile_versions WHERE id='model_test' AND version=2",
  );
  s.sql.exec("COMMIT");
  s.sql.exec("UPDATE models SET enabled=0 WHERE id='model_test'");
  const snapshots = s.sql.prepare("SELECT * FROM run_snapshots").all();
  const versions = s.sql.prepare("SELECT * FROM task_versions").all();
  const current = (await s.request(`/api/user/threads/${page.id}`, undefined, "GET")).data;
  assert.equal(current.modelAvailable, false);
  const path = `/api/user/threads/${page.id}/model`;
  const switched = await s.request(
    path,
    { modelId: "model_next", expectedVersion: current.version },
    "PUT",
  );
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  assert.equal(switched.data.id, page.id);
  assert.equal(switched.data.modelId, "model_next");
  assert.equal(switched.data.modelAvailable, true);
  assert.ok(
    switched.data.messages.some((m: { content: string }) => m.content === "保留旧会话内容"),
  );
  assert.equal(
    s.sql.prepare("SELECT model_version FROM ai_threads WHERE id=?").get(page.id)!.model_version,
    2,
  );
  assert.deepEqual(s.sql.prepare("SELECT * FROM run_snapshots").all(), snapshots);
  assert.deepEqual(s.sql.prepare("SELECT * FROM task_versions").all(), versions);
  assert.equal(s.requests.length, 0, "切换不会触发模型调用或重放任务");
  const list = (await s.request(`/api/user/threads?taskId=${s.run.taskId}`, undefined, "GET")).data;
  assert.equal(list.items[0].id, page.id);
  assert.equal(list.items[0].model_id, "model_next");
  const staleInput = { modelId: "model_next", expectedVersion: current.version };
  const stale = await s.request(path, staleInput, "PUT");
  assert.equal(stale.status, 409);
  const disabledInput = { modelId: "model_test", expectedVersion: switched.data.version };
  const disabled = await s.request(path, disabledInput, "PUT");
  assert.equal(disabled.data.error, "MODEL_DISABLED");
  const prepare = s.env.DB.prepare.bind(s.env.DB);
  t.mock.method(s.env.DB, "prepare", (query: string) => {
    if (query.startsWith("UPDATE ai_threads SET model_id="))
      s.sql.exec("UPDATE models SET enabled=0 WHERE id='model_next'");
    return prepare(query);
  });
  const racedInput = { modelId: "model_next", expectedVersion: switched.data.version };
  const raced = await s.request(path, racedInput, "PUT");
  assert.equal(raced.status, 409, "模型在读取后停用，写入仍须拒绝");
});

test("切换拒绝运行中、收尾中、未知结果、活动回合及越权会话", async (t) => {
  const s = await productionModelFixture(t);
  const page = (
    await s.request("/api/user/threads", { modelId: "model_test", taskId: s.run.taskId })
  ).data;
  const path = `/api/user/threads/${page.id}/model`;
  const input = { modelId: "model_test", expectedVersion: page.version };
  for (const status of ["running", "queued", "waiting_user", "verifying", "unknown"]) {
    s.sql.prepare("UPDATE runs SET status=?").run(status);
    assert.equal((await s.request(path, input, "PUT")).status, 409);
  }
  s.sql.exec("UPDATE runs SET status='succeeded',cleanup_pending=1");
  assert.equal((await s.request(path, input, "PUT")).status, 409);
  s.sql.exec("UPDATE runs SET cleanup_pending=0");
  s.sql
    .prepare(
      "INSERT INTO ai_turns(id,thread_id,request_id,digest,version,status,created_at,updated_at) VALUES('active',?,'active','fixture',1,'running',1,1)",
    )
    .run(page.id);
  s.sql.prepare("UPDATE ai_threads SET active_turn='active' WHERE id=?").run(page.id);
  assert.equal((await s.request(path, input, "PUT")).status, 409);
  s.sql.prepare("UPDATE ai_threads SET active_turn=NULL WHERE id=?").run(page.id);
  s.sql.exec("INSERT INTO members(id,email,role) VALUES('other','other@example.com','user')");
  s.sql
    .prepare(
      "INSERT INTO ai_threads(id,user_id,kind,model_id,model_version,created_at,updated_at) SELECT 'other_thread','other',kind,model_id,model_version,created_at,updated_at FROM ai_threads WHERE id=?",
    )
    .run(page.id);
  const foreign = await s.request("/api/user/threads/other_thread/model", input, "PUT");
  assert.equal(foreign.status, 404);
  s.env.DEV_MODE = "0";
  assert.equal((await s.request(path, input, "PUT")).status, 401);
  const device = await app.request(
    "http://127.0.0.1" + path,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + "c".repeat(64),
      },
      body: JSON.stringify(input),
    },
    s.env,
  );
  assert.equal(device.status, 403);
});

test("旧协议会话可明确采用同一模型的当前 Responses 版本", async (t) => {
  const s = await productionModelFixture(t);
  const created = await s.request("/api/user/threads", {
    modelId: "model_test",
    taskId: s.run.taskId,
  });
  assert.equal(created.status, 200);
  const page = created.data;
  s.sql.exec("UPDATE runs SET status='succeeded',cleanup_pending=0");
  s.sql.exec(
    "UPDATE model_profile_versions SET config=json_set(config,'$.protocol','retired') WHERE id='model_test' AND version=1",
  );
  s.sql.exec("UPDATE models SET current_version=2 WHERE id='model_test'");
  const snapshots = s.sql.prepare("SELECT * FROM run_snapshots").all();
  const result = await s.request(
    `/api/user/threads/${page.id}/model`,
    { modelId: "model_test", expectedVersion: page.version },
    "PUT",
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.id, page.id);
  assert.equal(result.data.modelId, "model_test");
  assert.equal(
    s.sql.prepare("SELECT model_version FROM ai_threads WHERE id=?").get(page.id)!.model_version,
    2,
  );
  assert.deepEqual(s.sql.prepare("SELECT * FROM run_snapshots").all(), snapshots);
});
