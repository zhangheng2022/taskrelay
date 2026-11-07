import { dbTime } from "./database";
import {
  browserStateSchema,
  BROWSER_STATE_MAX_BYTES,
  type BrowserState,
  type BrowserStateAccess,
} from "../../../packages/contracts/src/accounts";
import { publicUrl } from "../../../packages/contracts/src/security";
import type { TaskRun } from "../../../packages/contracts/src/index";
import type { AppEnv } from "./env";
import { now, type Row } from "./store";

/** 账号状态授权、候选上传与发布的唯一入口。浏览器必须已退出才发布，
 * 凭据代次/租约/基准版本及最后领取者均在 D1 条件更新中复核；DO 只存不可变加密内容。 */
export function stateOrigins(account: Row): string[] {
  const login = JSON.parse(account.login_origins || "[]") as string[];
  const origins = [account.origin, ...login];
  for (const host of JSON.parse(account.business_domains || "[]") as string[])
    origins.push(`${new URL(account.origin).protocol}//${host}`);
  return [...new Set(origins.map((value) => publicUrl(value).origin))];
}
export function filterBrowserState(input: unknown, origins: string[]): BrowserState {
  const state = browserStateSchema.parse(input),
    allowed = new Set(origins.map((origin) => publicUrl(origin).origin));
  const hosts = [...allowed].map((origin) => new URL(origin).hostname);
  const result: BrowserState = {
    version: 1,
    cookies: state.cookies.filter((cookie) => {
      const domain = cookie.domain.toLowerCase();
      if (cookie.partitionKey) publicUrl(cookie.partitionKey.topLevelSite);
      return hosts.some((host) =>
        domain.startsWith(".")
          ? host === domain.slice(1) || host.endsWith(domain)
          : host === domain,
      );
    }),
    origins: state.origins
      .filter((entry) => allowed.has(publicUrl(entry.origin).origin))
      .map((entry) => ({ ...entry, origin: publicUrl(entry.origin).origin })),
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > BROWSER_STATE_MAX_BYTES)
    throw Error("BROWSER_STATE_TOO_LARGE");
  return result;
}
async function accountForRun(env: AppEnv, run: TaskRun) {
  const row = await env.DB.prepare(
    `SELECT a.* FROM account_details a JOIN runs r ON r.account_id=a.id
    JOIN account_locks l ON l.account_key=a.id AND l.run_id=r.id
    WHERE r.id=? AND a.user_id=? AND r.device_id=? AND r.lease_epoch=?`,
  )
    .bind(run.id, run.userId, run.deviceId, run.leaseEpoch)
    .first<Row>();
  if (run.accountId && !row) throw Error("ACCOUNT_BUSY");
  return row;
}
export async function browserStateAccess(
  env: AppEnv,
  run: TaskRun,
  extraOrigins: string[] = [],
  loadState = true,
): Promise<BrowserStateAccess> {
  const account = await accountForRun(env, run);
  if (!account)
    return {
      accountId: null,
      credentialVersion: 1,
      stateEpoch: 1,
      revision: 0,
      origins: [...new Set([publicUrl(run.task.entryUrl).origin, ...extraOrigins])],
      state: null,
    };
  const origins = stateOrigins(account),
    sameVersion =
      account.credential_version === (run.credentialVersion ?? 1) &&
      account.state_epoch === (run.stateEpoch ?? 1);
  const result: BrowserStateAccess = {
    accountId: account.id,
    credentialVersion: run.credentialVersion ?? 1,
    stateEpoch: run.stateEpoch ?? 1,
    revision: sameVersion ? account.state_revision : 0,
    origins,
    state: null,
  };
  if (!sameVersion || !loadState) return result;
  for (const key of [account.state_object_key, account.previous_state_object_key].filter(Boolean)) {
    try {
      const bytes = await env.BROWSER_STATES.getByName(key).get(key);
      if (!bytes) throw Error("BROWSER_STATE_MISSING");
      result.state = filterBrowserState(JSON.parse(new TextDecoder().decode(bytes)), origins);
      return result;
    } catch {
      result.restoreFailed = true;
    }
  }
  return result;
}
export async function stageBrowserState(
  env: AppEnv,
  run: TaskRun,
  input: unknown,
  baseRevision: number,
  extraOrigins: string[] = [],
) {
  const account = await accountForRun(env, run);
  if (
    account &&
    (account.credential_version !== (run.credentialVersion ?? 1) ||
      account.state_epoch !== (run.stateEpoch ?? 1))
  )
    throw Error("ACCOUNT_STATE_CHANGED");
  const origins = account
    ? stateOrigins(account)
    : [...new Set([publicUrl(run.task.entryUrl).origin, ...extraOrigins])];
  const state = filterBrowserState(input, origins),
    key = `state_${crypto.randomUUID()}`;
  let clearPrevious =
    state.cookies.length === 0 && state.origins.every((origin) => origin.localStorage.length === 0);
  if (account?.state_object_key) {
    try {
      const priorBytes = await env.BROWSER_STATES.getByName(account.state_object_key).get(
        account.state_object_key,
      );
      if (!priorBytes) throw Error("BROWSER_STATE_MISSING");
      const prior = filterBrowserState(JSON.parse(new TextDecoder().decode(priorBytes)), origins);
      const cookieKey = (cookie: BrowserState["cookies"][number]) =>
        JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey]);
      const cookies = new Map(state.cookies.map((cookie) => [cookieKey(cookie), cookie.value]));
      const entries = new Map(
        state.origins.flatMap((origin) =>
          origin.localStorage.map(
            ([name, value]) => [JSON.stringify([origin.origin, name]), value] as const,
          ),
        ),
      );
      // 无法识别网站把哪一项用作退出标志。任何旧凭据项删除或改值都不允许损坏恢复复活旧值；
      // 正常 token 刷新因此也可能舍弃上一份，这是比回退旧认证更保守的恢复边界。
      clearPrevious ||=
        prior.cookies.some((cookie) => cookies.get(cookieKey(cookie)) !== cookie.value) ||
        prior.origins.some((origin) =>
          origin.localStorage.some(
            ([name, value]) => entries.get(JSON.stringify([origin.origin, name])) !== value,
          ),
        );
    } catch {
      clearPrevious = true;
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  await env.BROWSER_STATES.getByName(key).put(key, bytes.buffer);
  const [saved] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO browser_state_candidates(object_key,user_id,account_id,run_id,device_id,lease_epoch,credential_version,state_epoch,base_revision,origins,created_at,expires_at,clear_previous)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM runs WHERE id=? AND lease_epoch=? AND device_id=? AND lease_expires_at>? AND cancel_requested=0 AND history_deleted=0 AND status IN ('running','waiting_user','verifying'))
      AND NOT EXISTS(SELECT 1 FROM browser_state_retirements WHERE object_key=?)`,
    ).bind(
      key,
      run.userId,
      account?.id ?? null,
      run.id,
      run.deviceId,
      run.leaseEpoch,
      run.credentialVersion ?? 1,
      run.stateEpoch ?? 1,
      baseRevision,
      JSON.stringify(origins),
      dbTime(now()),
      dbTime(new Date(Date.now() + 86_400_000).toISOString()),
      Number(clearPrevious),
      run.id,
      run.leaseEpoch,
      run.deviceId,
      dbTime(now()),
      key,
    ),
  ]);
  if (!saved.meta.changes) throw Error("LEASE_EXPIRED");
  return { key };
}
export async function publishBrowserState(env: AppEnv, runId: string) {
  // 非成功/失败的收尾不发布候选；unknown 即使退出也保留锁与待核查事实。
  // 最后领取者在释放锁后仍保留，避免晚确认或旧 close 重试覆盖新执行已经获得的会话。
  const [published] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE accounts SET previous_state_object_key=CASE WHEN (SELECT c.clear_previous FROM browser_state_candidates c JOIN runs r ON r.state_candidate_key=c.object_key WHERE r.id=?)=1 THEN NULL ELSE state_object_key END,
      state_object_key=(SELECT state_candidate_key FROM runs WHERE id=?),state_revision=state_revision+1,sync_status='synced',sync_error=NULL,last_device_id=(SELECT device_id FROM runs WHERE id=?)
      WHERE EXISTS(SELECT 1 FROM browser_state_candidates c JOIN runs r ON r.state_candidate_key=c.object_key
        WHERE r.id=? AND r.cleanup_confirmed=1 AND r.status IN ('succeeded','failed') AND r.history_deleted=0 AND r.context_withdrawn=0
        AND EXISTS(SELECT 1 FROM ai_threads WHERE id=r.thread_id AND closed=0)
        AND c.account_id=accounts.id AND c.user_id=accounts.user_id AND c.credential_version=accounts.credential_version
        AND c.state_epoch=accounts.state_epoch AND c.base_revision=accounts.state_revision AND c.retired=0 AND c.expires_at>?
        AND c.run_id=r.id AND c.device_id=r.device_id AND c.lease_epoch=r.lease_epoch
        AND accounts.state_owner_run_id=r.id
        AND NOT EXISTS(SELECT 1 FROM account_locks WHERE account_key=accounts.id AND run_id<>r.id)
        AND NOT EXISTS(SELECT 1 FROM browser_state_retirements WHERE object_key=c.object_key))`,
    ).bind(runId, runId, runId, runId, dbTime(now())),
  ]);
  if (published.meta.changes)
    await env.DB.prepare(
      "UPDATE browser_state_candidates SET retired=1 WHERE object_key=(SELECT state_candidate_key FROM runs WHERE id=?)",
    )
      .bind(runId)
      .run();
}
export async function linkAccountSnapshot(
  env: AppEnv,
  input: { runId: string; accountId: string; credentialVersion: number; stateEpoch: number },
) {
  const account = await env.DB.prepare("SELECT * FROM account_details WHERE id=?")
    .bind(input.accountId)
    .first<Row>();
  if (!account) return;
  // 用户修改过凭据或域名的卡片不调用此函数。候选仍受原用户与run约束。
  await env.DB.prepare(
    `UPDATE browser_state_candidates SET account_id=?,credential_version=?,state_epoch=?,base_revision=?
    WHERE run_id=? AND account_id IS NULL AND user_id=? AND retired=0 AND expires_at>?
    AND NOT EXISTS(SELECT 1 FROM json_each(origins) o WHERE o.value NOT IN (SELECT value FROM json_each(?)))`,
  )
    .bind(
      input.accountId,
      input.credentialVersion,
      input.stateEpoch,
      account.state_revision,
      input.runId,
      account.user_id,
      dbTime(now()),
      JSON.stringify(stateOrigins(account)),
    )
    .run();
  await publishBrowserState(env, input.runId);
}
