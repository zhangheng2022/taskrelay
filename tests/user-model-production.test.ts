import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { productionModelFixture } from "./production-model-fixture";
import { seal } from "../apps/cloud/src/crypto";

async function setup(t: TestContext, protocol: "chat" | "responses" = "chat") {
  const s = await productionModelFixture(t, protocol),
    thread = (await s.request("/api/user/threads", { modelId: "model_test", taskId: s.run.taskId }))
      .data;
  s.sql.prepare("UPDATE runs SET thread_id=? WHERE id=?").run(thread.id, s.run.id);
  const account = { username: "user@example.com", password: "Secret!001", note: "使用邮箱登录" };
  const secret = await seal(account, s.env.MASTER_KEY, "account:account_help");
  s.sql
    .prepare(
      "INSERT INTO accounts(id,name,origin,username_hint,secret,profile_id,user_id,created_at) VALUES('account_help','已保存账号','https://example.com','',?,'profile_test','legacy_owner','2026-11-05')",
    )
    .run(secret);
  s.sql
    .prepare(
      "INSERT INTO account_credential_versions(account_id,version,secret,login_origins,created_at) VALUES('account_help',1,?,'[\"https://example.com\"]','2026-11-05')",
    )
    .run(secret);
  // 新协议在领取时固定账号，协助只使用此账号，不在已打开的 Profile 内切换身份。
  s.sql.prepare("UPDATE account_locks SET account_key='account_help' WHERE run_id=?").run(s.run.id);
  s.sql
    .prepare(
      "UPDATE runs SET account_id='account_help',account_key='account_help',profile_id='profile_test',task_snapshot=json_set(task_snapshot,'$.accountId','account_help') WHERE id=?",
    )
    .run(s.run.id);
  return {
    ...s,
    thread,
    account,
    root: `/api/runner/runs/${s.run.id}`,
    help: {
      epoch: s.run.leaseEpoch,
      id: "help_saved",
      message: "需要登录信息",
      origin: "https://example.com",
    },
  };
}
const selected = JSON.stringify({
  message: "已有适用账号，交给执行器判断使用。",
  askUser: false,
  accountId: "account_help",
});

for (const protocol of ["chat", "responses"] as const)
  test(`云端协助/${protocol}：已有账号整体交给执行器，不选择单个字段`, async (t) => {
    const s = await setup(t, protocol);
    s.replies(selected);
    const result = await s.request(s.root + "/help", s.help);
    assert.deepEqual(result.data, {
      ready: true,
      message: "已有适用账号，交给执行器判断使用。",
      accountId: "account_help",
    });
    assert.doesNotMatch(JSON.stringify(s.requests), /Secret!001/);
    const credentials = await s.request(s.root + "/credentials", {
      epoch: s.run.leaseEpoch,
      helpId: s.help.id,
      url: "https://example.com/login",
    });
    assert.equal(credentials.status, 200, JSON.stringify(credentials.data));
    assert.deepEqual(credentials.data, {
      account: s.account,
      origin: "https://example.com",
      accountId: "account_help",
      credentialVersion: 1,
      stateEpoch: 1,
    });
    assert.equal(
      (
        await s.request(s.root + "/credentials", {
          epoch: s.run.leaseEpoch,
          helpId: s.help.id,
          url: "https://different.example/login",
        })
      ).data.error,
      "CREDENTIAL_ORIGIN_MISMATCH",
    );
    // 账号由领取绑定，可主动读取已授权版本；不再要求先发一次无意义的协助。
    assert.equal(
      (
        await s.request(s.root + "/credentials", {
          epoch: s.run.leaseEpoch,
          url: "https://example.com/login",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await s.request(s.root + "/credentials", {
          epoch: s.run.leaseEpoch + 1,
          url: "https://example.com/login",
        })
      ).data.error,
      "LEASE_EXPIRED",
    );
  });

for (const unavailable of ["owner", "origin", "device", "locked"] as const)
  test(`云端协助不会暴露或授权不可用账号：${unavailable}`, async (t) => {
    const s = await setup(t);
    if (unavailable === "owner") {
      s.sql.prepare("INSERT INTO members(id) VALUES('another_user')").run();
      s.sql.prepare("UPDATE accounts SET user_id='another_user' WHERE id='account_help'").run();
    }
    if (unavailable === "origin")
      s.sql
        .prepare(
          "UPDATE account_credential_versions SET login_origins='[\"https://different.example\"]' WHERE account_id='account_help'",
        )
        .run();
    if (unavailable === "device") {
      s.sql
        .prepare(
          "INSERT INTO devices(id,name,token_hash,protocol_version) VALUES('device_other','other','other_token_hash',17)",
        )
        .run();
      s.sql.prepare("UPDATE runs SET device_id='device_other' WHERE id=?").run(s.run.id);
    }
    if (unavailable === "locked")
      s.sql
        .prepare("UPDATE account_locks SET run_id='another_run' WHERE account_key='account_help'")
        .run();
    s.replies(selected);
    const result = await s.request(s.root + "/help", s.help);
    assert.equal(
      result.data.error,
      unavailable === "device" ? "LEASE_EXPIRED" : "CREDENTIAL_NOT_AUTHORIZED",
    );
    if (unavailable !== "device") {
      const payload = JSON.parse(s.requests.at(-1)!.body.messages.at(-1).content);
      assert.deepEqual(payload.accounts, []);
      assert.equal(
        s.sql.prepare("SELECT response FROM execution_help WHERE id=?").get(s.help.id)!.response,
        null,
      );
    } else assert.equal(s.requests.length, 0);
    const denied = await s.request(s.root + "/credentials", {
      epoch: s.run.leaseEpoch,
      helpId: s.help.id,
      url: "https://example.com/login",
    });
    assert.notEqual(denied.status, 200);
    assert.equal(denied.data.account, undefined);
  });

test("选择账号期间被其他运行占用，不返回可读取凭据的引用", async (t) => {
  const s = await setup(t),
    providerFetch = globalThis.fetch;
  let inject = true;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const result = await providerFetch(input, init);
    if (inject && String(input).startsWith("https://provider.example/")) {
      inject = false;
      s.sql
        .prepare("UPDATE account_locks SET run_id='other_run' WHERE account_key='account_help'")
        .run();
    }
    return result;
  });
  s.replies(selected);
  assert.equal((await s.request(s.root + "/help", s.help)).data.error, "ACCOUNT_CONTEXT_MISMATCH");
  assert.equal(
    s.sql.prepare("SELECT response FROM execution_help WHERE id=?").get(s.help.id)!.response,
    null,
  );
});

test("优先设备变化不撤销当前租约；实际运行设备变化后仍拒绝读取", async (t) => {
  const s = await setup(t);
  s.replies(selected);
  assert.equal((await s.request(s.root + "/help", s.help)).data.ready, true);
  s.sql
    .prepare(
      "INSERT INTO devices(id,name,token_hash,protocol_version) VALUES('device_other','other','other_token_hash',17)",
    )
    .run();
  s.sql
    .prepare("UPDATE accounts SET assigned_device_id='device_other' WHERE id='account_help'")
    .run();
  assert.equal(
    (
      await s.request(s.root + "/credentials", {
        epoch: s.run.leaseEpoch,
        helpId: s.help.id,
        url: "https://example.com/login",
      })
    ).status,
    200,
  );
  s.sql.prepare("UPDATE runs SET device_id='device_other' WHERE id=?").run(s.run.id);
  assert.equal(
    (
      await s.request(s.root + "/credentials", {
        epoch: s.run.leaseEpoch,
        helpId: s.help.id,
        url: "https://example.com/login",
      })
    ).data.error,
    "LEASE_EXPIRED",
  );
});
