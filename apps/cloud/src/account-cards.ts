/**
 * 登录成功后的账号保存与失效后的修改卡片。草稿加密，聊天只含引用；用户确认在同一事务内
 * 比较账号版本、原聊天和执行代次。卡片不能恢复已结束的执行，也不能把旧目录归给新一轮任务。
 */
import { validator } from "hono/validator";
import { z } from "zod";
import { Buffer } from "node:buffer";
import { Hono } from "hono";
import { idSchema, type TaskRun } from "../../../packages/contracts/src/index";
import { hash, publicUrl } from "../../../packages/contracts/src/security";
import type { AppEnv, Variables } from "./env";
import { seal, unseal } from "./crypto";
import { getRun, now, requireLease, uid, type Row } from "./store";
import { messageStatement, runThread } from "./chat-messages";
import {
  accountInputSchema,
  accountDomains,
  accountAllowsOrigin,
  accountMatchesDomain,
  normalizeAccount,
  ownAccount,
  type AccountInput,
  type AccountSecret,
} from "./accounts";
import { linkAccountSnapshot } from "./browser-state";

type Router = Hono<{ Bindings: AppEnv; Variables: Variables }>;
type Draft = ReturnType<typeof normalizeAccount> & {
  verified: boolean;
  evidence: string;
  observedOrigin: string;
  observedOrigins: string[];
  waitForUpdate: boolean;
};
const offerSchema = z.discriminatedUnion("kind", [
  accountInputSchema.extend({
    kind: z.literal("save"),
    requestId: idSchema,
    verified: z.literal(true),
    evidence: z.string().min(1).max(2000),
    observedOrigin: z.url(),
    observedOrigins: z.array(z.url()).max(100).optional(),
  }),
  z
    .object({
      kind: z.literal("update"),
      requestId: idSchema,
      accountId: idSchema,
      origin: z.url(),
      evidence: z.string().min(1).max(2000),
    })
    .strict(),
]);

async function cardDigest(env: AppEnv, value: unknown) {
  // 幂等摘要包含密码，不能留下可离线枚举弱密码的普通 SHA-256；与密文使用同一密钥体系并区分用途。
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(env.MASTER_KEY, "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Buffer.from(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`account-card\0${JSON.stringify(value)}`),
    ),
  ).toString("hex");
}

// 名称、说明和域名排列不是账号身份。摘要仍使用 HMAC，不能用公开哈希暴露可枚举的密码。
async function identityDigest(
  env: AppEnv,
  draft: Draft,
  version: number | null | undefined,
  epoch: number | null | undefined,
) {
  return cardDigest(env, {
    origin: draft.origin,
    username: draft.username,
    password: draft.password,
    businessDomains: [...draft.businessDomains].sort(),
    loginOrigins: [...draft.loginOrigins].sort(),
    waitForUpdate: draft.waitForUpdate,
    credentialVersion: version ?? 1,
    stateEpoch: epoch ?? 1,
  });
}

function retireDuplicate(env: AppEnv, row: Row, canonical: string) {
  return [
    env.DB.prepare(
      "UPDATE account_cards SET status='expired',secret=NULL,superseded_by=? WHERE id=? AND status='pending' AND identity_digest IS NULL",
    ).bind(canonical, row.id),
    env.DB.prepare(
      "UPDATE ai_messages SET content='',parts='[]' WHERE id=? AND thread_id=? AND EXISTS(SELECT 1 FROM account_cards WHERE id=? AND superseded_by=?)",
    ).bind(`account-card_${row.id}`, row.thread_id, row.id, canonical),
  ];
}

/** 升级前的草稿没有身份摘要；按稳定顺序保留一张，退休重复引用但保留消息游标，避免历史合并复活卡片。 */
async function reconcileLegacyCards(env: AppEnv, runId: string, epoch: number) {
  const rows = await env.DB.prepare(
    "SELECT * FROM account_cards WHERE run_id=? AND lease_epoch=? AND status='pending' AND identity_digest IS NULL AND secret IS NOT NULL AND expires_at>? ORDER BY created_at,id",
  )
    .bind(runId, epoch, now())
    .all<Row>();
  const groups = new Map<string, Row[]>();
  for (const row of rows.results) {
    const digest = await identityDigest(
      env,
      await unseal<Draft>(row.secret, env.MASTER_KEY, `account-card:${row.id}`),
      row.credential_version,
      row.state_epoch,
    );
    const group = groups.get(digest) ?? [];
    group.push(row);
    groups.set(digest, group);
  }
  for (const [digest, group] of groups) {
    const existing = await env.DB.prepare(
      "SELECT id FROM account_cards WHERE run_id=? AND lease_epoch=? AND identity_digest=? AND status IN ('pending','saved')",
    )
      .bind(runId, epoch, digest)
      .first<{ id: string }>();
    const canonical = existing?.id ?? group[0].id;
    await env.DB.batch([
      ...group
        .filter((row) => row.id !== canonical)
        .flatMap((row) => retireDuplicate(env, row, canonical)),
      env.DB.prepare(
        "UPDATE OR IGNORE account_cards SET identity_digest=? WHERE id=? AND identity_digest IS NULL AND status IN ('pending','saved')",
      ).bind(digest, canonical),
    ]);
    // 新版本生成可能抢先取得唯一身份；旧入口也必须退休，不能把一次 OR IGNORE 当作归并成功。
    const winner = await env.DB.prepare(
      "SELECT id FROM account_cards WHERE run_id=? AND lease_epoch=? AND identity_digest=? AND status IN ('pending','saved')",
    )
      .bind(runId, epoch, digest)
      .first<{ id: string }>();
    if (winner && winner.id !== canonical) {
      const loser = group.find((row) => row.id === canonical);
      if (loser) await env.DB.batch(retireDuplicate(env, loser, winner.id));
    }
  }
}

async function cardRow(env: AppEnv, userId: string, id: string) {
  const read = () =>
    env.DB.prepare(
      `SELECT c.* FROM account_cards c JOIN ai_threads t ON t.id=c.thread_id AND t.user_id=c.user_id
    JOIN runs r ON r.id=c.run_id AND r.user_id=c.user_id
    WHERE c.id=? AND c.user_id=? AND t.closed=0 AND r.context_withdrawn=0 AND r.history_deleted=0`,
    )
      .bind(id, userId)
      .first<Row>();
  let row = await read();
  if (!row) throw Error("ACCOUNT_CARD_NOT_FOUND");
  if (row.status === "pending" && !row.identity_digest) {
    await reconcileLegacyCards(env, row.run_id, row.lease_epoch);
    row = await read();
    if (!row) throw Error("ACCOUNT_CARD_NOT_FOUND");
  }
  if (row.status === "pending" && row.expires_at <= now()) {
    await env.DB.prepare(
      "UPDATE account_cards SET status='expired',secret=NULL WHERE id=? AND status='pending' AND expires_at<=?",
    )
      .bind(id, now())
      .run();
    row.status = "expired";
    row.secret = null;
  }
  return row;
}
async function canResume(env: AppEnv, row: Row) {
  return !!(await env.DB.prepare(
    `SELECT r.id FROM runs r JOIN account_locks l ON l.run_id=r.id AND l.account_key=r.account_key
    WHERE r.id=? AND r.lease_epoch=? AND r.lease_expires_at>? AND r.cancel_requested=0
    AND r.context_withdrawn=0 AND r.history_deleted=0 AND r.status IN ('running','waiting_user','verifying')
    AND (r.account_id IS NULL OR r.account_id=?)`,
  )
    .bind(row.run_id, row.lease_epoch, now(), row.account_id)
    .first());
}
export async function pendingCardOrigins(env: AppEnv, runId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT c.id,c.secret FROM account_cards c JOIN runs r ON r.id=c.run_id
    JOIN ai_threads t ON t.id=c.thread_id WHERE c.run_id=? AND c.status='pending' AND c.expires_at>?
    AND t.closed=0 AND r.context_withdrawn=0 AND r.history_deleted=0`,
  )
    .bind(runId, now())
    .all<Row>();
  const origins = new Set<string>();
  for (const row of rows.results) {
    const draft = await unseal<Draft>(row.secret, env.MASTER_KEY, `account-card:${row.id}`);
    // 未确认前仅采集本次真实业务和登录来源，不把模型提出的其他域名预先视为已授权。
    origins.add(draft.origin);
    origins.add(draft.observedOrigin);
    for (const origin of draft.observedOrigins ?? [])
      if (
        draft.loginOrigins.includes(origin) ||
        draft.businessDomains.includes(new URL(origin).hostname)
      )
        origins.add(origin);
  }
  return [...origins];
}
export async function offerAccountCard(env: AppEnv, run: TaskRun, input: unknown) {
  const body = offerSchema.parse(input),
    thread = await runThread(env, run.id);
  await requireLease(env.DB, run.id, run.deviceId!, run.leaseEpoch);
  const binding = await env.DB.prepare(
    "SELECT account_id,account_credential_version,account_state_epoch FROM runs WHERE id=?",
  )
    .bind(run.id)
    .first<Row>();
  let account: Row | null = null,
    draft: Draft;
  if (body.kind === "update") {
    if (binding?.account_id !== body.accountId) throw Error("CREDENTIAL_NOT_AUTHORIZED");
    account = await ownAccount(env, run.userId, body.accountId);
    if (account.credential_version !== binding.account_credential_version)
      throw Error("ACCOUNT_VERSION_CONFLICT");
    if (!accountAllowsOrigin(account, body.origin)) throw Error("CREDENTIAL_ORIGIN_MISMATCH");
    const credentials = await unseal<AccountSecret>(
      account.secret,
      env.MASTER_KEY,
      `account:${account.id}`,
    );
    draft = {
      ...normalizeAccount({
        name: account.name,
        origin: account.origin,
        ...accountDomains(account),
        ...credentials,
      }),
      verified: false,
      evidence: body.evidence,
      observedOrigin: publicUrl(body.origin).origin,
      observedOrigins: [publicUrl(body.origin).origin],
      waitForUpdate: true,
    };
  } else {
    const normalized = normalizeAccount(body),
      observedOrigin = publicUrl(body.observedOrigin).origin;
    if (
      !normalized.businessDomains.includes(publicUrl(run.task.entryUrl).hostname) ||
      normalized.origin !== publicUrl(run.task.entryUrl).origin ||
      (!normalized.loginOrigins.includes(observedOrigin) &&
        !normalized.businessDomains.includes(new URL(observedOrigin).hostname))
    )
      throw Error("ACCOUNT_ORIGIN_MISMATCH");
    draft = {
      ...normalized,
      verified: true,
      evidence: body.evidence,
      observedOrigin,
      observedOrigins: [
        ...new Set(
          (body.observedOrigins ?? [observedOrigin]).map((origin) => publicUrl(origin).origin),
        ),
      ],
      waitForUpdate: false,
    };
    // 已有同域同用户名时更新该账号，而不是悄悄创建第二份身份。确认仍受锁与版本约束。
    const candidates = await env.DB.prepare("SELECT * FROM accounts WHERE user_id=?")
      .bind(run.userId)
      .all<Row>();
    for (const candidate of candidates.results) {
      if (!accountDomains(candidate).businessDomains.includes(new URL(normalized.origin).hostname))
        continue;
      const secret = await unseal<AccountSecret>(
        candidate.secret,
        env.MASTER_KEY,
        `account:${candidate.id}`,
      );
      if (secret.username === normalized.username) {
        account = candidate;
        break;
      }
    }
    if (binding?.account_id && binding.account_id !== account?.id)
      throw Error("ACCOUNT_CONTEXT_MISMATCH");
  }
  const kind = account ? "update" : "save";
  const digest = await cardDigest(env, {
    ...draft,
    accountId: account?.id ?? null,
    credentialVersion: account?.credential_version ?? null,
  });
  const identity = await identityDigest(
    env,
    draft,
    account?.credential_version,
    account?.state_epoch,
  );
  await reconcileLegacyCards(env, run.id, run.leaseEpoch);
  // 到期草稿不能占住唯一身份；已保存入口仍可幂等复用，不能再次创建同一账号。
  await env.DB.prepare(
    "UPDATE account_cards SET status='expired',secret=NULL WHERE run_id=? AND lease_epoch=? AND status='pending' AND expires_at<=?",
  )
    .bind(run.id, run.leaseEpoch, now())
    .run();
  const duplicate = await env.DB.prepare(
    "SELECT id FROM account_cards WHERE run_id=? AND lease_epoch=? AND identity_digest=? AND status IN ('pending','saved')",
  )
    .bind(run.id, run.leaseEpoch, identity)
    .first<{ id: string }>();
  if (duplicate) return { cardId: duplicate.id };
  const id = `card_${await hash(`${run.id}:${run.leaseEpoch}:${body.requestId}`)}`,
    at = now();
  const prior = await env.DB.prepare("SELECT input_digest FROM account_cards WHERE id=?")
    .bind(id)
    .first<{ input_digest: string }>();
  if (prior) {
    if (prior.input_digest !== digest) throw Error("ACCOUNT_CARD_INPUT_CONFLICT");
    return { cardId: id };
  }
  const fence = {
    sql: `EXISTS(SELECT 1 FROM runs WHERE id=? AND lease_epoch=? AND lease_expires_at>? AND cancel_requested=0 AND context_withdrawn=0 AND history_deleted=0 AND status IN ('running','waiting_user','verifying'))`,
    values: [run.id, run.leaseEpoch, at],
  };
  const message = await messageStatement(
    env,
    thread.id,
    {
      id: `account-card_${id}`,
      source: "executor",
      content:
        kind === "save" ? "登录成功，可保存这个账号供后续任务使用。" : "请确认或修改账号信息。",
      parts: [{ type: "account-card", cardId: id }],
      runId: run.id,
    },
    {
      sql: `${fence.sql} AND EXISTS(SELECT 1 FROM account_cards WHERE id=? AND status='pending')`,
      values: [...fence.values, id],
    },
  );
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO account_cards(id,user_id,thread_id,run_id,lease_epoch,kind,account_id,credential_version,state_epoch,secret,input_digest,identity_digest,created_at,expires_at,wait_for_update,user_seq)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(seq),0) FROM ai_messages WHERE thread_id=? AND role='user') WHERE ${fence.sql} AND EXISTS(SELECT 1 FROM ai_threads WHERE id=? AND closed=0)`,
    ).bind(
      id,
      run.userId,
      thread.id,
      run.id,
      run.leaseEpoch,
      kind,
      account?.id ?? null,
      account?.credential_version ?? null,
      account?.state_epoch ?? null,
      await seal(draft, env.MASTER_KEY, `account-card:${id}`),
      digest,
      identity,
      at,
      new Date(Date.now() + 86400000).toISOString(),
      Number(draft.waitForUpdate),
      thread.id,
      ...fence.values,
      thread.id,
    ),
    message,
    ...(draft.waitForUpdate
      ? [
          env.DB.prepare(
            `UPDATE runs SET status='waiting_user',updated_at=? WHERE id=? AND lease_epoch=? AND EXISTS(SELECT 1 FROM account_cards WHERE id=? AND status='pending')`,
          ).bind(at, run.id, run.leaseEpoch, id),
          env.DB.prepare(
            "UPDATE accounts SET credential_status='invalid' WHERE id=? AND credential_version=? AND EXISTS(SELECT 1 FROM account_cards WHERE id=? AND status='pending')",
          ).bind(account!.id, account!.credential_version, id),
        ]
      : []),
  ]);
  if (!results[0].meta.changes) {
    const winner = await env.DB.prepare(
      "SELECT id FROM account_cards WHERE run_id=? AND lease_epoch=? AND identity_digest=? AND status IN ('pending','saved')",
    )
      .bind(run.id, run.leaseEpoch, identity)
      .first<{ id: string }>();
    if (winner) return { cardId: winner.id };
    throw Error("ACCOUNT_CARD_STALE");
  }
  return { cardId: id };
}

async function confirmCard(env: AppEnv, userId: string, id: string, input: AccountInput) {
  const body = normalizeAccount(input),
    row = await cardRow(env, userId, id),
    digest = await cardDigest(env, body);
  if (row.status === "saved") {
    if (row.confirm_digest !== digest) throw Error("ACCOUNT_CARD_CONFLICT");
    return { accountId: row.result_account_id, status: "saved" as const, resumed: !!row.resumed };
  }
  if (row.status !== "pending" || !row.secret) throw Error("ACCOUNT_CARD_STALE");
  const draft = await unseal<Draft>(row.secret, env.MASTER_KEY, `account-card:${id}`);
  const unchanged =
    body.username === draft.username &&
    body.password === draft.password &&
    body.origin === draft.origin &&
    JSON.stringify(body.businessDomains) === JSON.stringify(draft.businessDomains) &&
    JSON.stringify(body.loginOrigins) === JSON.stringify(draft.loginOrigins);
  const verified = draft.verified && unchanged,
    accountId = row.account_id ?? uid("account");
  const previous = row.account_id ? await ownAccount(env, userId, row.account_id) : null;
  if (
    previous &&
    (previous.credential_version !== row.credential_version ||
      previous.state_epoch !== row.state_epoch)
  )
    throw Error("ACCOUNT_VERSION_CONFLICT");
  const nextVersion = previous ? previous.credential_version + 1 : 1,
    nextEpoch = previous ? previous.state_epoch + 1 : 1,
    at = now();
  const savedIdentity = await identityDigest(env, { ...draft, ...body }, nextVersion, nextEpoch);
  const active = await canResume(env, row);
  const adopt = active && unchanged && draft.verified;
  const resumed = active && draft.waitForUpdate;
  const secret = await seal(
    { username: body.username, password: body.password },
    env.MASTER_KEY,
    `account:${accountId}`,
  );
  const profileId = adopt
    ? (await env.DB.prepare("SELECT profile_id FROM runs WHERE id=?")
        .bind(row.run_id)
        .first<{ profile_id: string }>())!.profile_id
    : (previous?.profile_id ?? uid("profile"));
  // 事务中的同一条件也保护“读完卡片后聊天被删除/账号被编辑”的竞态。
  const fence = `EXISTS(SELECT 1 FROM account_cards c JOIN ai_threads t ON t.id=c.thread_id JOIN runs r ON r.id=c.run_id
    WHERE c.id=? AND c.user_id=? AND c.status='pending' AND c.expires_at>? AND t.closed=0 AND r.context_withdrawn=0 AND r.history_deleted=0
    AND (c.wait_for_update=0 OR (SELECT COALESCE(MAX(seq),0) FROM ai_messages WHERE thread_id=c.thread_id AND role='user')=c.user_seq)
    AND (c.account_id IS NULL OR EXISTS(SELECT 1 FROM accounts a WHERE a.id=c.account_id AND a.user_id=c.user_id AND a.credential_version=c.credential_version AND a.state_epoch=c.state_epoch)))
    ${
      adopt
        ? `AND EXISTS(SELECT 1 FROM runs r JOIN account_locks l ON l.run_id=r.id WHERE r.id=? AND r.lease_epoch=?
      AND r.lease_expires_at>? AND r.cancel_requested=0 AND r.status IN ('running','waiting_user','verifying') AND r.profile_id=?)`
        : ""
    }`;
  const fenceArgs: (string | number)[] = [
    id,
    userId,
    at,
    ...(adopt ? [row.run_id, row.lease_epoch, at, profileId] : []),
  ];
  const accountWrite = previous
    ? env.DB.prepare(
        `UPDATE accounts SET name=?,origin=?,username_hint=?,secret=?,business_domains=?,login_origins=?,
    credential_version=?,state_epoch=?,credential_status=?,profile_id=?,state_object_key=NULL,previous_state_object_key=NULL,sync_status='none',sync_error=NULL,login_reset=?,
    state_owner_run_id=CASE WHEN EXISTS(SELECT 1 FROM account_locks WHERE account_key=accounts.id AND run_id=?) THEN ? ELSE state_owner_run_id END
    WHERE id=? AND user_id=? AND credential_version=? AND state_epoch=? AND ${fence}`,
      ).bind(
        body.name,
        body.origin,
        body.username ? body.username.slice(0, 2) + "***" : "未设置",
        secret,
        JSON.stringify(body.businessDomains),
        JSON.stringify(body.loginOrigins),
        nextVersion,
        nextEpoch,
        verified ? "valid" : "unverified",
        profileId,
        verified ? 0 : 1,
        row.run_id,
        row.run_id,
        accountId,
        userId,
        row.credential_version,
        row.state_epoch,
        ...fenceArgs,
      )
    : env.DB.prepare(
        `INSERT INTO accounts(id,name,origin,username_hint,secret,created_at,user_id,profile_id,business_domains,login_origins,credential_status,login_reset,state_owner_run_id)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${fence}`,
      ).bind(
        accountId,
        body.name,
        body.origin,
        body.username ? body.username.slice(0, 2) + "***" : "未设置",
        secret,
        at,
        userId,
        profileId,
        JSON.stringify(body.businessDomains),
        JSON.stringify(body.loginOrigins),
        verified ? "valid" : "unverified",
        verified ? 0 : 1,
        row.run_id,
        ...fenceArgs,
      );
  const liveFence = `id=? AND user_id=? AND lease_epoch=? AND lease_expires_at>? AND cancel_requested=0 AND context_withdrawn=0 AND history_deleted=0 AND status IN ('running','waiting_user','verifying')`;
  await env.DB.batch([
    // 锁先转移；条件失败不会授予账号。UNIQUE(account_key) 拒绝另一个未收尾运行占用的账号。
    ...(adopt
      ? [
          env.DB.prepare(
            `UPDATE account_locks SET account_key=? WHERE run_id=? AND account_key IN (?,?) AND ${fence}
      AND EXISTS(SELECT 1 FROM runs WHERE ${liveFence})`,
          ).bind(
            accountId,
            row.run_id,
            `task:${(await getRun(env.DB, row.run_id)).taskId}`,
            accountId,
            ...fenceArgs,
            row.run_id,
            userId,
            row.lease_epoch,
            at,
          ),
        ]
      : []),
    accountWrite,
    env.DB.prepare(
      `INSERT OR IGNORE INTO account_credential_versions(account_id,version,secret,login_origins,created_at)
      SELECT id,credential_version,secret,login_origins,? FROM accounts WHERE id=? AND credential_version=? AND secret=?`,
    ).bind(at, accountId, nextVersion, secret),
    env.DB.prepare(
      `UPDATE account_cards SET status='saved',secret=NULL,confirm_digest=?,identity_digest=?,result_account_id=?,resumed=0 WHERE id=? AND status='pending'
      AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND credential_version=? AND secret=?)`,
    ).bind(digest, savedIdentity, accountId, id, accountId, nextVersion, secret),
    ...(adopt || resumed
      ? [
          env.DB.prepare(
            `UPDATE runs SET account_id=?,account_key=?,account_credential_version=?,account_state_epoch=?,status=CASE WHEN ? THEN 'running' ELSE status END
      WHERE ${liveFence} AND EXISTS(SELECT 1 FROM account_cards WHERE id=? AND status='saved' AND result_account_id=?)
      AND EXISTS(SELECT 1 FROM account_locks WHERE run_id=runs.id AND account_key=?)`,
          ).bind(
            accountId,
            accountId,
            nextVersion,
            nextEpoch,
            Number(resumed),
            row.run_id,
            userId,
            row.lease_epoch,
            at,
            id,
            accountId,
            accountId,
          ),
        ]
      : []),
    ...(resumed
      ? [
          env.DB.prepare(
            `UPDATE account_cards SET resumed=1 WHERE id=? AND status='saved' AND confirm_digest=?
      AND EXISTS(SELECT 1 FROM runs WHERE id=? AND lease_epoch=? AND account_id=? AND account_credential_version=? AND account_state_epoch=?
        AND status='running' AND lease_expires_at>? AND cancel_requested=0)`,
          ).bind(id, digest, row.run_id, row.lease_epoch, accountId, nextVersion, nextEpoch, at),
        ]
      : []),
    // 实际登录验证不依赖快照上传成功；晚确认仍引用原执行，不能用重放的卡片改写新版本偏好。
    ...(verified
      ? [
          env.DB.prepare(
            `UPDATE accounts SET last_device_id=(SELECT device_id FROM runs WHERE id=?)
      WHERE id=? AND user_id=? AND credential_version=? AND state_epoch=? AND credential_status='valid' AND secret=?
      AND EXISTS(SELECT 1 FROM account_cards c JOIN runs r ON r.id=c.run_id JOIN ai_threads t ON t.id=c.thread_id
        JOIN devices d ON d.id=r.device_id AND d.revoked=0
        WHERE c.id=? AND c.status='saved' AND c.confirm_digest=? AND c.result_account_id=accounts.id
        AND c.user_id=accounts.user_id AND r.user_id=c.user_id AND r.lease_epoch=c.lease_epoch
        AND (r.account_id IS NULL OR r.account_id=accounts.id) AND r.context_withdrawn=0 AND r.history_deleted=0 AND t.closed=0)`,
          ).bind(row.run_id, accountId, userId, nextVersion, nextEpoch, secret, id, digest),
        ]
      : []),
  ]);
  const final = await cardRow(env, userId, id);
  if (final.status !== "saved" || final.confirm_digest !== digest)
    throw Error("ACCOUNT_CARD_STALE");
  if (verified)
    try {
      await linkAccountSnapshot(env, {
        runId: row.run_id,
        accountId: final.result_account_id,
        credentialVersion: nextVersion,
        stateEpoch: nextEpoch,
      });
    } catch {
      // 账号确认已经提交，状态同步故障不能让用户误以为凭据保存失败并重复创建账号。
      await env.DB.prepare(
        "UPDATE accounts SET sync_status='failed',sync_error='SYNC_FAILED' WHERE id=? AND credential_version=? AND state_epoch=? AND state_owner_run_id=?",
      )
        .bind(final.result_account_id, nextVersion, nextEpoch, row.run_id)
        .run()
        .catch(() => {});
    }
  return { accountId: final.result_account_id, status: "saved" as const, resumed: !!final.resumed };
}

const accountCardRoutesBase = new Hono<{ Bindings: AppEnv; Variables: Variables }>();

export function registerAccountRunnerRoutes(router: Router) {
  router.post("/runs/:id/account-card", async (c) => {
    const raw = z
      .object({ epoch: z.number().int() })
      .passthrough()
      .parse(await c.req.json());
    const run = await requireLease(c.env.DB, c.req.param("id"), c.get("deviceId"), raw.epoch);
    const { epoch, ...input } = raw;
    return c.json(await offerAccountCard(c.env, run, input));
  });
  router.post("/runs/:id/account-card-status", async (c) => {
    const body = z
      .object({
        epoch: z.number().int(),
        cardId: idSchema,
        afterUserSeq: z.number().int().nonnegative().optional(),
      })
      .strict()
      .parse(await c.req.json());
    const run = await requireLease(c.env.DB, c.req.param("id"), c.get("deviceId"), body.epoch);
    let row = await cardRow(c.env, run.userId, body.cardId);
    if (row.run_id !== run.id || row.lease_epoch !== run.leaseEpoch)
      throw Error("ACCOUNT_CARD_STALE");
    if (row.status === "pending" && body.afterUserSeq !== undefined) {
      await c.env.DB.prepare(
        `UPDATE account_cards SET status='dismissed',secret=NULL WHERE id=? AND status='pending'
        AND (SELECT COALESCE(MAX(seq),0) FROM ai_messages WHERE thread_id=account_cards.thread_id AND role='user')>?`,
      )
        .bind(row.id, body.afterUserSeq)
        .run();
      row = await cardRow(c.env, run.userId, body.cardId);
    }
    if (row.status === "dismissed" || row.status === "expired")
      await c.env.DB.prepare(
        `UPDATE runs SET status='running' WHERE id=? AND lease_epoch=? AND status='waiting_user'
      AND cancel_requested=0 AND lease_expires_at>? AND NOT EXISTS(SELECT 1 FROM account_cards WHERE run_id=? AND kind='update' AND status='pending')`,
      )
        .bind(run.id, run.leaseEpoch, now(), run.id)
        .run();
    const binding = await c.env.DB.prepare(
      "SELECT account_id,account_credential_version,account_state_epoch FROM runs WHERE id=?",
    )
      .bind(run.id)
      .first<Row>();
    return c.json({
      status: row.status,
      accountId: binding?.account_id,
      credentialVersion: binding?.account_credential_version,
      stateEpoch: binding?.account_state_epoch,
      resumed: !!row.resumed,
    });
  });
  router.post("/runs/:id/account-status", async (c) => {
    const body = z
      .object({
        epoch: z.number().int(),
        accountId: idSchema,
        credentialVersion: z.number().int().positive(),
        origin: z.url(),
        evidence: z.string().min(1).max(2000),
        status: z.literal("valid"),
      })
      .strict()
      .parse(await c.req.json());
    const run = await requireLease(c.env.DB, c.req.param("id"), c.get("deviceId"), body.epoch);
    const account = await ownAccount(c.env, run.userId, body.accountId);
    if (!accountAllowsOrigin(account, body.origin) && !accountMatchesDomain(account, body.origin))
      throw Error("CREDENTIAL_ORIGIN_MISMATCH");
    const result = await c.env.DB.prepare(
      `UPDATE accounts SET credential_status='valid',login_reset=0,last_device_id=? WHERE id=? AND user_id=? AND credential_version=?
      AND EXISTS(SELECT 1 FROM runs r JOIN account_locks l ON l.run_id=r.id AND l.account_key=r.account_id WHERE r.id=? AND r.account_id=accounts.id
      AND r.user_id=accounts.user_id AND r.device_id=? AND r.account_credential_version=accounts.credential_version AND r.account_state_epoch=accounts.state_epoch
      AND r.lease_epoch=? AND r.lease_expires_at>? AND r.cancel_requested=0 AND r.context_withdrawn=0 AND r.history_deleted=0
      AND r.status IN ('running','waiting_user','verifying') AND EXISTS(SELECT 1 FROM ai_threads WHERE id=r.thread_id AND closed=0))`,
    )
      .bind(
        run.deviceId,
        account.id,
        run.userId,
        body.credentialVersion,
        run.id,
        run.deviceId,
        run.leaseEpoch,
        now(),
      )
      .run();
    if (!result.meta.changes) throw Error("ACCOUNT_VERSION_CONFLICT");
    return c.json({ ok: true });
  });
}
export async function cleanupAccountCards(env: AppEnv) {
  await env.DB.prepare(
    `UPDATE account_cards SET status=CASE WHEN status='pending' THEN 'expired' ELSE status END,secret=NULL
    WHERE secret IS NOT NULL AND (expires_at<=? OR NOT EXISTS(SELECT 1 FROM ai_threads WHERE id=account_cards.thread_id AND closed=0)
    OR EXISTS(SELECT 1 FROM runs WHERE id=account_cards.run_id AND (context_withdrawn=1 OR history_deleted=1)))`,
  )
    .bind(now())
    .run();
  await env.DB.prepare(
    `DELETE FROM account_credential_versions WHERE version<>(SELECT credential_version FROM accounts WHERE id=account_id)
    AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.account_id=account_credential_versions.account_id AND r.account_credential_version=account_credential_versions.version
      AND (r.status IN ('running','waiting_user','verifying','unknown') OR r.cleanup_pending=1))`,
  ).run();
}

export const accountCardRoutes = accountCardRoutesBase
  .get("/account-cards/:id", async (c) => {
    const row = await cardRow(c.env, c.get("userId"), c.req.param("id"));
    const draft = row.secret
      ? await unseal<Draft>(row.secret, c.env.MASTER_KEY, `account-card:${row.id}`)
      : null;
    return c.json({
      id: row.id,
      kind: row.kind,
      status: row.status,
      supersededBy: row.superseded_by ?? undefined,
      accountId: row.result_account_id ?? row.account_id,
      credentialVersion: row.credential_version,
      expiresAt: row.expires_at,
      canResume: row.status === "pending" && (await canResume(c.env, row)),
      verified: draft?.verified ?? false,
      ...(draft
        ? {
            name: draft.name,
            origin: draft.origin,
            businessDomains: draft.businessDomains,
            loginOrigins: draft.loginOrigins,
            username: draft.username,
            password: draft.password,
          }
        : { name: "", origin: "", businessDomains: [], loginOrigins: [] }),
    });
  })
  .post(
    "/account-cards/:id/confirm",
    validator("json", (value: z.input<typeof accountInputSchema>) =>
      accountInputSchema.parse(value),
    ),
    async (c) =>
      c.json(await confirmCard(c.env, c.get("userId"), c.req.param("id"), c.req.valid("json"))),
  )
  .post("/account-cards/:id/dismiss", async (c) => {
    const row = await cardRow(c.env, c.get("userId"), c.req.param("id"));
    if (row.status === "pending")
      await c.env.DB.prepare(
        "UPDATE account_cards SET status='dismissed',secret=NULL WHERE id=? AND status='pending'",
      )
        .bind(row.id)
        .run();
    return c.json({ ok: true });
  });
