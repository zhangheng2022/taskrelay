import { dbTime } from "../apps/cloud/src/database";
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword } from "better-auth/crypto";
import { authClient, authResult } from "../packages/ui/src/auth-client";
import { app } from "../apps/cloud/src/index";
import type { AppEnv } from "../apps/cloud/src/env";
import { testDb } from "./helpers";

// 将浏览器 SDK 发出的实际请求交给生产认证路由，测试库中只有合成的已验证账号。
test("网站邮箱登录发送单一 JSON 媒体类型并签发可用会话", async (t) => {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  const origin = "http://localhost";
  const email = "login-fixture@example.com";
  const password = "fixture-only-long-password";
  const env = {
    DB: db,
    AUTH_BASE_URL: origin,
    AUTH_SECRET: "local-fixture-secret-for-login-tests",
  } as AppEnv;
  const at = Date.now();
  sql
    .prepare(
      "INSERT INTO auth_user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)",
    )
    .run("login-fixture", "Test", email, dbTime(at), dbTime(at));
  sql
    .prepare(
      "INSERT INTO auth_account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,'credential',?,?,?,?)",
    )
    .run(
      "login-account",
      "login-fixture",
      "login-fixture",
      await hashPassword(password),
      dbTime(at),
      dbTime(at),
    );
  let cookie = "";
  let mediaType: string | null = null;
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const request = new Request(new URL(input, origin), init);
    assert.equal(new URL(request.url).pathname, "/api/auth/sign-in/email");
    request.headers.set("Origin", origin);
    mediaType = request.headers.get("content-type");
    const response = await app.fetch(request, env);
    cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    return response;
  });
  await authResult(authClient.signIn.email({ email, password }));
  assert.equal(mediaType, "application/json");
  assert.ok(cookie);
  const session = await app.request(origin + "/api/auth/get-session", { headers: { cookie } }, env);
  assert.equal(session.status, 200);
  assert.equal(((await session.json()) as { user: { email: string } }).user.email, email);
});

test("Better Auth 会话列表、指定撤销及改密撤销其他会话经过真实路由", async (t) => {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  const origin = "http://localhost",
    at = dbTime(Date.now()),
    password = "fixture-session-password";
  const env = {
    DB: db,
    AUTH_BASE_URL: origin,
    AUTH_SECRET: "session-fixture-secret-longer-than-thirty-two",
  } as AppEnv;
  sql
    .prepare(
      "INSERT INTO auth_user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('session-user','Test','session@example.com',1,?,?)",
    )
    .run(at, at);
  sql
    .prepare(
      "INSERT INTO auth_account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES('session-account','session-user','credential','session-user',?,?,?)",
    )
    .run(await hashPassword(password), at, at);
  const request = async (path: string, body?: unknown, cookie = "") =>
    app.request(
      origin + "/api/auth/" + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  const login = async () => {
    const r = await request("sign-in/email", { email: "session@example.com", password });
    assert.equal(r.status, 200);
    return r.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
  };
  const first = await login(),
    second = await login();
  const sessions = (await (await request("list-sessions", undefined, first)).json()) as {
    token: string;
    id: string;
  }[];
  assert.equal(sessions.length, 2);
  const me = (await (await request("get-session", undefined, first)).json()) as {
    session: { id: string };
  };
  const other = sessions.find((s) => s.id !== me.session.id)!;
  assert.equal((await request("revoke-session", { token: other.token }, first)).status, 200);
  assert.equal(await (await request("get-session", undefined, second)).json(), null);
  const third = await login();
  const changed = await request(
    "change-password",
    {
      currentPassword: password,
      newPassword: "changed-fixture-password",
      revokeOtherSessions: true,
    },
    first,
  );
  assert.equal(changed.status, 200);
  assert.equal(await (await request("get-session", undefined, third)).json(), null);
  assert.equal((await request("sign-out", {}, first)).status, 200);
  assert.equal(await (await request("get-session", undefined, first)).json(), null);
});
