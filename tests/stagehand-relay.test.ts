import test from "node:test";
import assert from "node:assert/strict";
import { stagehandModel } from "../apps/desktop/src/executor/stagehand-model";
import { productionModelFixture } from "./production-model-fixture";

for (const protocol of ["chat", "responses"] as const)
  test(`Stagehand ClientLLM 经生产 ${protocol} 入口保留树编号/schema，固定运行模型及美国出站`, async (t) => {
    const s = await productionModelFixture(t, protocol);
    const schema = {
      type: "object",
      properties: { elementId: { type: "string" } },
      required: ["elementId"],
      additionalProperties: false,
    };
    const tree = "[1-77] button 无 id 的嵌套按钮\n" + "[1-78] text 页面内容\n".repeat(1200);
    const result = { elementId: "1-77" };
    s.replies(JSON.stringify(result));
    let input: any;
    const model = stagehandModel({
      guard: () => {},
      redact: (text) => text,
      image: async () => {
        throw Error("unexpected image");
      },
      request: async (body) => {
        input = body;
        const r = await s.request(`/api/runner/runs/${s.run.id}/stagehand`, {
          epoch: s.run.leaseEpoch,
          ...body,
        });
        assert.equal(r.status, 200, JSON.stringify(r.data));
        return r.data;
      },
    });
    const reply = await model.generate({
      systemPrompt: "Stagehand observe",
      messages: [{ role: "user", content: { type: "text", text: tree } }],
      responseFormat: { type: "json_schema", name: "Observation", schema },
    });
    assert.equal(reply.outputFormat, "json_schema");
    assert.deepEqual((reply as any).structuredContent, result);
    assert.equal(s.jobs(), 1);
    const body = s.requests[0].body;
    assert.equal(body.model, "vendor/non-gpt");
    assert.ok(JSON.stringify(body).includes("[1-77]"));
    const messages = protocol === "chat" ? body.messages : body.input;
    assert.equal(messages[1].content, tree);
    const duplicate = await s.request(`/api/runner/runs/${s.run.id}/stagehand`, {
      epoch: s.run.leaseEpoch,
      ...input,
    });
    assert.equal(duplicate.status, 200);
    assert.equal(s.jobs(), 1);
  });

test("Stagehand 图片只转发脱敏截图，取消时不交回可执行的定位结果", async () => {
  let sent: any,
    cancelled = false;
  const model = stagehandModel({
    guard: () => {
      if (cancelled) throw Error("CANCEL_REQUESTED");
    },
    redact: (text) => text,
    image: async () => "vision_masked",
    request: async (body) => {
      sent = body;
      cancelled = true;
      return { text: "{}", structured: {} };
    },
  });
  await assert.rejects(
    model.generate({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "看当前页面" },
            { type: "image", mimeType: "image/png", data: "c2VjcmV0" },
          ],
        },
      ],
      responseFormat: { type: "json_schema", name: "Extraction", schema: { type: "object" } },
    }),
    /CANCEL_REQUESTED/,
  );
  assert.equal(sent.imageArtifactId, "vision_masked");
  assert.equal(sent.image, undefined);
  assert.doesNotMatch(JSON.stringify(sent), /c2VjcmV0/);
});

test("模型未配置视觉能力时图片请求明确反馈，不暗换提供方", async (t) => {
  const s = await productionModelFixture(t);
  const r = await s.request(`/api/runner/runs/${s.run.id}/stagehand`, {
    epoch: s.run.leaseEpoch,
    requestId: "vision",
    messages: [],
    image: "data:image/png;base64,bWFza2Vk",
  });
  assert.notEqual(r.status, 200);
  assert.equal(s.jobs(), 0);
});

test("执行推理收到本次聊天截图事实，截图交付与模型视觉能力分开", async (t) => {
  const s = await productionModelFixture(t);
  const decision = "已完成，截图在聊天中。";
  await s.db
    .prepare(
      "INSERT INTO ai_threads(id,user_id,kind,model_id,model_version,created_at,updated_at) VALUES('shot_thread','fixture_owner','chat','model_test',1,1780000000000,1780000000000)",
    )
    .run();
  await s.db
    .prepare(
      "INSERT INTO artifacts(id,run_id,object_key,content_type,expires_at) VALUES('shot_current',?,'key','image/png',4070908800000)",
    )
    .bind(s.run.id)
    .run();
  await s.db
    .prepare(
      "INSERT INTO artifacts(id,run_id,object_key,content_type,expires_at) VALUES('shot_other','other_run','key','image/png',4070908800000)",
    )
    .run();
  await s.db
    .prepare(
      "INSERT INTO ai_messages(id,thread_id,seq,role,turn_id,at,source,run_id) VALUES('shot_message','shot_thread',1,'assistant','turn',1780000000000,'executor',?)",
    )
    .bind(s.run.id)
    .run();
  await s.db
    .prepare("INSERT INTO message_bodies(id,content,parts) VALUES('shot_message','页面',?)")
    .bind(
      JSON.stringify([
        { type: "image", artifactId: "shot_current" },
        { type: "image", artifactId: "shot_other" },
      ]),
    )
    .run();
  s.replies(decision);
  const r = await s.request(`/api/runner/runs/${s.run.id}/model`, {
    epoch: s.run.leaseEpoch,
    requestId: "shot_facts",
    messages: [
      { role: "system", content: "执行器指令" },
      {
        role: "user",
        content: JSON.stringify({ goal: "提交一次并附截图", untrustedPage: { tree: "提交成功" } }),
      },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.response.text, decision);
  assert.equal(r.data.memory, undefined);
  const facts = s.requests[0].body.messages.find((m: any) =>
    m.content.includes("运行能力与聊天附件反馈"),
  ).content;
  assert.match(facts, /截图数量=1/);
  assert.match(facts, /保存与展示截图不需要视觉模型/);
  assert.equal(s.jobs(), 1);
});

test("Stagehand 原生模型收到原始用户上下文，不依赖上层提取的密码字段", async () => {
  let sent: any;
  const original = "我的测试密码是 0012Ab!，如果无法登录就改用邮箱。";
  const model = stagehandModel({
    guard: () => {},
    redact: (x) => x,
    image: async () => "",
    context: () => JSON.stringify({ userMessages: [{ role: "user", content: original }] }),
    request: async (body) => {
      sent = body;
      return { text: "{}", structured: {} };
    },
  });
  await model.generate({
    systemPrompt: "Stagehand",
    messages: [{ role: "user", content: { type: "text", text: "[0-7] textbox 密码" } }],
    responseFormat: { type: "json_schema", name: "Act", schema: { type: "object" } },
  });
  assert.ok(sent.messages.some((m: any) => m.content.includes(original)));
  assert.ok(sent.messages.some((m: any) => m.content === "[0-7] textbox 密码"));
});
