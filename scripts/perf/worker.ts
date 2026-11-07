// Local-only profiling entry. Never imported by the production Worker.
import { app } from "../../apps/cloud/src/index";
import { identity } from "../../apps/cloud/src/identity";
import { seal, unseal } from "../../apps/cloud/src/crypto";
import { RelayChatModel } from "../../apps/cloud/src/ai/model";
import { D1Checkpointer } from "../../apps/cloud/src/ai/checkpointer";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { attachTestEgress } from "../../tests/egress-helpers";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import type { AppEnv } from "../../apps/cloud/src/env";
import { AiTurn as ProductionAiTurn } from "../../apps/cloud/src/ai/turn";
import { applicationDb } from "../../apps/cloud/src/database";

const reply = {
  reply: "请描述任务目标",
  start: false,
  title: null,
  goal: null,
  entryUrl: null,
  accountId: null,
  executionOutline: [],
};
// No network is allowed, including accidental requests to a real provider.
globalThis.fetch = async (input) => {
  const url = input instanceof Request ? input.url : input.toString();
  if (url.startsWith("https://cloudflare-dns.com/dns-query"))
    return Response.json({ Status: 0, Answer: [{ type: 1, data: "8.8.8.8" }] });
  if (url === "https://provider.example/v1/chat/completions")
    return Response.json({
      choices: [{ message: { content: JSON.stringify(reply) } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    });
  throw new Error("PROFILE_NETWORK_FORBIDDEN");
};
const schema = z.object({ reply: z.string() });
const value = { text: "中文 checkpoint ".repeat(700) };
function profileEnv(bindings: AppEnv) {
  const env = {
    ...bindings,
    DB: applicationDb(bindings.DB),
    DEV_MODE: "0",
    AUTH_SECRET: "isolated-profiling-secret-at-least-32-characters",
    AUTH_BASE_URL: "http://localhost",
    OWNER_EMAIL: "profile@example.com",
    MASTER_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
    requestUserId: "profiler",
  } as AppEnv;
  attachTestEgress(env);
  return env;
}
// 使用真实异步 alarm，仅出站适配器提供合成模型回答。
export class AiTurn extends ProductionAiTurn {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, profileEnv(env));
  }
}
export default {
  async fetch(request: Request, bindings: AppEnv) {
    if (!["127.0.0.1", "localhost"].includes(new URL(request.url).hostname))
      return new Response("LOCAL_ONLY", { status: 403 });
    const env = profileEnv(bindings);
    const path = new URL(request.url).pathname;
    if (path === "/init") {
      const at = Date.now(),
        password = "isolated-profiling-password";
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO auth_user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)",
        ).bind("profiler", "Profiler", "profile@example.com", at, at),
        env.DB.prepare(
          "INSERT INTO auth_account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,'credential',?,?,?,?)",
        ).bind("profiler", "profiler", "profiler", await hashPassword(password), at, at),
        env.DB.prepare(
          "INSERT INTO members(id,auth_id,email,role) VALUES('profiler','profiler','profile@example.com','admin')",
        ),
        env.DB.prepare("UPDATE members SET daily_models=10000,daily_chat=10000"),
        env.DB.prepare(
          "INSERT INTO model_profile_versions(id,version,config,secret,capabilities,created_at) VALUES(?,?,?,?,?,?)",
        ).bind(
          "model_test",
          1,
          JSON.stringify({
            name: "fixture",
            baseUrl: "https://provider.example/v1",
            model: "fixture",
            protocol: "chat",
            inputPrice: null,
            outputPrice: null,
          }),
          await seal("fixture-only", env.MASTER_KEY, "model:model_test:1"),
          JSON.stringify({
            connection: true,
            tools: true,
            structured: "schema",
            vision: false,
            testedAt: null,
          }),
          Date.now(),
        ),
      ]);
      return identity(env).handler(
        new Request("http://localhost/api/auth/sign-in/email", {
          method: "POST",
          headers: { Origin: "http://localhost", "Content-Type": "application/json" },
          body: JSON.stringify({ email: "profile@example.com", password }),
        }),
      );
    }
    if (path === "/bench/crypto") {
      for (let i = 0; i < 10; i++)
        await unseal(await seal(value, env.MASTER_KEY, "profile"), env.MASTER_KEY, "profile");
      return Response.json({ ok: true, operations: 10 });
    }
    if (path === "/bench/checkpoint") {
      const saver = new D1Checkpointer(env.DB, "profiler", env.MASTER_KEY);
      for (let i = 0; i < 10; i++) {
        const c = { configurable: { thread_id: crypto.randomUUID() } },
          cp = emptyCheckpoint();
        cp.channel_values = { output: value };
        await saver.getTuple(await saver.put(c, cp, { source: "input", step: 0, parents: {} }));
      }
      return Response.json({ ok: true, operations: 10 });
    }
    if (path === "/bench/model")
      return Response.json(
        await new RelayChatModel(env, "model_test", 1, crypto.randomUUID())
          .withStructuredOutput(schema)
          .invoke("只读查询"),
      );
    return app.fetch(request, env);
  },
};
