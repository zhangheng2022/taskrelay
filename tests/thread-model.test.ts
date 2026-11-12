/** 会话切换通过真实路由验证归属、空闲条件与固定历史快照。 */
import test from "node:test";
import assert from "node:assert/strict";
import { productionModelFixture } from "./production-model-fixture";
import { appendMessage } from "../apps/cloud/src/chat-messages";
import { app } from "../apps/cloud/src/index";

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
  const path = `/api/user/threads/${page.id}/model`;
  const switched = await s.request(
    path,
    { modelId: "model_next", expectedVersion: current.version },
    "PUT",
  );
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  assert.equal(switched.data.id, page.id);
  assert.equal(switched.data.modelId, "model_next");
  assert.ok(switched.data.messages.some((m: { content: string }) => m.content === "保留旧会话内容"));
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
  assert.equal(
    (await s.request(path, { modelId: "model_next", expectedVersion: current.version }, "PUT"))
      .status,
    409,
  );
  assert.equal(
    (
      await s.request(
        path,
        { modelId: "model_test", expectedVersion: switched.data.version },
        "PUT",
      )
    ).data.error,
    "MODEL_DISABLED",
  );
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
  s.sql.prepare("UPDATE ai_threads SET active_turn='active' WHERE id=?").run(page.id);
  assert.equal((await s.request(path, input, "PUT")).status, 409);
  s.sql.prepare("UPDATE ai_threads SET active_turn=NULL WHERE id=?").run(page.id);
  s.sql.exec("INSERT INTO members(id,email,role) VALUES('other','other@example.com','user')");
  s.sql.prepare("UPDATE ai_threads SET user_id='other' WHERE id=?").run(page.id);
  assert.equal((await s.request(path, input, "PUT")).status, 404);
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
