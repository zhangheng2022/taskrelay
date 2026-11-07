import test from "node:test";
import assert from "node:assert/strict";
import { productionModelFixture } from "./production-model-fixture";
for (const protocol of ["chat", "responses"] as const)
  test(`执行器原生工具调用/${protocol} 使用运行快照模型与美国出站，不使用动作计划字段`, async (t) => {
    const s = await productionModelFixture(t, protocol);
    const call = {
      id: "native_call",
      name: "act",
      arguments: JSON.stringify({ instruction: "点击当前页面继续按钮" }),
    };
    s.replies(JSON.stringify({ __model: { text: "继续操作。", calls: [call] } }));
    const r = await s.request(`/api/runner/runs/${s.run.id}/model`, {
      epoch: s.run.leaseEpoch,
      requestId: "model_one",
      messages: [
        { role: "system", content: "执行器的工具循环" },
        { role: "user", content: "实际观察" },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.response.calls, [call]);
    assert.equal(s.jobs(), 1);
    const timing = s.sql
      .prepare(
        `SELECT a.id,a.created_at,a.egress_started_at,u.inference_started_at,
      u.provider_started_at,u.at,a.updated_at FROM ai_calls a
      JOIN model_usage u ON u.call_id=a.id AND u.run_id=a.run_id WHERE a.run_id=?`,
      )
      .all(s.run.id);
    assert.equal(timing.length, 1);
    assert.equal(timing[0].id, `execute_${s.run.id}_model_one`);
    const stamps = [
      "created_at",
      "egress_started_at",
      "inference_started_at",
      "provider_started_at",
      "at",
      "updated_at",
    ].map((key) => Date.parse(String(timing[0][key])));
    assert.ok(stamps.every(Number.isFinite));
    assert.deepEqual(
      stamps,
      [...stamps].sort((a, b) => a - b),
    );
    const body = s.requests[0].body;
    assert.equal(body.model, "vendor/non-gpt");
    assert.equal(body.tool_choice, "auto");
    assert.equal(body.response_format, undefined);
    assert.equal(body.text, undefined);
    assert.ok(body.tools.some((t: any) => (t.function?.name ?? t.name) === "act"));
    assert.equal(
      body.tools.some((t: any) => (t.function?.name ?? t.name) === "screenshot"),
      false,
    );
    s.replies("当前已完成第一项；其余项目因网站维护暂不可用。");
    const final = await s.request(`/api/runner/runs/${s.run.id}/model`, {
      epoch: s.run.leaseEpoch,
      requestId: "model_final",
      messages: [{ role: "user", content: "操作反馈" }],
    });
    assert.equal(final.status, 200);
    assert.match(final.data.response.text, /暂不可用/);
    assert.deepEqual(final.data.response.calls, []);
  });

test("只有声明支持截图工具的执行器收到截图能力，旧安装版本保持兼容", async (t) => {
  const s = await productionModelFixture(t);
  s.replies("已读取。");
  const r = await s.request(`/api/runner/runs/${s.run.id}/model`, {
    epoch: s.run.leaseEpoch,
    requestId: "screenshot_capability",
    supportsScreenshot: true,
    messages: [{ role: "user", content: "截图给我看" }],
  });
  assert.equal(r.status, 200);
  assert.ok(
    s.requests[0].body.tools.some((t: any) => (t.function?.name ?? t.name) === "screenshot"),
  );
});

test("旧云端规划、进度与报告入口不再接手新版执行", async (t) => {
  const s = await productionModelFixture(t);
  for (const route of ["plan", "batch-state", "batch-observation", "intent", "challenges"])
    assert.equal(
      (await s.request(`/api/runner/runs/${s.run.id}/${route}`, { epoch: s.run.leaseEpoch }))
        .status,
      404,
    );
});
