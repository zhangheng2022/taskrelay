import test from "node:test";
import assert from "node:assert/strict";
import { productionModelFixture } from "./production-model-fixture";
import { taskInputSchema } from "../packages/contracts/src/index";

const proposed = {
  title: "查询状态",
  goal: "读取网站状态",
  entryUrl: "https://example.com/",
  allowedOrigins: ["https://example.com"],
  allowedActions: ["read", "navigate"],
  verification: { kind: "text_present", value: "成功" },
  schedule: { kind: "manual" },
};
for (const protocol of ["chat", "responses"] as const)
  for (const mode of ["schema", "json"] as const)
    test(`完整任务草稿/${protocol}/${mode}：可发送的 Schema 与本地原始约束同时生效`, async (t) => {
      const s = await productionModelFixture(t, protocol, mode);
      s.replies(
        JSON.stringify({
          reply: "草稿",
          task: { ...proposed, title: "a".repeat(121) },
        }),
        JSON.stringify({ reply: "草稿", task: proposed }),
      );
      const r = await s.request("/api/user/tasks/compose", {
        modelId: "model_test",
        messages: [{ role: "user", content: "查询 https://example.com/" }],
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.task.title, proposed.title);
      assert.equal(
        s.jobs(),
        2,
        "original maxLength must still reject the first output",
      );
      for (const req of s.requests) {
        const format =
          protocol === "chat" ? req.body.response_format : req.body.text.format;
        if (mode === "schema") {
          const schema =
            protocol === "chat" ? format.json_schema.schema : format.schema;
          const task = schema.properties.task.anyOf[0];
          assert.equal(task.properties.entryUrl.format, undefined);
          assert.equal(task.properties.schedule.oneOf, undefined);
          assert.deepEqual(
            task.properties.schedule.anyOf[0].properties.kind.enum,
            ["manual"],
          );
          assert.equal(schema.additionalProperties, false);
          assert.ok(task.required.includes("schedule"));
        } else {
          const messages =
            protocol === "chat" ? req.body.messages : req.body.input;
          assert.match(messages[0].content, /JSON Schema/);
          assert.match(messages[0].content, /"maxLength":120/);
          assert.match(messages[0].content, /"oneOf"/);
        }
      }
    });
test("缺少网址时简洁追问，不调用模型、不创建任务", async (t) => {
  const s = await productionModelFixture(t);
  const r = await s.request("/api/user/tasks/compose", {
    modelId: "model_test",
    messages: [{ role: "user", content: "每天帮我查订单" }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.task, null);
  assert.match(r.data.reply, /HTTPS/);
  assert.equal(s.jobs(), 0);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM tasks").get()!.n, 1);
});
test("多轮补全通过统一输出流程，仅确认创建时排队且重试幂等", async (t) => {
  const s = await productionModelFixture(t, "responses", "json");
  s.replies(
    JSON.stringify({ reply: "你希望看到什么结果？", task: null }),
    JSON.stringify({ reply: "请核对任务卡。", task: proposed }),
  );
  const messages = [{ role: "user", content: "查询 https://example.com/" }];
  const first = await s.request("/api/user/tasks/compose", {
    modelId: "model_test",
    messages,
  });
  assert.equal(first.data.task, null);
  const second = await s.request("/api/user/tasks/compose", {
    modelId: "model_test",
    messages: [
      ...messages,
      { role: "assistant", content: first.data.reply },
      { role: "user", content: "看到成功就完成" },
    ],
  });
  assert.equal(second.status, 200);
  assert.equal(second.data.task.accountId, null);
  assert.equal(second.data.task.schedule.kind, "manual");
  assert.equal(s.jobs(), 2);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM tasks").get()!.n, 1);
  const body = { task: second.data.task, requestId: "compose_confirm" };
  const created = await s.request("/api/user/tasks", body),
    retry = await s.request("/api/user/tasks", body);
  assert.equal(created.status, 201);
  assert.deepEqual(retry.data, created.data);
  assert.equal(
    s.sql
      .prepare("SELECT COUNT(*) n FROM runs WHERE task_id=?")
      .get(created.data.id)!.n,
    1,
  );
});
test("模型不能给草稿添加未提供的站点", async (t) => {
  const s = await productionModelFixture(t);
  s.replies(
    JSON.stringify({
      reply: "草稿",
      task: {
        ...proposed,
        allowedOrigins: ["https://example.com", "https://other.example"],
      },
    }),
  );
  const r = await s.request("/api/user/tasks/compose", {
    modelId: "model_test",
    messages: [{ role: "user", content: "查询 https://example.com/" }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.task, null);
  assert.match(r.data.reply, /不会替你增加/);
});
test("修改草稿保留用户选择的账号，模型不能直接保存修改", async (t) => {
  const s = await productionModelFixture(t);
  s.replies(
    JSON.stringify({
      reply: "改为每周一上午九点。",
      task: {
        ...proposed,
        schedule: {
          kind: "cron",
          expression: "0 9 * * 1",
          timezone: "Asia/Shanghai",
        },
      },
    }),
  );
  const current = taskInputSchema.strip().parse(s.run.task);
  const r = await s.request("/api/user/tasks/compose", {
    modelId: "model_test",
    messages: [{ role: "user", content: "改成每周一上午九点" }],
    current,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.task.accountId, current.accountId);
  assert.equal(r.data.task.schedule.expression, "0 9 * * 1");
  assert.equal(
    s.sql.prepare("SELECT version FROM tasks WHERE id=?").get(s.run.taskId)!
      .version,
    1,
  );
});
test("草稿结构错误仅修复一次，缺少模型能力拒绝生成", async (t) => {
  const s = await productionModelFixture(t);
  s.replies("invalid", "invalid");
  const body = {
    modelId: "model_test",
    messages: [{ role: "user", content: "查询 https://example.com" }],
  };
  assert.equal(
    (await s.request("/api/user/tasks/compose", body)).data.error,
    "MODEL_INVALID_JSON",
  );
  assert.equal(s.requests.length, 2);
  s.sql
    .prepare("UPDATE model_profiles SET capabilities=?")
    .run(
      JSON.stringify({ connection: false, tools: true, structured: "schema" }),
    );
  assert.equal(
    (await s.request("/api/user/tasks/compose", body)).data.error,
    "MODEL_CAPABILITIES_REQUIRED",
  );
  assert.equal(s.requests.length, 2);
});
