import test from "node:test";
import assert from "node:assert/strict";
import { productionModelFixture } from "./production-model-fixture";
import {z} from 'zod';

test('Stagehand 2020-12 原始 Schema 走生产路由，类型错误修复一次',async t=>{
  const s=await productionModelFixture(t,'responses');
  const request=body('stagehand',s.run.leaseEpoch) as any;
  request.request.responseFormat.schema=z.toJSONSchema(z.strictObject({extraction:z.string()}));
  s.replies('{"extraction":3}','{"extraction":"页面正文"}');
  const r=await s.request(`/api/runner/runs/${s.run.id}/stagehand`,request);
  assert.equal(r.status,200,JSON.stringify(r.data));
  assert.deepEqual(r.data.structuredContent,{extraction:'页面正文'});
  assert.equal(s.jobs(),2);
});

const action = {
  kind: "finish",
  instruction: "核验结果",
  target: null,
  value: null,
  effect: "read",
  challengeKind: null,
};
test('生产规划：人工信息缺少目标触发一次结构化修复，不向执行器返回无目标协助',async t=>{
  const s=await productionModelFixture(t,'responses');
  const invalid={...action,kind:'human',challengeKind:'information',instruction:'请提供虚构信息'};
  const valid={...invalid,target:'input[name="code"]'};
  s.replies(JSON.stringify(invalid),JSON.stringify(valid));
  const result=await s.request(`/api/runner/runs/${s.run.id}/plan`,body('plan',s.run.leaseEpoch));
  assert.equal(result.status,200,JSON.stringify(result.data));assert.deepEqual(result.data,valid);assert.equal(s.jobs(),2);
});
const schema = {
  type: "object",
  properties: { code: { type: "string", pattern: "^0012aB$" } },
  required: ["code"],
  additionalProperties: false,
};
const endpoints = ["plan", "stagehand"] as const;
function body(endpoint: (typeof endpoints)[number], epoch: number) {
  return endpoint === "plan"
    ? { epoch, observation: "成功", url: "https://example.com/", history: [] }
    : {
        epoch,
        request: {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "验证码 0012aB" }],
            },
          ],
          responseFormat: { type: "json_schema", name: "result", schema },
        },
      };
}
function valid(endpoint: (typeof endpoints)[number]) {
  return endpoint === "plan" ? action : { code: "0012aB" };
}

for (const endpoint of endpoints)
  for (const protocol of ["chat", "responses"] as const)
    for (const mode of ["schema", "json"] as const) {
      test(`${endpoint}/${protocol}/${mode}：生产路由校验并修复一次，保持出站、版本和用量`, async (t) => {
        const s = await productionModelFixture(t, protocol, mode);
        s.replies(
          endpoint === "plan" ? "not json" : '{"code":12}',
          JSON.stringify(valid(endpoint)),
        );
        const result = await s.request(
          `/api/runner/runs/${s.run.id}/${endpoint}`,
          body(endpoint, s.run.leaseEpoch),
        );
        assert.equal(result.status, 200, JSON.stringify(result.data));
        assert.deepEqual(
          endpoint === "plan" ? result.data : result.data.structuredContent,
          valid(endpoint),
        );
        assert.equal(s.requests.length, 2);
        assert.equal(s.jobs(), 2);
        for (const r of s.requests) {
          assert.equal(r.body.model, "vendor/non-gpt");
          assert.ok(
            r.url.endsWith(
              protocol === "chat" ? "/chat/completions" : "/responses",
            ),
          );
          const format =
            protocol === "chat" ? r.body.response_format : r.body.text.format;
          assert.equal(
            format.type,
            mode === "schema" ? "json_schema" : "json_object",
          );
          if (mode === "schema")
            assert.equal(
              protocol === "chat" ? format.json_schema.strict : format.strict,
              true,
            );
        }
        const rows = s.sql
          .prepare(
            "SELECT model_version,run_id,input_tokens,output_tokens FROM model_usage",
          )
          .all();
        assert.equal(rows.length, 2);
        for (const row of rows)
          assert.deepEqual(
            { ...row },
            {
              model_version: 1,
              run_id: s.run.id,
              input_tokens: 11,
              output_tokens: 7,
            },
          );
      });
    }
for (const endpoint of endpoints) {
  test(`${endpoint}：Schema 不匹配两次后停止，不调用第三次`, async (t) => {
    const s = await productionModelFixture(t);
    s.replies("{}", "{}");
    const r = await s.request(
      `/api/runner/runs/${s.run.id}/${endpoint}`,
      body(endpoint, s.run.leaseEpoch),
    );
    assert.equal(
      r.data.error,
      endpoint === "plan" ? "MODEL_INVALID_JSON" : "STAGEHAND_SCHEMA_INVALID",
    );
    assert.equal(s.requests.length, 2);
  });
  test(`${endpoint}：首次有效只发一次，未知用量不编造`, async (t) => {
    const s = await productionModelFixture(t);
    s.replies(
      Response.json({
        choices: [{ message: { content: JSON.stringify(valid(endpoint)) } }],
      }),
    );
    const r = await s.request(
      `/api/runner/runs/${s.run.id}/${endpoint}`,
      body(endpoint, s.run.leaseEpoch),
    );
    assert.equal(r.status, 200);
    assert.equal(s.requests.length, 1);
    assert.deepEqual(
      {
        ...s.sql
          .prepare("SELECT input_tokens,output_tokens FROM model_usage")
          .get(),
      },
      { input_tokens: null, output_tokens: null },
    );
    if (endpoint === "stagehand") assert.equal(r.data.usage, undefined);
  });
  test(`${endpoint}：缺少结构化能力时不出站`, async (t) => {
    const s = await productionModelFixture(t, "chat", "none");
    const r = await s.request(
      `/api/runner/runs/${s.run.id}/${endpoint}`,
      body(endpoint, s.run.leaseEpoch),
    );
    assert.equal(r.data.error, "STRUCTURED_OUTPUT_REQUIRED");
    assert.equal(s.jobs(), 0);
    assert.equal(s.requests.length, 0);
  });
  for (const code of [
    "MODEL_CALL_OUTCOME_UNKNOWN",
    "MODEL_EGRESS_TIMEOUT",
    "MODEL_HTTP_403_UNSUPPORTED_REGION",
  ]) {
    test(`${endpoint}：${code} 不能进入格式修复`, async (t) => {
      const s = await productionModelFixture(t);
      s.replies(new Error(code));
      const r = await s.request(
        `/api/runner/runs/${s.run.id}/${endpoint}`,
        body(endpoint, s.run.leaseEpoch),
      );
      assert.equal(r.data.error, code);
      assert.equal(s.requests.length, 1);
      assert.equal(s.jobs(), 1);
    });
  }
  test(`${endpoint}：地区不可用时不绕过出站`, async (t) => {
    const s = await productionModelFixture(t);
    t.mock.method(s.env.MODEL_EGRESS, "jurisdiction", () => {
      throw new Error(
        "Jurisdiction restrictions are not implemented in workerd.",
      );
    });
    const r = await s.request(
      `/api/runner/runs/${s.run.id}/${endpoint}`,
      body(endpoint, s.run.leaseEpoch),
    );
    assert.equal(r.data.error, "MODEL_REGION_REQUIRES_DEPLOYMENT");
    assert.equal(s.requests.length, 0);
  });
}
test("Stagehand 非法 Schema 在模型请求前被拒绝", async (t) => {
  const s = await productionModelFixture(t);
  const request = body("stagehand", s.run.leaseEpoch) as any;
  request.request.responseFormat.schema = { type: "not-a-json-type" };
  const r = await s.request(`/api/runner/runs/${s.run.id}/stagehand`, request);
  assert.equal(r.data.error, "STAGEHAND_SCHEMA_INVALID");
  assert.equal(s.jobs(), 0);
});
