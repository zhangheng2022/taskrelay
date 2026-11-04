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
const reply = (task: unknown = proposed) =>
  JSON.stringify({
    reply: "请核对任务卡",
    task,
    partial: "查询网站",
    missing: [],
  });
for (const protocol of ["chat", "responses"] as const)
  for (const mode of ["schema", "json"] as const)
    test(`持久化创建/${protocol}/${mode}：修复、原始约束、确认与幂等`, async (t) => {
      const s = await productionModelFixture(t, protocol, mode);
      const thread = (
        await s.request("/api/user/threads", {
          kind: "compose",
          modelId: "model_test",
        })
      ).data;
      assert.ok(thread.id, JSON.stringify(thread));
      s.replies(reply({ ...proposed, title: "a".repeat(121) }), reply());
      const body = {
        requestId: "message",
        expectedVersion: 0,
        content: "查看 https://example.com/ 是否成功",
      };
      const response = await s.request(
        `/api/user/threads/${thread.id}/messages`,
        body,
      );
      assert.equal(response.data.status, "done", JSON.stringify(response.data));
      assert.equal(s.jobs(), 2);
      const retry = await s.request(
        `/api/user/threads/${thread.id}/messages`,
        body,
      );
      assert.equal(retry.data.version, response.data.version);
      assert.equal(s.jobs(), 2);
      assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM tasks").get()!.n, 1);
      const create = {
        task: response.data.draft,
        threadId: thread.id,
        draftVersion: response.data.version,
        requestId: "confirm",
      };
      const result = await s.request("/api/user/tasks", create);
      assert.equal(result.status, 201, JSON.stringify(result.data));
      assert.equal(
        (await s.request("/api/user/tasks", create)).data.id,
        result.data.id,
      );
      assert.equal(
        s.sql
          .prepare("SELECT COUNT(*) n FROM runs WHERE task_id=?")
          .get(result.data.id)!.n,
        1,
      );
    });
test("缺少地址不调用模型；刷新恢复历史并接受无协议域名", async (t) => {
  const s = await productionModelFixture(t);
  const thread = (
    await s.request("/api/user/threads", {
      kind: "compose",
      modelId: "model_test",
    })
  ).data;
  const first = await s.request(`/api/user/threads/${thread.id}/messages`, {
    requestId: "one",
    expectedVersion: 0,
    content: "查看网站",
  });
  assert.equal(first.data.status, "done");
  assert.equal(s.jobs(), 0);
  assert.match(first.data.messages[1].content, /网站地址/);
  const restored = await s.request(
    `/api/user/threads/${thread.id}`,
    undefined,
    "GET",
  );
  assert.equal(restored.data.messages.length, 2);
  s.replies(reply());
  const second = await s.request(`/api/user/threads/${thread.id}/messages`, {
    requestId: "two",
    expectedVersion: 1,
    content: "example.com，看到成功算完成",
  });
  assert.equal(second.data.status, "done", JSON.stringify(second.data));
  assert.equal(second.data.messages.length, 4);
  assert.match(JSON.stringify(s.requests[0].body), /查看网站/);
});
test("助手不能增加站点，结构错误只修复一次，旧入口已移除", async (t) => {
  const s = await productionModelFixture(t);
  const th = (
    await s.request("/api/user/threads", {
      kind: "compose",
      modelId: "model_test",
    })
  ).data;
  s.replies(reply({ ...proposed, allowedOrigins: ["https://evil.example"] }));
  const r = await s.request(`/api/user/threads/${th.id}/messages`, {
    requestId: "bad",
    expectedVersion: 0,
    content: "example.com",
  });
  assert.equal(r.data.error, "DRAFT_ORIGIN_REJECTED");
  assert.equal(r.data.draft, null);
  s.replies("invalid", "invalid");
  const failed = await s.request(`/api/user/threads/${th.id}/messages`, {
    requestId: "bad2",
    expectedVersion: 1,
    content: "example.com",
  });
  assert.equal(failed.data.error, "MODEL_INVALID_JSON");
  assert.equal(s.jobs(), 3);
  assert.equal((await s.request("/api/user/tasks/compose", {})).status, 404);
  assert.equal((await s.request("/api/user/tasks/draft", {})).status, 404);
});
test("聊天包含历史和实际任务，固定任务模型版本；消息冲突和旧版本拒绝", async (t) => {
  const s = await productionModelFixture(t);
  const th = (
    await s.request("/api/user/threads", {
      kind: "chat",
      modelId: "model_test",
      taskId: s.run.taskId,
    })
  ).data;
  s.replies('{"reply":"记住本次讨论"}', '{"reply":"根据上文回答"}');
  const a = await s.request(`/api/user/threads/${th.id}/messages`, {
    requestId: "a",
    expectedVersion: 0,
    content: "需要中文报告",
  });
  assert.equal(a.data.status, "done", JSON.stringify(a.data));
  const b = await s.request(`/api/user/threads/${th.id}/messages`, {
    requestId: "b",
    expectedVersion: 1,
    content: "按刚才的要求",
  });
  assert.equal(b.data.status, "done", JSON.stringify(b.data));
  assert.ok(s.requests.every((r) => r.body.model === "vendor/non-gpt"));
  assert.match(JSON.stringify(s.requests[1].body), /需要中文报告/);
  assert.equal(
    (
      await s.request(`/api/user/threads/${th.id}/messages`, {
        requestId: "b",
        expectedVersion: 1,
        content: "替换内容",
      })
    ).data.error,
    "MESSAGE_CONFLICT",
  );
  assert.equal(
    (
      await s.request(`/api/user/threads/${th.id}/messages`, {
        requestId: "c",
        expectedVersion: 0,
        content: "过期",
      })
    ).data.error,
    "THREAD_VERSION_CONFLICT",
  );
});
test("手工修改草稿增加版本；旧确认卡拒绝，编辑原任务保留账号", async (t) => {
  const s = await productionModelFixture(t);
  const th = (
    await s.request("/api/user/threads", {
      kind: "compose",
      modelId: "model_test",
      taskId: s.run.taskId,
    })
  ).data;
  const draft = taskInputSchema.strip().parse(s.run.task);
  const changed = await s.request(
    `/api/user/threads/${th.id}/draft`,
    { expectedVersion: 0, draft },
    "PUT",
  );
  assert.equal(changed.data.draft.accountId, draft.accountId);
  const r = await s.request(
    `/api/user/tasks/${s.run.taskId}`,
    {
      requestId: "update",
      expectedVersion: 1,
      threadId: th.id,
      draftVersion: 0,
      task: draft,
    },
    "PUT",
  );
  assert.equal(r.data.error, "DRAFT_VERSION_CONFLICT");
});

test('修改任务的确认可重试，固定草稿模型版本且只新增一个任务版本',async t=>{
 const s=await productionModelFixture(t);
 const th=(await s.request('/api/user/threads',{kind:'compose',modelId:'model_test',taskId:s.run.taskId})).data;
 const draft={...taskInputSchema.strip().parse(s.run.task),accountId:null,title:'确认后的新标题'};
 const saved=(await s.request(`/api/user/threads/${th.id}/draft`,{expectedVersion:0,draft},'PUT')).data;
 const body={requestId:'update_task',expectedVersion:1,threadId:th.id,draftVersion:saved.version,task:draft};
 const first=await s.request(`/api/user/tasks/${s.run.taskId}`,body,'PUT');assert.equal(first.status,200,JSON.stringify(first.data));
 assert.deepEqual((await s.request(`/api/user/tasks/${s.run.taskId}`,body,'PUT')).data,first.data);
 assert.equal(s.sql.prepare('SELECT COUNT(*) n FROM task_versions WHERE task_id=? AND version=2').get(s.run.taskId)!.n,1);
 assert.equal((await s.request(`/api/user/tasks/${s.run.taskId}`,{...body,task:{...draft,title:'变更'}},'PUT')).data.error,'IDEMPOTENCY_CONFLICT');
});

test('报告读取 unknown 事实；等待协助时普通消息不能绕过敏感回复通道',async t=>{
 const s=await productionModelFixture(t);
 s.sql.prepare("UPDATE runs SET status='unknown' WHERE id=?").run(s.run.id);
 const th=(await s.request('/api/user/threads',{kind:'chat',modelId:'model_test',taskId:s.run.taskId})).data;
 s.replies('{"reply":"结果待核查，不应重复提交"}');
 const report=await s.request(`/api/user/threads/${th.id}/messages`,{requestId:'report',expectedVersion:0,mode:'report',content:'生成报告'});
 assert.equal(report.data.status,'done');assert.match(JSON.stringify(s.requests[0].body),/unknown不能表述为成功/);
 assert.equal(s.sql.prepare('SELECT status FROM runs WHERE id=?').get(s.run.id)!.status,'unknown');
 s.sql.prepare("INSERT INTO challenges(id,run_id,lease_epoch,version,step_id,kind,instruction,status,expires_at) VALUES('sensitive',?,1,1,'step','code','输入验证码','pending','2099-01-01')").run(s.run.id);
 assert.equal((await s.request(`/api/user/threads/${th.id}/messages`,{requestId:'code',expectedVersion:1,content:'0012Ab'})).data.error,'USE_CHALLENGE_REPLY');
 assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ai_messages WHERE content='0012Ab'").get()!.n,0);
});
