import test from "node:test";
import assert from "node:assert/strict";
import { sendAuthMail } from "../apps/cloud/src/mail";
import { identity } from "../apps/cloud/src/identity";
import type { AppEnv } from "../apps/cloud/src/env";
import { testDb } from "./helpers";
import { app } from "../apps/cloud/src/index";

test("真实认证入口通过 Brevo 发送验证与重置邮件；重置令牌只能消费一次", async () => {
  const { db } = testDb();
  const env = {
    DB: db,
    AUTH_BASE_URL: "http://localhost",
    AUTH_SECRET: "isolated-auth-mail-test-secret-32-characters",
    BREVO_API_KEY: "test-only-key",
    MAIL_FROM: "noreply@mail.example.com",
  } as unknown as AppEnv;
  const original = globalThis.fetch;
  const sent: Array<any> = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.brevo.com/v3/smtp/email");
    assert.equal(new Headers(init?.headers).get("api-key"), "test-only-key");
    assert.equal(init?.redirect, "manual");
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ messageId: "test-only-message" }, { status: 201 });
  };
  try {
    const auth = identity(env);
    const request = (path: string, body?: unknown, cookie = "") =>
      auth.handler(
        new Request("http://localhost/api/auth/" + path, {
          method: body ? "POST" : "GET",
          headers: {
            Origin: "http://localhost",
            "Content-Type": "application/json",
            Cookie: cookie,
          },
          body: body ? JSON.stringify(body) : undefined,
        }),
      );
    const email = "verify@example.com",
      password = "test-password-at-least-12";
    const signup = await request("sign-up/email", { name: "Test", email, password });
    assert.equal(signup.status, 200, await signup.clone().text());
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, [{ email }]);
    assert.equal(sent[0].sender.email, env.MAIL_FROM);
    assert.equal((await request("sign-in/email", { email, password })).status, 403);
    const link = sent[0].textContent.match(/http:\/\/localhost\S+/)[0];
    const verified = await auth.handler(new Request(link));
    assert.ok(verified.status < 400, await verified.clone().text());
    const login = await request("sign-in/email", { email, password });
    assert.equal(login.status, 200, await login.clone().text());
    const cookie = login.headers
      .getSetCookie()
      .map((x) => x.split(";")[0])
      .join("; ");
    const reset = await request("request-password-reset", {
      email,
      redirectTo: "http://localhost/",
    });
    assert.equal(reset.status, 200, await reset.clone().text());
    assert.equal(sent.length, 2);
    const resetLink = sent[1].textContent.match(/http:\/\/localhost\S+/)[0];
    const redirect = await auth.handler(new Request(resetLink));
    const token = new URL(redirect.headers.get("location")!, "http://localhost").searchParams.get(
      "token",
    );
    assert.ok(token);
    const changed = await request("reset-password", {
      token,
      newPassword: "replacement-password-at-least-12",
    });
    assert.equal(changed.status, 200, await changed.clone().text());
    assert.equal((await request("get-session", undefined, cookie)).status, 200);
    assert.equal(await (await request("get-session", undefined, cookie)).json(), null);
    assert.equal(
      (await request("reset-password", { token, newPassword: "another-password-at-least-12" }))
        .status,
      400,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("认证数据库异常不向响应或控制台泄露查询参数", async () => {
  const { db, sql } = testDb();
  const env = {
    DB: db,
    AUTH_BASE_URL: "http://localhost",
    AUTH_SECRET: "isolated-auth-test-secret-32-characters",
    OWNER_EMAIL: "owner@example.com",
  } as unknown as AppEnv;
  const auth = identity(env),
    ctx = await auth.$context;
  const at = Date.now();
  sql
    .prepare(
      "INSERT INTO auth_user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)",
    )
    .run("broken", "Test", "broken@example.com", at, at);
  sql
    .prepare(
      "INSERT INTO auth_account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES('broken','broken','credential','broken','old-secret-hash',?,?)",
    )
    .run(at, at);
  await ctx.internalAdapter.createVerificationValue({
    identifier: "reset-password:test-token",
    value: "broken",
    expiresAt: new Date(at + 3600000),
  });
  sql.exec(
    "CREATE TRIGGER break_password BEFORE UPDATE OF password ON auth_account BEGIN SELECT RAISE(ABORT,'private-database-detail'); END;",
  );
  const original = console.error,
    logs: unknown[][] = [];
  console.error = (...args) => {
    logs.push(args);
  };
  try {
    const r = await app.request(
      "http://localhost/api/auth/reset-password",
      {
        method: "POST",
        headers: { Origin: "http://localhost", "Content-Type": "application/json" },
        body: JSON.stringify({ token: "test-token", newPassword: "new-private-password" }),
      },
      env,
    );
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: "INTERNAL_ERROR" });
    assert.deepEqual(logs, []);
  } finally {
    console.error = original;
    sql.close();
  }
});

test("发信失败、重定向和未知结果固定报错且不自动重发", async () => {
  const original = globalThis.fetch;
  try {
    for (const response of [
      new Response("upstream-secret", { status: 401 }),
      new Response(null, { status: 302, headers: { Location: "https://other.example" } }),
      Response.json({}, { status: 201 }),
    ]) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return response;
      };
      await assert.rejects(
        () =>
          sendAuthMail(
            { BREVO_API_KEY: "secret", MAIL_FROM: "noreply@example.com" },
            "recipient@example.com",
            "https://example.com/?token=private",
            "验证邮箱",
          ),
        { message: "EMAIL_DELIVERY_FAILED" },
      );
      assert.equal(calls, 1);
    }
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("unknown upstream secret");
    };
    await assert.rejects(
      () =>
        sendAuthMail(
          { BREVO_API_KEY: "secret", MAIL_FROM: "noreply@example.com" },
          "recipient@example.com",
          "https://example.com/?token=private",
          "验证邮箱",
        ),
      { message: "EMAIL_DELIVERY_FAILED" },
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
