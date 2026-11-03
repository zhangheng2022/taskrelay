import test from "node:test";
import assert from "node:assert/strict";
import { app } from "../apps/cloud/src/index";
import type { AppEnv } from "../apps/cloud/src/env";
import { testDb, insertTask } from "./helpers";
import { claim, enqueue } from "../apps/cloud/src/store";
import { hash } from "../packages/contracts/src/security";
import { seal } from "../apps/cloud/src/crypto";
import { attachTestEgress } from "./egress-helpers";
async function setup() {
  const { db, sql } = testDb(),
    token = "a".repeat(64),
    key = Buffer.alloc(32, 7).toString("base64");
  const t = await insertTask(db);
  await enqueue(db, t, "test");
  await db
    .prepare(
      "INSERT INTO devices(id,name,token_hash,protocol_version) VALUES(?,?,?,1)",
    )
    .bind("device_test", "test", await hash(token))
    .run();
  const run = (await claim(db, "device_test", "claim_one"))!;
  await db
    .prepare(
      "INSERT INTO model_profiles(id,version,config,secret,capabilities,created_at) VALUES(?,1,?,?,?,?)",
    )
    .bind(
      "model_test",
      JSON.stringify({
        name: "test",
        baseUrl: "https://provider.example/v1",
        model: "non-gpt",
        protocol: "chat",
        inputPrice: null,
        outputPrice: null,
      }),
      await seal("fixture-key", key, "model:model_test:1"),
      JSON.stringify({
        connection: true,
        tools: true,
        structured: "schema",
        vision: false,
        testedAt: null,
      }),
      new Date().toISOString(),
    )
    .run();
  const env = {
    DB: db,
    MASTER_KEY: key,
    DEV_MODE: "1",
    OWNER_EMAIL: "962271461@qq.com",
    ACCESS_TEAM_DOMAIN: "zhangheng.cloudflareaccess.com",
    ACCESS_AUD: "test",
  } as AppEnv;
  attachTestEgress(env);
  const request = async (p: string, body?: unknown, authenticated = true) => {
    const response = await app.request(
      "http://127.0.0.1" + p,
      {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      env,
    );
    return { status: response.status, data: (await response.json()) as any };
  };
  return { db, sql, env, request, run };
}
test("设备 API 必须验证设备令牌，网页身份头不能代替设备授权", async () => {
  const s = await setup();
  assert.equal(
    (await s.request("/api/device/user/snapshot", undefined, false)).status,
    401,
  );
  assert.equal((await s.request("/api/device/user/snapshot")).status, 200);
});
test("生产环境缺少 Access JWT 时关闭访问", async () => {
  const s = await setup();
  const r = await app.request(
    "https://taskrelay.example/api/user/snapshot",
    {},
    { ...s.env, DEV_MODE: "0" },
  );
  assert.equal(r.status, 401);
});
test("验证码绑定运行/步骤/版本/租约，重复回复和重复消费不会再次授权", async () => {
  const s = await setup(),
    root = `/api/runner/runs/${s.run.id}`,
    epoch = s.run.leaseEpoch;
  const created = await s.request(root + "/challenges", {
    epoch,
    challenge: {
      kind: "code",
      instruction: "输入当前验证码",
      stepId: "step_1",
      version: 1,
      target: "#code",
    },
  });
  assert.equal(created.status, 200);
  const ch = created.data;
  const reply = {
    runId: s.run.id,
    stepId: "step_1",
    version: 1,
    leaseEpoch: epoch,
    text: "验证码001234",
  };
  assert.equal(
    (
      await s.request(`/api/user/challenges/${ch.id}/reply`, {
        ...reply,
        version: 2,
      })
    ).status,
    409,
  );
  const original = globalThis.fetch;
  globalThis.fetch = async (input) =>
    String(input).includes("cloudflare-dns")
      ? Response.json({ Status: 0, Answer: [{ type: 1, data: "8.8.8.8" }] })
      : Response.json({
          choices: [
            { message: { content: '{"start":3,"end":9,"confirmed":true}' } },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
  try {
    const first = await s.request(`/api/user/challenges/${ch.id}/reply`, reply);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(
      (await s.request(`/api/user/challenges/${ch.id}/reply`, reply)).status,
      409,
    );
    const delivery = {
      epoch,
      deliveryId: "delivery_a",
      version: 1,
      stepId: "step_1",
    };
    const result = await s.request(
      `${root}/challenges/${ch.id}/consume`,
      delivery,
    );
    assert.equal(result.data.value, "001234");
    assert.equal(
      (
        await s.db
          .prepare("SELECT write_pending FROM runs WHERE id=?")
          .bind(s.run.id)
          .first<any>()
      ).write_pending,
      1,
    );
    assert.equal(
      (
        await s.request(`${root}/challenges/${ch.id}/consume`, {
          ...delivery,
          deliveryId: "delivery_b",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await s.request(`${root}/challenges/${ch.id}/ack`, {
          epoch,
          deliveryId: "delivery_a",
        })
      ).status,
      200,
    );
    const stored = await s.db
      .prepare("SELECT secret,status FROM challenges WHERE id=?")
      .bind(ch.id)
      .first<any>();
    assert.equal(stored.secret, null);
    assert.equal(stored.status, "consumed");
    assert.equal(
      (await s.request(`${root}/challenges/${ch.id}/consume`, delivery)).status,
      409,
    );
    assert.equal(
      (await s.db.prepare("SELECT COUNT(*) n FROM conversations").first<any>())
        .n,
      0,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("旧租约动作被拒绝；取消后不能开始新的动作", async () => {
  const s = await setup(),
    path = `/api/runner/runs/${s.run.id}`;
  assert.equal(
    (await s.request(path + "/heartbeat", { epoch: s.run.leaseEpoch + 1 }))
      .status,
    409,
  );
  await s.request(`/api/user/runs/${s.run.id}/cancel`, {});
  assert.equal(
    (
      await s.request(path + "/plan", {
        epoch: s.run.leaseEpoch,
        url: "https://example.com/",
        observation: "test",
        history: [],
      })
    ).data.error,
    "CANCEL_REQUESTED",
  );
});
test("过期验证码不能提交；新一轮验证取代上一轮", async () => {
  const s = await setup(),
    root = `/api/runner/runs/${s.run.id}`,
    epoch = s.run.leaseEpoch;
  const a = (
    await s.request(root + "/challenges", {
      epoch,
      challenge: {
        kind: "code",
        instruction: "code",
        stepId: "one",
        version: 1,
        target: "#code",
      },
    })
  ).data;
  await s.db
    .prepare(
      "UPDATE challenges SET expires_at='2020-01-01T00:00:00.000Z' WHERE id=?",
    )
    .bind(a.id)
    .run();
  const r = await s.request(`/api/user/challenges/${a.id}/reply`, {
    runId: s.run.id,
    stepId: "one",
    version: 1,
    leaseEpoch: epoch,
    text: "123456",
  });
  assert.equal(r.status, 409);
  const b = await s.request(root + "/challenges", {
    epoch,
    challenge: { kind: "scan", instruction: "scan", stepId: "two", version: 2 },
  });
  assert.equal(b.status, 200);
  assert.equal(
    (
      await s.db
        .prepare("SELECT status FROM challenges WHERE id=?")
        .bind(a.id)
        .first<any>()
    ).status,
    "expired",
  );
});

test("页面变化后仍禁止相同表单重复提交；新一轮验证码形成新表单状态", async () => {
  const s = await setup(),
    root = `/api/runner/runs/${s.run.id}`,
    epoch = s.run.leaseEpoch;
  const action = {
    kind: "click",
    instruction: "提交表单",
    target: "#submit",
    value: null,
    effect: "submit",
    challengeKind: null,
  };
  const body = {
    epoch,
    actionId: "action_one",
    action,
    url: "https://example.com/",
    facts: {
      tag: "BUTTON",
      type: "submit",
      text: "提交",
      href: null,
      formDigest: "a".repeat(64),
    },
  };
  const first = await s.request(root + "/intent", body);
  assert.equal(first.status, 200);
  await s.request(root + "/action-complete", {
    epoch,
    actionId: "action_one",
    digest: first.data.digest,
    url: body.url,
    observed: true,
  });
  const repeated = await s.request(root + "/intent", {
    ...body,
    actionId: "action_two",
    action: { ...action, instruction: "换一种措辞再次提交" },
  });
  assert.equal(repeated.data.error, "DUPLICATE_WRITE_BLOCKED");
  assert.equal(
    (
      await s.request(root + "/intent", {
        ...body,
        actionId: "action_three",
        facts: { ...body.facts, formDigest: "b".repeat(64) },
      })
    ).status,
    200,
  );
});

test("写入后即使观察到页面变化，最终失败仍锁住账号等待核查", async () => {
  const s = await setup(),
    root = `/api/runner/runs/${s.run.id}`,
    epoch = s.run.leaseEpoch;
  const action = {
    kind: "fill",
    instruction: "填写",
    target: "#value",
    value: "hello",
    effect: "fill",
    challengeKind: null,
  };
  const intent = await s.request(root + "/intent", {
    epoch,
    actionId: "fill_one",
    action,
    url: "https://example.com/",
  });
  assert.equal(intent.status, 200);
  await s.request(root + "/action-complete", {
    epoch,
    actionId: "fill_one",
    digest: intent.data.digest,
    url: "https://example.com/",
    observed: true,
  });
  assert.equal(
    (
      await s.request(root + "/finish", {
        epoch,
        status: "failed",
        result: { summary: "尚未满足成功判据", outcome: "error", evidence: [] },
      })
    ).status,
    200,
  );
  const row = await s.db
    .prepare("SELECT status FROM runs WHERE id=?")
    .bind(s.run.id)
    .first<any>();
  assert.equal(row.status, "unknown");
  assert.ok(
    await s.db
      .prepare("SELECT run_id FROM account_locks WHERE run_id=?")
      .bind(s.run.id)
      .first(),
  );
});
