import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { testDb, insertTask } from "./helpers";
import { fakeStorage } from "./egress-helpers";
import type { AppEnv } from "../apps/cloud/src/env";
import type { DraftPublication } from "../apps/cloud/src/chat-drafts";

// 只替换平台基类；测试真实 Hub 的存储、授权和事件逻辑。休眠/调度另由 workerd 验收。
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url: "data:text/javascript,export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }",
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { NotificationHub } = await import("../apps/cloud/src/notification-hub");
hook.deregister();

test("草稿 Hub 隔离、去重、加密分块、背压恢复、正式合并与过期清理", async (t) => {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  await insertTask(db);
  await db
    .prepare(
      "INSERT INTO ai_threads(id,user_id,kind,model_id,model_version,created_at,updated_at) VALUES('thread','fixture_owner','chat','model_test',1,?,?)",
    )
    .bind(Date.now(), Date.now())
    .run();
  await db
    .prepare(
      "INSERT INTO auth_user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('auth','test','draft@test.test',1,?,?)",
    )
    .bind(Date.now(), Date.now())
    .run();
  await db.prepare("UPDATE members SET auth_id='auth' WHERE id='fixture_owner'").run();
  await db
    .prepare(
      "INSERT INTO auth_session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES('session',?,'token',?,?,'auth')",
    )
    .bind(Date.now() + 600000, Date.now(), Date.now())
    .run();
  const fake = fakeStorage();
  fake.storage.getAlarm = async () => fake.getAlarm() || null;
  fake.storage.list = (async (options?: { prefix?: string }) =>
    new Map(
      [...fake.values].filter(([key]) => key.startsWith(options?.prefix ?? "")),
    )) as DurableObjectStorage["list"];
  const socket = (protocol: number, device?: string) => {
    let attachment = {
      owner: "fixture_owner",
      session: "session",
      expires: Date.now() + 600000,
      protocol,
      device,
    };
    const sent: string[] = [];
    let closed: number | undefined;
    const ws = {
      serializeAttachment(value: typeof attachment) {
        attachment = value;
      },
      deserializeAttachment() {
        return attachment;
      },
      send(value: string) {
        sent.push(value);
      },
      close(code?: number) {
        closed = code;
      },
    } as unknown as WebSocket;
    return { ws, sent, closed: () => closed };
  };
  const modern = socket(2),
    legacy = socket(1),
    revoked = socket(2, "revoked");
  const hub = new NotificationHub(
    {
      storage: fake.storage,
      getWebSockets: () => [modern.ws, legacy.ws, revoked.ws],
      blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    } as unknown as DurableObjectState,
    { DB: db, MASTER_KEY: Buffer.alloc(32, 9).toString("base64") } as AppEnv,
  );
  const publication: DraftPublication = {
    owner: "fixture_owner",
    target: { threadId: "thread", id: "reply", source: "cloud", mode: "reply" },
    draft: {
      id: "reply",
      threadId: "thread",
      callId: "call",
      version: 0,
      seq: 1,
      content: "私有内容".repeat(20000),
      at: new Date().toISOString(),
      source: "cloud",
      status: "streaming",
    },
  };
  await hub.publishDraft(publication);
  assert.equal(JSON.parse(modern.sent[0]).type, "draft.start");
  assert.equal(legacy.sent.length, 0);
  assert.equal(revoked.closed(), 1008);
  assert.ok([...fake.values.keys()].filter((k) => k.startsWith("body:")).length > 1);
  assert.ok(!JSON.stringify([...fake.values]).includes("私有内容"));
  assert.equal((await hub.drafts("fixture_owner", "thread"))[0].content, publication.draft.content);
  assert.deepEqual(await hub.drafts("other", "thread"), []);
  await hub.publishDraft(publication);
  assert.equal(modern.sent.length, 1);
  publication.draft = { ...publication.draft, content: "更新", seq: 2 };
  await hub.publishDraft(publication);
  assert.equal(modern.sent.length, 1, "未确认时不积压正文帧");
  hub.webSocketMessage(modern.ws, "draft.ack");
  assert.equal(modern.sent.at(-1), "changed");
  assert.equal((await hub.drafts("fixture_owner", "thread"))[0].content, "更新");
  assert.equal([...fake.values.keys()].filter((k) => k.startsWith("body:")).length, 1);
  publication.draft = {
    ...publication.draft,
    version: 1,
    callId: "repair",
    seq: 1,
    content: "修复",
  };
  await hub.publishDraft(publication);
  assert.equal(JSON.parse(modern.sent.at(-1)!).draft.version, 1);
  await hub.publishDraft({ ...publication, draft: { ...publication.draft, version: 0, seq: 99 } });
  assert.equal((await hub.drafts("fixture_owner", "thread"))[0].content, "修复");
  await hub.closeDrafts("thread", "other");
  assert.equal((await hub.drafts("fixture_owner", "thread")).length, 1);
  hub.webSocketMessage(modern.ws, "draft.ack");
  await hub.closeDrafts("thread", undefined, "reply");
  assert.equal(JSON.parse(modern.sent.at(-1)!).reason, "committed");
  assert.deepEqual(await hub.drafts("fixture_owner", "thread"), []);
  await hub.publishDraft(publication);
  await db
    .prepare(
      "INSERT INTO ai_messages(id,thread_id,seq,role,turn_id,at,source_call_id) VALUES('formal','thread',1,'assistant','turn',?,'repair')",
    )
    .bind(Date.now())
    .run();
  assert.deepEqual(await hub.drafts("fixture_owner", "thread"), []);
  await hub.publishDraft(publication);
  assert.deepEqual(await hub.drafts("fixture_owner", "thread"), []);
  publication.draft.callId = "new";
  publication.target.id = publication.draft.id = "next";
  await hub.publishDraft(publication);
  const key = "draft:thread:next";
  const saved = await fake.storage.get<{ expires: number; parts: number }>(key);
  await fake.storage.put(key, { ...saved, expires: Date.now() - 1 });
  await hub.alarm();
  assert.deepEqual(await hub.drafts("fixture_owner", "thread"), []);
  await hub.publishDraft(publication);
  await hub.closeDrafts("thread");
  await hub.publishDraft({ ...publication, draft: { ...publication.draft, seq: 10 } });
  assert.deepEqual(await hub.drafts("fixture_owner", "thread"), []);
  hub.webSocketMessage(modern.ws, "illegal");
  assert.equal(modern.closed(), 1008);
});
