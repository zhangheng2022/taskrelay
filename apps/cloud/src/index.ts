import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import { auth } from "./auth";
import { pairing } from "./pairing";
import { user } from "./user";
import { runner } from "./runner";
import { tick, now, type Row } from "./store";
import type { AppEnv, Variables } from "./env";
const app = new Hono<{ Bindings: AppEnv; Variables: Variables }>();
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
app.get("/api/health", (c) =>
  c.json({ service: "TaskRelay", protocolVersion: 1 }),
);
app.route("/api/pair", pairing);
app.route("/api/user", user);
app.route("/api/device/user", user);
app.route("/api/runner", runner);
app.notFound((c) => c.json({ error: "NOT_FOUND" }, 404));
app.onError((error, c) => {
  const code =
    error instanceof ZodError
      ? "INVALID_INPUT"
      : /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "INTERNAL_ERROR";
  return c.json(
    { error: code },
    code === "INTERNAL_ERROR"
      ? 500
      : code.includes("NOT_FOUND")
        ? 404
        : code.includes("EXPIRED") ||
            code.includes("STALE") ||
            code.includes("CONFLICT")
          ? 409
          : 400,
  );
});
export default {
  fetch: app.fetch,
  async scheduled(
    _event: ScheduledController,
    env: AppEnv,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(
      (async () => {
        await tick(env.DB);
        const expired = await env.DB.prepare(
          "SELECT * FROM artifacts WHERE expires_at<=? LIMIT 100",
        )
          .bind(now())
          .all<Row>();
        for (const row of expired.results) {
          await env.EVIDENCE.delete(row.object_key);
          await env.DB.prepare("DELETE FROM artifacts WHERE id=?")
            .bind(row.id)
            .run();
        }
        const days = Number(
          (
            await env.DB.prepare(
              "SELECT value FROM settings WHERE key='retentionDays'",
            ).first<{ value: string }>()
          )?.value ?? 30,
        );
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();
        await env.DB.batch([
          env.DB.prepare(
            "DELETE FROM run_events WHERE at<? AND run_id IN (SELECT id FROM runs WHERE status IN ('succeeded','failed','cancelled','expired'))",
          ).bind(cutoff),
          env.DB.prepare("DELETE FROM conversations WHERE at<?").bind(cutoff),
        ]);
      })(),
    );
  },
};
export { app };
