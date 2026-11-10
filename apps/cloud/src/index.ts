import { dbTime } from "./database";
/** 应用路由与维护入口：统一请求大小、来源、身份和错误响应；定时清理委托给队列与聊天生命周期模块。 */
import { drainHistoryCleanups } from "./history-cleanup";
import { applicationDb, requireStorageVersion } from "./database";
import { deleteEvidence } from "./evidence";
import { notifyUser, notifyDevices } from "./notifications";
import { retainHistory } from "./ai/lifecycle";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z, ZodError } from "zod";
import { auth } from "./auth";
import { pairing } from "./pairing";
import { browserApi } from "./browser-api";
import { authHandler } from "./identity";
import { PROTOCOL_VERSION } from "../../../packages/contracts/src/index";
import { quotaReset } from "./tenancy";
import { runner } from "./runner";
import { tick, now, type Row } from "./store";
import { advanceDispatchGroups } from "./account-dispatch";
import { cleanupAccountCards } from "./account-cards";
import type { AppEnv, Variables } from "./env";
const app = new Hono<{ Bindings: AppEnv; Variables: Variables }>();
app.use("/api/*", async (c, next) => {
  if (c.req.path !== "/api/health") c.env = { ...c.env, DB: applicationDb(c.env.DB) };
  await next();
});
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();
  await requireStorageVersion(c.env.DB);
  const frozen = await c.env.DB.prepare(
    "SELECT value FROM settings WHERE key='storageFrozen'",
  ).first<{ value: string }>();
  // 冻结保留管理员重新登录所需的会话入口，避免旧会话过期后无法完成对象核验；业务写入仍关闭。
  const controlPaths = [
    "/api/device/upgrade",
    "/api/device/status",
    "/api/device/readiness",
    "/api/auth/config",
    "/api/auth/sign-in/email",
    "/api/auth/get-session",
    "/api/auth/sign-out",
  ];
  if (
    frozen?.value === "1" &&
    !c.req.path.startsWith("/api/admin/storage/") &&
    !controlPaths.includes(c.req.path)
  )
    return c.json({ error: "STORAGE_FROZEN" }, 503);
  await next();
});
app.use(
  "/api/*",
  bodyLimit({
    maxSize: 2_100_000,
    onError: (c) => c.json({ error: "BODY_TOO_LARGE" }, 413),
  }),
);
app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  if (
    !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
    !c.req.path.startsWith("/api/runner/") &&
    !c.req.path.startsWith("/api/device/")
  ) {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin)
      return c.json({ error: "ORIGIN_MISMATCH" }, 403);
  }
  await next();
});
app.use("/api/*", auth);
app.use("/api/*", async (c, next) => {
  await next();
  if (c.req.method === "GET" || c.res.status >= 400) return;
  if (c.get("userId")) await notifyUser(c.env, c.get("userId"));
  if (
    c.req.path.startsWith("/api/user/tasks") ||
    c.req.path.startsWith("/api/admin/") ||
    /^\/api\/user\/(runs\/[^/]+\/cancel|threads\/[^/]+\/messages)$/.test(c.req.path)
  )
    await notifyDevices(c.env);
  if (c.get("deviceId") && c.env.NOTIFICATIONS) {
    const run = /^\/api\/runner\/runs\/([^/]+)/.exec(c.req.path);
    if (run && /\/(finish|account-card|account-status|browser-closed)$/.test(c.req.path)) {
      const owner = await c.env.DB.prepare("SELECT user_id FROM runs WHERE id=?")
        .bind(run[1])
        .first<{ user_id: string }>();
      if (owner) await notifyUser(c.env, owner.user_id);
    }
  }
});
app.use("/api/*", async (c, next) => {
  if (
    c.req.method !== "GET" &&
    !c.req.path.startsWith("/api/runner/") &&
    !c.req.path.startsWith("/api/device/") &&
    !c.req.path.startsWith("/api/admin/")
  ) {
    if (
      (
        await c.env.DB.prepare("SELECT value FROM settings WHERE key='maintenance'").first<{
          value: string;
        }>()
      )?.value === "1"
    )
      return c.json({ error: "MAINTENANCE" }, 503);
  }
  await next();
});
app.get("/api/health", (c) => c.json({ service: "TaskRelay", protocolVersion: PROTOCOL_VERSION }));
app.route("/api/pair", pairing);
app.get("/api/user/events", async (c) => {
  if (
    c.req.header("upgrade")?.toLowerCase() !== "websocket" ||
    c.req.header("origin") !== new URL(c.req.url).origin
  )
    return c.json({ error: "ORIGIN_MISMATCH" }, 403);
  return c.env.NOTIFICATIONS.getByName("user:" + c.get("userId")).fetch(
    new Request("https://notification.internal/", {
      headers: {
        Upgrade: "websocket",
        "x-subscriber": JSON.stringify({
          owner: c.get("userId"),
          session: c.get("sessionId"),
          protocol: c.req.query("protocol") === "2" ? 2 : 1,
          expires: Date.now() + 3600000,
        }),
      },
    }),
  );
});
app.get("/api/device/events", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
    return c.json({ error: "WEBSOCKET_REQUIRED" }, 400);
  return c.env.NOTIFICATIONS.getByName("device:" + c.get("deviceId")).fetch(
    new Request("https://notification.internal/", {
      headers: {
        Upgrade: "websocket",
        "x-subscriber": JSON.stringify({
          device: c.get("deviceId"),
          expires: Date.now() + 3600000,
        }),
      },
    }),
  );
});
app.route("/", browserApi);
app.get("/api/auth/config", (c) =>
  c.json({
    registrationOpen: c.env.REGISTRATION_OPEN === "1",
    siteKey: c.env.TURNSTILE_SITE_KEY || "",
  }),
);
app.all("/api/auth/*", (c) => authHandler(c.req.raw, c.env));
app.post("/api/device/upgrade", async (c) => {
  z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), localReady: z.literal(true) })
    .strict()
    .parse(await c.req.json());
  // 常规发布不等待设备在线：空闲设备可在发布后自行登记当前协议，不能依赖已结束的维护窗口。
  // 存储冻结仍要求维护且暂停领取；在同一条件写入内检查本设备清理，升级后重新报告领取就绪。
  const result = await c.env.DB.prepare(
    `UPDATE devices SET claim_ready=CASE WHEN protocol_version<>${PROTOCOL_VERSION} THEN 0 ELSE claim_ready END,
      protocol_version=${PROTOCOL_VERSION} WHERE id=? AND revoked=0 AND protocol_version<=${PROTOCOL_VERSION}
      AND (NOT EXISTS(SELECT 1 FROM settings WHERE key='storageFrozen' AND value='1')
        OR (EXISTS(SELECT 1 FROM settings WHERE key='maintenance' AND value='1')
          AND EXISTS(SELECT 1 FROM settings WHERE key='claimsEnabled' AND value='0')))
      AND NOT EXISTS(SELECT 1 FROM runs WHERE device_id=? AND (status IN ('running','waiting_user','verifying') OR cleanup_pending=1))`,
  )
    .bind(c.get("deviceId"), c.get("deviceId"))
    .run();
  if (!result.meta.changes) throw new Error("CUTOVER_NOT_READY");
  return c.json({ protocolVersion: PROTOCOL_VERSION });
});
app.get("/api/device/status", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT key,value FROM settings WHERE key IN ('maintenance')",
  ).all<{ key: string; value: string }>();
  const s = Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
  return c.json({
    deviceId: c.get("deviceId"),
    protocolVersion: PROTOCOL_VERSION,
    maintenance: s.maintenance === "1",
  });
});
app.post("/api/device/readiness", async (c) => {
  const b = z.object({ ready: z.boolean() }).parse(await c.req.json());
  // 就绪值不变时沿用鉴权入口已合并的心跳；暂停/恢复立即写入，避免每次轮询更新相同设备行。
  await c.env.DB.prepare(
    "UPDATE devices SET claim_ready=?,last_seen=? WHERE id=? AND revoked=0 AND (claim_ready<>? OR last_seen IS NULL OR last_seen<?)",
  )
    .bind(b.ready ? 1 : 0, dbTime(now()), c.get("deviceId"), b.ready ? 1 : 0, Date.now() - 60_000)
    .run();
  return c.json({ ok: true });
});
app.route("/api/runner", runner);
app.notFound((c) => c.json({ error: "NOT_FOUND" }, 404));
app.onError((error, c) => {
  const code =
    error instanceof ZodError
      ? "INVALID_INPUT"
      : /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : (/(?:MODEL_DISABLED|ACCOUNT_DISABLED|MEMORY_LIMIT|QUEUE_LIMIT|CLAIM_BUSY|RUN_QUOTA_EXCEEDED|SCHEDULE_QUOTA_EXCEEDED|USER_DISABLED|ACCOUNT_DEVICE_MISMATCH)/.exec(
            error.message,
          )?.[0] ?? "INTERNAL_ERROR");
  return c.json(
    {
      error: code,
      ...(code.includes("QUOTA") || code === "QUEUE_LIMIT" ? { resetAt: quotaReset() } : {}),
    },
    code.includes("QUOTA") || code === "QUEUE_LIMIT" || code === "RATE_LIMITED"
      ? 429
      : code === "USER_DISABLED"
        ? 403
        : code === "INTERNAL_ERROR"
          ? 500
          : code.includes("NOT_FOUND")
            ? 404
            : code.includes("EXPIRED") || code.includes("STALE") || code.includes("CONFLICT")
              ? 409
              : 400,
  );
});
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: AppEnv, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await maintenance(env);
      })(),
    );
  },
};
export { app };

export async function maintenance(env: AppEnv) {
  if (
    (
      await env.DB.prepare("SELECT value FROM settings WHERE key='storageFrozen'").first<{
        value: string;
      }>()
    )?.value === "1"
  )
    return;
  await drainHistoryCleanups(env);
  await tick(env.DB);
  await cleanupAccountCards(env);
  await advanceDispatchGroups(env.DB);
  const expired = await env.DB.prepare(
    "SELECT * FROM artifacts WHERE expires_at<=? OR (purpose='vision' AND run_id IN (SELECT id FROM runs WHERE status IN ('succeeded','failed','cancelled','expired','unknown'))) LIMIT 100",
  )
    .bind(dbTime(now()))
    .all<Row>();
  for (const row of expired.results) {
    await deleteEvidence(env, row.object_key);
    await env.DB.prepare("DELETE FROM artifacts WHERE id=?").bind(row.id).run();
  }
  const days = Number(
    (
      await env.DB.prepare("SELECT value FROM settings WHERE key='retentionDays'").first<{
        value: string;
      }>()
    )?.value ?? 30,
  );
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  await retainHistory(env, cutoff);
}
