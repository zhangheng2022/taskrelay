import test from "node:test";
import assert from "node:assert/strict";
import { productionModelFixture } from "./production-model-fixture";
import { taskInputSchema } from "../packages/contracts/src/index";

for (const protocol of ["chat", "responses"] as const) {
  test(`旧版草稿/${protocol}：同一修复政策与美国出站，生成不落库`, async (t) => {
    const s = await productionModelFixture(t, protocol);
    const task = taskInputSchema
      .omit({ modelId: true, accountId: true })
      .strip()
      .parse(s.run.task);
    s.replies("invalid", JSON.stringify(task));
    const result = await s.request("/api/user/tasks/draft", {
      modelId: "model_test",
      goal: "查询 https://example.com/ 的状态",
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.modelId, "model_test");
    assert.equal(result.data.accountId, null);
    assert.equal(s.jobs(), 2);
    assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM tasks").get()!.n, 1);
    assert.ok(s.requests.every((r) => r.body.model === "do-not-select")); // New drafts use the explicitly selected profile's latest version.
  });

  test(`任务对话/${protocol}：格式修复保持任务版本，成功后幂等保存两条消息`, async (t) => {
    const s = await productionModelFixture(t, protocol, "json");
    s.replies('{"reply":42}', '{"reply":"请在调整任务中核对新配置。"}');
    const path = `/api/user/tasks/${s.run.taskId}/chat`,
      body = { requestId: "message_test", content: "我想修改时间" };
    assert.equal((await s.request(path, body)).status, 200);
    assert.equal((await s.request(path, body)).status, 200);
    assert.equal(s.jobs(), 2);
    assert.ok(s.requests.every((r) => r.body.model === "vendor/non-gpt"));
    const messages = s.sql
      .prepare("SELECT role,content FROM conversations ORDER BY role")
      .all();
    assert.deepEqual(
      messages.map((m) => [m.role, m.content]),
      [
        ["assistant", "请在调整任务中核对新配置。"],
        ["user", body.content],
      ],
    );
    assert.equal(
      s.sql.prepare("SELECT version FROM tasks WHERE id=?").get(s.run.taskId)!
        .version,
      1,
    );
  });

  test(`验证回复/${protocol}：修复后保留原文，消费绑定和敏感清理仍走生产路由`, async (t) => {
    const s = await productionModelFixture(t, protocol, "json");
    const root = `/api/runner/runs/${s.run.id}`,
      epoch = s.run.leaseEpoch;
    const created = await s.request(root + "/challenges", {
      epoch,
      challenge: {
        kind: "code",
        instruction: "输入当前验证码",
        stepId: "step_code",
        version: 1,
        target: "#code",
      },
    });
    assert.equal(created.status, 200);
    const ch = created.data;
    s.replies(
      '{"start":"3","end":9,"confirmed":true}',
      '{"start":3,"end":9,"confirmed":true}',
    );
    const body = {
      runId: s.run.id,
      stepId: "step_code",
      version: 1,
      leaseEpoch: epoch,
      text: "验证码0012aB",
    };
    assert.equal(
      (await s.request(`/api/user/challenges/${ch.id}/reply`, body)).status,
      200,
    );
    assert.equal(
      (await s.request(`/api/user/challenges/${ch.id}/reply`, body)).data.error,
      "CHALLENGE_STALE",
    );
    assert.equal(s.jobs(), 2);
    assert.ok(s.requests.every((r) => r.body.model === "vendor/non-gpt"));
    assert.equal(
      s.sql.prepare("SELECT COUNT(*) n FROM conversations").get()!.n,
      0,
    );
    assert.equal(
      s.sql
        .prepare("SELECT COUNT(*) n FROM model_usage WHERE run_id=?")
        .get(s.run.id)!.n,
      2,
    );
    const delivery = {
      epoch,
      deliveryId: "delivery_test",
      version: 1,
      stepId: "step_code",
    };
    const consumed = await s.request(
      `${root}/challenges/${ch.id}/consume`,
      delivery,
    );
    assert.equal(consumed.data.value, "0012aB");
    assert.equal(
      (
        await s.request(`${root}/challenges/${ch.id}/ack`, {
          epoch,
          deliveryId: delivery.deliveryId,
        })
      ).status,
      200,
    );
    assert.equal(
      s.sql.prepare("SELECT secret FROM challenges WHERE id=?").get(ch.id)!
        .secret,
      null,
    );
  });
}

test("任务对话格式连续错误不保存半条对话，不能产生第三次请求", async (t) => {
  const s = await productionModelFixture(t);
  s.replies("invalid", "invalid");
  const r = await s.request(`/api/user/tasks/${s.run.taskId}/chat`, {
    requestId: "failed_message",
    content: "查看任务",
  });
  assert.equal(r.data.error, "MODEL_INVALID_JSON");
  assert.equal(s.jobs(), 2);
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM conversations").get()!.n,
    0,
  );
});
