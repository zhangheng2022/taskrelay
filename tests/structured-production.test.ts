import test from "node:test";
import assert from "node:assert/strict";
import { productionModelFixture } from "./production-model-fixture";
import { visionFixture } from "../apps/cloud/src/vision-fixture";
test(`执行器原生工具调用/Responses 使用运行快照模型与美国出站，不使用动作计划字段`, async (t) => {
  const s = await productionModelFixture(t, "responses");
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
  ].map((key) => Number(timing[0][key]));
  assert.ok(stamps.every(Number.isFinite));
  assert.deepEqual(
    stamps,
    [...stamps].sort((a, b) => a - b),
  );
  const body = s.requests[0].body;
  assert.equal(body.model, "vendor/non-gpt");
  assert.equal(body.reasoning, undefined, "旧快照使用供应商默认值");
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

test("执行器工具决策和 Stagehand 使用固定快照的推理强度", async (t) => {
  const s = await productionModelFixture(t);
  s.sql
    .exec(`UPDATE run_snapshots SET task_snapshot=json_set(task_snapshot,'$.reasoningEffort','low');
    UPDATE model_profile_versions SET capabilities=json_set(capabilities,'$.reasoningEfforts.low',json('{"structured":"schema","vision":false,"streaming":[]}')) WHERE id='model_test' AND version=1`);
  const message = [{ role: "user", content: "读取网页信息" }];
  s.replies("页面可用", '{"ok":true}');
  const model = await s.request(`/api/runner/runs/${s.run.id}/model`, {
    epoch: s.run.leaseEpoch,
    requestId: "fixed_effort",
    messages: message,
  });
  assert.equal(model.status, 200, JSON.stringify(model.data));
  const stagehand = await s.request(`/api/runner/runs/${s.run.id}/stagehand`, {
    epoch: s.run.leaseEpoch,
    messages: message,
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
  });
  assert.equal(stagehand.status, 200, JSON.stringify(stagehand.data));
  assert.equal(s.requests.length, 2);
  for (const { body } of s.requests) {
    assert.equal(body.model, "vendor/non-gpt");
    assert.deepEqual(body.reasoning, { effort: "low" });
  }
  assert.equal(s.requests[1].body.text.format.type, "json_schema");
});

test("模型的默认档支持图像时，仍拒绝未经图像验证的显式档位", async (t) => {
  const s = await productionModelFixture(t);
  s.sql
    .exec(`UPDATE run_snapshots SET task_snapshot=json_set(task_snapshot,'$.reasoningEffort','low');
    UPDATE model_profile_versions SET capabilities=json_set(capabilities,'$.vision',1,
    '$.reasoningEfforts.low',json('{"structured":"schema","vision":false,"streaming":[]}')) WHERE id='model_test' AND version=1`);
  const send = (requestId: string) =>
    s.request(`/api/runner/runs/${s.run.id}/model`, {
      epoch: s.run.leaseEpoch,
      requestId,
      messages: [
        {
          role: "user",
          content: "读取图片颜色",
          content_blocks: [{ type: "image_url", image_url: { url: visionFixture } }],
        },
      ],
    });
  const blocked = await send("image_block_unverified");
  assert.equal(blocked.data.error, "MODEL_REASONING_VISION_UNSUPPORTED");
  assert.equal(s.requests.length, 0, "不允许把图片送到未验证的档位");
  s.sql.exec(
    "UPDATE model_profile_versions SET capabilities=json_set(capabilities,'$.reasoningEfforts.low.vision',1) WHERE id='model_test' AND version=1",
  );
  s.replies("红色");
  const verified = await send("image_block_verified");
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  assert.equal(s.requests.length, 1);
  assert.deepEqual(s.requests[0].body.reasoning, { effort: "low" });
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
