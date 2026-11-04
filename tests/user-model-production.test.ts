import test from "node:test";
import assert from "node:assert/strict";
import { productionModelFixture } from "./production-model-fixture";
import { taskInputSchema } from "../packages/contracts/src/index";

for (const protocol of ["chat", "responses"] as const) {
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
