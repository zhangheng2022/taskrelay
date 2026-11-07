import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { HumanMessage } from "@langchain/core/messages";
import { D1Checkpointer } from "../apps/cloud/src/ai/checkpointer";
import { seal, unseal } from "../apps/cloud/src/crypto";
import { identity } from "../apps/cloud/src/identity";
import { getModel, getModelProfile } from "../apps/cloud/src/models";
import { productionModelFixture } from "./production-model-fixture";
import { testDb } from "./helpers";
import type { AppEnv } from "../apps/cloud/src/env";

test("紧凑检查点保持 typed 消息，拒绝旧数字数组格式；AAD 隔离 owner", async (t) => {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  const key = Buffer.alloc(32, 4).toString("base64"),
    saver = new D1Checkpointer(db, "owner", key);
  const cp = emptyCheckpoint();
  cp.channel_values = {
    messages: [new HumanMessage("中文 😀 0012 aB")],
    output: "长内容".repeat(2000),
  };
  const config = { configurable: { thread_id: "compact" } };
  const stored = await saver.put(config, cp, { source: "input", step: 0, parents: {} });
  const row = sql.prepare("SELECT checkpoint,metadata FROM ai_checkpoints").get()!;
  const packed = await unseal<{ type: string; bytes: string; encoding: string }>(
    String(row.checkpoint),
    key,
    "ai-checkpoint:owner",
  );
  assert.equal(packed.encoding, "base64");
  const messages = (await saver.getTuple(stored))!.checkpoint.channel_values
    .messages as HumanMessage[];
  assert.equal(messages[0].type, "human");
  assert.equal(messages[0].content, "中文 😀 0012 aB");
  const legacy = { type: packed.type, bytes: Array.from(Buffer.from(packed.bytes, "base64")) };
  assert.ok(JSON.stringify(packed).length < JSON.stringify(legacy).length);
  sql
    .prepare("UPDATE ai_checkpoints SET checkpoint=?")
    .run(await seal(legacy, key, "ai-checkpoint:owner"));
  await assert.rejects(saver.getTuple(stored), /UNKNOWN_CHECKPOINT_ENCODING/);
  await assert.rejects(unseal(String(row.checkpoint), key, "ai-checkpoint:other"));
  await assert.rejects(
    unseal(String(row.checkpoint), Buffer.alloc(32, 5).toString("base64"), "ai-checkpoint:owner"),
  );
});

test("认证实例仅复用静态配置，数据库和认证/邮件配置变化隔离", (t) => {
  const a = testDb(),
    b = testDb();
  t.after(() => {
    a.sql.close();
    b.sql.close();
  });
  const env = {
    DB: a.db,
    AUTH_SECRET: "fixture-identity-cache-secret-32-characters",
    AUTH_BASE_URL: "http://localhost",
    MAIL_FROM: "test@example.com",
  } as AppEnv;
  const one = identity(env);
  assert.equal(one, identity({ ...env, requestUserId: "another-user" }));
  assert.notEqual(one, identity({ ...env, DB: b.db }));
  assert.notEqual(
    one,
    identity({ ...env, AUTH_SECRET: "fixture-new-auth-secret-at-least-32-characters" }),
  );
  assert.notEqual(identity(env), identity({ ...env, MAIL_FROM: "changed@example.com" }));
});

test("读取模型能力不解密凭据，只有实际提供方路径读取密钥", async (t) => {
  const s = await productionModelFixture(t);
  s.sql
    .prepare(
      "UPDATE model_profile_versions SET secret='corrupt' WHERE id='model_test' AND version=1",
    )
    .run();
  const { profile } = await getModelProfile(s.env, "model_test", 1);
  assert.equal(profile.version, 1);
  assert.equal(profile.capabilities.connection, true);
  await assert.rejects(getModel(s.env, "model_test", 1));
});
