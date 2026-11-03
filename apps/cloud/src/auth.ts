import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Variables } from "./env";
import { hash } from "../../../packages/contracts/src/security";
import { now } from "./store";

export const auth: MiddlewareHandler<{
  Bindings: AppEnv;
  Variables: Variables;
}> = async (c, next) => {
  const path = c.req.path;
  if (path === "/api/health" || path.startsWith("/api/pair/")) return next();
  if (path.startsWith("/api/runner/") || path.startsWith("/api/device/")) {
    const token = c.req
      .header("authorization")
      ?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!token) return c.json({ error: "DEVICE_UNAUTHORIZED" }, 401);
    const d = await c.env.DB.prepare(
      "SELECT id FROM devices WHERE token_hash=? AND revoked=0 AND protocol_version=1",
    )
      .bind(await hash(token))
      .first<{ id: string }>();
    if (!d) return c.json({ error: "DEVICE_UNAUTHORIZED" }, 401);
    c.set("deviceId", d.id);
    c.set("actor", "device");
    await c.env.DB.prepare("UPDATE devices SET last_seen=? WHERE id=?")
      .bind(now(), d.id)
      .run();
    return next();
  }
  const url = new URL(c.req.url);
  if (
    c.env.DEV_MODE === "1" &&
    ["127.0.0.1", "localhost"].includes(url.hostname)
  ) {
    c.set("actor", "owner");
    return next();
  }
  try {
    const token = c.req.header("cf-access-jwt-assertion");
    if (!token || !c.env.ACCESS_AUD || c.env.ACCESS_AUD === "unconfigured")
      throw new Error("ACCESS_REQUIRED");
    const issuer = `https://${c.env.ACCESS_TEAM_DOMAIN}`;
    const { payload } = await jwtVerify(
      token,
      createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
      { issuer, audience: c.env.ACCESS_AUD },
    );
    if (
      typeof payload.email !== "string" ||
      payload.email.toLowerCase() !== c.env.OWNER_EMAIL.toLowerCase()
    )
      throw new Error("OWNER_REQUIRED");
    c.set("actor", "owner");
    return next();
  } catch {
    return c.json({ error: "ACCESS_REQUIRED" }, 401);
  }
};
