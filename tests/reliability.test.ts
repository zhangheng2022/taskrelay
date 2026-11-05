import test from "node:test";
import assert from "node:assert/strict";
import { testDb, task, insertTask } from "./helpers";
import {
  claim,
  enqueue,
  getRun,
  requireLease,
  tick,
  finish,
} from "../apps/cloud/src/store";
import { nextOccurrence, latestDue } from "../packages/contracts/src/schedule";
import {
  publicUrl,
  isPublicIp,
  publicEndpoint,
} from "../packages/contracts/src/security";
import { seal, unseal } from "../apps/cloud/src/crypto";
test("同账号的并发领取仅一个成功，重复领取幂等", async () => {
  const { db } = testDb();
  const t = await insertTask(db);
  await enqueue(db, t, "one");
  await enqueue(db, t, "two");
  const [a, b] = await Promise.all([
    claim(db, "device_a", "req_a"),
    claim(db, "device_b", "req_b"),
  ]);
  assert.equal([a, b].filter(Boolean).length, 1);
  const winner = a ?? b!;
  assert.equal(
    (await claim(db, winner.deviceId!, a ? "req_a" : "req_b"))?.id,
    winner.id,
  );
  assert.equal(await claim(db, winner.deviceId!, "different"), null);
});
test("提交后失去租约进入 unknown，账号保持锁定且旧消息拒绝", async () => {
  const { db } = testDb();
  const t = await insertTask(db);
  await enqueue(db, t, "one");
  const r = (await claim(db, "device_a", "req_a"))!;
  await db
    .prepare("UPDATE runs SET write_pending=1,lease_expires_at=? WHERE id=?")
    .bind("2020-01-01T00:00:00.000Z", r.id)
    .run();
  await tick(db);
  assert.equal((await getRun(db, r.id)).status, "unknown");
  await assert.rejects(
    () => requireLease(db, r.id, "device_a", r.leaseEpoch),
    /LEASE_EXPIRED/,
  );
  await enqueue(db, t, "two");
  assert.equal(await claim(db, "device_b", "req_b"), null);
});
test("无写意图的租约过期安全失败并释放账号", async () => {
  const { db } = testDb();
  const t = await insertTask(db);
  await enqueue(db, t, "one");
  const r = (await claim(db, "device_a", "req_a"))!;
  await db
    .prepare("UPDATE runs SET lease_expires_at=? WHERE id=?")
    .bind("2020-01-01T00:00:00.000Z", r.id)
    .run();
  await tick(db);
  assert.equal((await getRun(db, r.id)).status, "failed");
  await enqueue(db, t, "two");
  assert.ok(await claim(db, "device_b", "req_b"));
});
test("调度只补最近一次，重复 tick 不重复排队", async () => {
  const { db } = testDb();
  const t = await insertTask(
    db,
    task({
      schedule: {
        kind: "cron",
        expression: "* * * * *",
        timezone: "Asia/Shanghai",
      },
      nextRunAt: "2020-01-01T00:00:00.000Z",
    }),
  );
  await tick(db);
  await tick(db);
  const rows = await db.prepare("SELECT * FROM runs").all();
  assert.equal(rows.results.length, 1);
  assert.ok(
    Date.now() - new Date((rows.results[0] as any).scheduled_for).getTime() <
      61000,
  );
});
test('实际 tick 不补跑一小时前的一次性任务',async()=>{
  const {db,sql}=testDb();
  try{
    const at=new Date(Date.now()-7200000).toISOString();
    await insertTask(db,task({schedule:{kind:'once',at},nextRunAt:at}));
    await tick(db);
    assert.equal(sql.prepare('SELECT COUNT(*) n FROM runs').get()!.n,0);
  }finally{sql.close();}
});
test("手动运行允许暂停任务，不能据此自动启用", async () => {
  const { db } = testDb();
  const t = await insertTask(db, task({ status: "paused" }));
  await enqueue(db, t, "manual:test:request");
  const r = await claim(db, "device_a", "req_a");
  assert.ok(r);
  await finish(db, r, "succeeded", {
    summary: "ok",
    outcome: "read_result",
    evidence: [],
  });
  assert.equal(
    (await db.prepare("SELECT status FROM tasks").first<{ status: string }>())
      ?.status,
    "paused",
  );
});
test("HTTPS 地址及 DNS 解析拒绝私网、凭据、非标准端口和混合解析", async () => {
  for (const u of [
    "http://example.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "https://u:p@example.com",
    "https://example.com:8443",
  ])
    assert.throws(() => publicUrl(u));
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "::ffff:127.0.0.1",
    "fc00::1",
  ])
    assert.equal(isPublicIp(ip), false);
  await assert.rejects(() =>
    publicEndpoint("https://example.com", async () => ["8.8.8.8", "10.0.0.1"]),
  );
});
test("加密绑定对象和版本，错误 AAD 不能解密", async () => {
  const key = Buffer.alloc(32, 8).toString("base64");
  const cipher = await seal({ code: "001234" }, key, "challenge:a:1");
  assert.ok(!cipher.includes("001234"));
  assert.deepEqual(await unseal(cipher, key, "challenge:a:1"), {
    code: "001234",
  });
  await assert.rejects(() => unseal(cipher, key, "challenge:a:2"));
});
test("时区调度不使用系统本地时区", () => {
  const s = {
    kind: "cron" as const,
    expression: "0 9 * * *",
    timezone: "Asia/Shanghai",
  };
  assert.equal(
    nextOccurrence(s, new Date("2026-11-03T00:00:00Z")),
    "2026-11-03T01:00:00.000Z",
  );
  assert.equal(
    latestDue(s, new Date("2026-11-03T02:00:00Z")),
    "2026-11-03T01:00:00.000Z",
  );
});
test("只读核查失败归还原账号锁，成功后才释放", async () => {
  const { db } = testDb();
  const t = await insertTask(db);
  await enqueue(db, t, "first");
  const original = (await claim(db, "device_a", "c1"))!;
  await db
    .prepare("UPDATE runs SET status='unknown',write_pending=1 WHERE id=?")
    .bind(original.id)
    .run();
  const inspection = await enqueue(
    db,
    { ...t, allowedActions: ["read", "navigate"] },
    "reconcile:first",
  );
  await db
    .prepare("UPDATE runs SET reconciliation_of=? WHERE id=?")
    .bind(original.id, inspection.id)
    .run();
  const claimed = (await claim(db, "device_b", "c2"))!;
  assert.equal(claimed.id, inspection.id);
  await finish(db, claimed, "failed", {
    summary: "尚未确认",
    outcome: "unconfirmed",
    evidence: [],
  });
  assert.equal(
    (await db.prepare("SELECT run_id FROM account_locks").first<any>()).run_id,
    original.id,
  );
  const second = await enqueue(
    db,
    { ...t, allowedActions: ["read", "navigate"] },
    "reconcile:second",
  );
  await db
    .prepare("UPDATE runs SET reconciliation_of=? WHERE id=?")
    .bind(original.id, second.id)
    .run();
  const active = (await claim(db, "device_b", "c3"))!;
  await finish(db, active, "succeeded", {
    summary: "已确认",
    outcome: "already_done",
    evidence: [
      { url: t.entryUrl, quote: "成功", capturedAt: new Date().toISOString() },
    ],
  });
  assert.equal((await getRun(db, original.id)).status, "succeeded");
  assert.equal(await db.prepare("SELECT * FROM account_locks").first(), null);
});
