import { dbTime } from "./database";
/** 网站认证：配置 Better Auth、验证邮箱后绑定业务成员，并为注册和邮件入口实施准入校验。 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/d1";
import { sendAuthMail } from "./mail";
import type { AppEnv } from "./env";
import * as schema from "./auth-schema";
import { member } from "./tenancy";

// Reuse configuration and endpoint construction, not session/authorization data.
// Each getSession still reads D1 (cookieCache remains disabled).
const identities = new WeakMap<
  D1Database,
  { settings: string[]; auth: ReturnType<typeof createIdentity> }
>();
export function identity(env: AppEnv) {
  const settings = [
    env.AUTH_SECRET ?? "",
    env.AUTH_BASE_URL ?? "",
    env.BREVO_API_KEY ?? "",
    env.MAIL_FROM ?? "",
  ];
  const prior = identities.get(env.DB);
  if (prior && prior.settings.every((v, i) => v === settings[i])) return prior.auth;
  const auth = createIdentity(env);
  identities.set(env.DB, { settings, auth });
  return auth;
}
function createIdentity(env: AppEnv) {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) throw new Error("AUTH_NOT_CONFIGURED");
  const baseURL = env.AUTH_BASE_URL || "https://tr.zhangheng.eu.org";
  const mailEnv = { BREVO_API_KEY: env.BREVO_API_KEY, MAIL_FROM: env.MAIL_FROM };
  const mail = (to: string, url: string, subject: string) =>
    sendAuthMail(mailEnv, to, url, subject);
  return betterAuth({
    baseURL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [new URL(baseURL).origin],
    database: drizzleAdapter(drizzle(env.DB, { schema }), {
      provider: "sqlite",
      schema,
      transaction: false,
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => mail(user.email, url, "重置 TaskRelay 密码"),
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }) => mail(user.email, url, "验证 TaskRelay 邮箱"),
    },
    session: { expiresIn: 604800, updateAge: 86400, cookieCache: { enabled: false } },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 30,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 3600, max: 5 },
        "/request-password-reset": { window: 3600, max: 5 },
        "/send-verification-email": { window: 3600, max: 5 },
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      useSecureCookies: new URL(baseURL).protocol === "https:",
    },
    logger: { disabled: true },
    // better-call otherwise logs raw database errors (including query parameters).
    // Let the application's fixed public error mapper handle unexpected failures.
    onAPIError: { throw: true },
  });
}
export async function ensureMember(
  env: AppEnv,
  user: { id: string; email: string; emailVerified: boolean },
) {
  if (!user.emailVerified) throw new Error("EMAIL_VERIFICATION_REQUIRED");
  const existing = await env.DB.prepare("SELECT * FROM members WHERE auth_id=?")
    .bind(user.id)
    .first<import("./tenancy").Member>();
  if (existing) {
    if (existing.disabled) throw new Error("USER_DISABLED");
    return existing;
  }
  const email = user.email.toLowerCase();
  const owner = email === env.OWNER_EMAIL.toLowerCase();
  // 新认证身份只创建自己的业务成员；旧数据归属只能由离线转换器显式绑定。
  await env.DB.prepare("INSERT OR IGNORE INTO members(id,auth_id,email,role) VALUES(?,?,?,?)")
    .bind(user.id, user.id, email, owner ? "admin" : "user")
    .run();
  const row = await env.DB.prepare("SELECT id FROM members WHERE auth_id=?")
    .bind(user.id)
    .first<{ id: string }>();
  if (!row) throw new Error("IDENTITY_CONFLICT");
  return member(env.DB, row.id);
}
export async function limitRequest(env: AppEnv, key: string, max: number, windowMs: number) {
  const at = Date.now();
  const r = await env.DB.prepare(
    `INSERT INTO request_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN ? ELSE expires_at END WHERE expires_at<=? OR count<?`,
  )
    .bind(
      key,
      dbTime(at + windowMs),
      dbTime(at),
      dbTime(at),
      dbTime(at + windowMs),
      dbTime(at),
      max,
    )
    .run();
  if (!r.meta.changes) throw new Error("RATE_LIMITED");
}
export async function authHandler(request: Request, env: AppEnv) {
  const path = new URL(request.url).pathname;
  if (request.method === "POST") {
    const ip = request.headers.get("cf-connecting-ip") ?? "local";
    await limitRequest(env, `auth:${ip}`, 30, 60000);
    if (
      [
        "/api/auth/sign-up/email",
        "/api/auth/request-password-reset",
        "/api/auth/send-verification-email",
      ].includes(path)
    ) {
      await limitRequest(env, `mail:${ip}`, 5, 3600000);
      if (path.endsWith("/sign-up/email")) {
        const input = (await request.clone().json()) as { email?: string };
        const bootstrap =
          env.REGISTRATION_OPEN !== "1" &&
          typeof input.email === "string" &&
          input.email.toLowerCase() === env.OWNER_EMAIL.toLowerCase();
        if (env.REGISTRATION_OPEN !== "1" && !bootstrap)
          return Response.json({ error: "REGISTRATION_CLOSED" }, { status: 403 });
      }
      if (!env.TURNSTILE_SECRET || !env.TURNSTILE_SITE_KEY)
        throw new Error("TURNSTILE_NOT_CONFIGURED");
      const token = request.headers.get("x-turnstile-token");
      if (!token || token.length > 2048) throw new Error("TURNSTILE_REQUIRED");
      const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
        signal: AbortSignal.timeout(10000),
      });
      const check = (await res.json()) as { success?: boolean; hostname?: string; action?: string };
      if (
        !check.success ||
        check.hostname !== new URL(env.AUTH_BASE_URL).hostname ||
        check.action !== "auth"
      )
        throw new Error("TURNSTILE_REJECTED");
    }
  }
  return identity(env).handler(request);
}
