import { Hono } from "hono";
import { z } from "zod";
import { hash, randomToken } from "../../../packages/contracts/src/security";
import type { AppEnv, Variables } from "./env";
import { seal, unseal } from "./crypto";
import { now, uid, type Row } from "./store";
export const pairing = new Hono<{ Bindings: AppEnv; Variables: Variables }>();
pairing.post("/start", async (c) => {
  const { name } = z
    .object({
      name: z.string().trim().min(1).max(100),
      protocolVersion: z.literal(1),
    })
    .strict()
    .parse(await c.req.json());
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) n FROM pairings WHERE expires_at>?",
  )
    .bind(now())
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= 20) return c.json({ error: "PAIRING_LIMIT" }, 429);
  const id = uid("pair"),
    deviceId = uid("device"),
    pollToken = randomToken(),
    token = randomToken(),
    code = randomToken().slice(0, 12).toUpperCase();
  await c.env.DB.prepare(
    "INSERT INTO pairings(id,code,poll_hash,token_secret,device_id,name,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      code,
      await hash(pollToken),
      await seal(token, c.env.MASTER_KEY, `pair:${id}`),
      deviceId,
      name,
      new Date(Date.now() + 600000).toISOString(),
      now(),
    )
    .run();
  return c.json({
    id,
    code,
    pollToken,
    url: `${new URL(c.req.url).origin}/?pair=${code}`,
  });
});
pairing.post("/poll", async (c) => {
  const { id, pollToken } = z
    .object({ id: z.string().max(100), pollToken: z.string().length(64) })
    .parse(await c.req.json());
  const row = await c.env.DB.prepare(
    "SELECT * FROM pairings WHERE id=? AND poll_hash=? AND expires_at>?",
  )
    .bind(id, await hash(pollToken), now())
    .first<Row>();
  if (!row) return c.json({ error: "PAIRING_EXPIRED" }, 410);
  if (!row.approved) return c.json({ approved: false });
  // Retain until expiry so a lost response can be retried by this device only.
  return c.json({
    approved: true,
    deviceId: row.device_id,
    token: await unseal<string>(
      row.token_secret,
      c.env.MASTER_KEY,
      `pair:${id}`,
    ),
  });
});
