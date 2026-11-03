import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { app } from "../apps/cloud/src/index";
import type { AppEnv } from "../apps/cloud/src/env";
import { claim, enqueue } from "../apps/cloud/src/store";
import { seal } from "../apps/cloud/src/crypto";
import { hash } from "../packages/contracts/src/security";
import { testDb, insertTask } from "./helpers";
import { attachTestEgress } from "./egress-helpers";

export async function productionModelFixture(
  t: TestContext,
  protocol: "chat" | "responses" = "chat",
  structured: "schema" | "json" | "none" = "schema",
) {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  const key = Buffer.alloc(32, 9).toString("base64"),
    token = "c".repeat(64);
  const task = await insertTask(db);
  await enqueue(db, task, "model_fixture");
  await db
    .prepare(
      "INSERT INTO devices(id,name,token_hash,protocol_version) VALUES(?,?,?,1)",
    )
    .bind("device_test", "fixture", await hash(token))
    .run();
  const run = (await claim(db, "device_test", "claim_fixture"))!;
  // A newer configuration must never replace the version in the run snapshot.
  for (const version of [1, 2]) {
    await db
      .prepare(
        "INSERT INTO model_profiles(id,version,config,secret,capabilities,created_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        "model_test",
        version,
        JSON.stringify({
          name: "fixture",
          baseUrl: "https://provider.example/v1",
          model: version === 1 ? "vendor/non-gpt" : "do-not-select",
          protocol,
          inputPrice: null,
          outputPrice: null,
        }),
        await seal("fixture-key", key, `model:model_test:${version}`),
        JSON.stringify({
          connection: true,
          tools: true,
          structured,
          vision: false,
          testedAt: null,
        }),
        new Date().toISOString(),
      )
      .run();
  }
  const env = { DB: db, MASTER_KEY: key, DEV_MODE: "1" } as AppEnv;
  attachTestEgress(env);
  let jobs = 0;
  const jurisdiction = env.MODEL_EGRESS.jurisdiction.bind(env.MODEL_EGRESS);
  t.mock.method(env.MODEL_EGRESS, "jurisdiction", (region: "us") => {
    assert.equal(region, "us");
    jobs++;
    return jurisdiction(region);
  });
  const requests: { url: string; body: any }[] = [];
  let replies: (string | Error | Response)[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://cloudflare-dns.com/dns-query"))
        return Response.json({
          Status: 0,
          Answer: [{ type: 1, data: "8.8.8.8" }],
        });
      assert.ok(url.startsWith("https://provider.example/v1/"));
      assert.equal(init?.redirect, "manual");
      requests.push({ url, body: JSON.parse(String(init?.body)) });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      if (reply instanceof Response) return reply;
      assert.equal(typeof reply, "string", "unexpected provider request");
      return Response.json(
        protocol === "chat"
          ? {
              choices: [{ message: { content: reply } }],
              usage: { prompt_tokens: 11, completion_tokens: 7 },
            }
          : {
              output: [
                {
                  type: "message",
                  content: [{ type: "output_text", text: reply }],
                },
              ],
              usage: { input_tokens: 11, output_tokens: 7 },
            },
      );
    },
  );
  return {
    db,
    sql,
    env,
    run,
    requests,
    jobs: () => jobs,
    replies: (...values: (string | Error | Response)[]) => {
      replies = values;
    },
    async request(path: string, body: unknown) {
      const response = await app.request(
        "http://127.0.0.1" + path,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        },
        env,
      );
      return { status: response.status, data: (await response.json()) as any };
    },
  };
}
