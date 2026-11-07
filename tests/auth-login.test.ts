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
