import type { AppEnv } from './env';
export const legacyOwner = 'legacy_owner';
export interface Member {
  id: string; auth_id: string | null; email: string; role: 'user' | 'admin'; disabled: number;
  daily_runs: number; scheduled_tasks: number; queued_runs: number; daily_chat: number; daily_models: number;
  daily_quota_paused_until: string | null;
  daily_quota_paused: number;
}
export const quotaDay = (time = Date.now()) => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
export const quotaReset = (time = Date.now()) => new Date(Date.parse(quotaDay(time) + 'T00:00:00+08:00') + 86400000).toISOString();
export async function member(db: D1Database, id: string) {
  const value = await db.prepare('SELECT * FROM members WHERE id=?').bind(id).first<Member>();
  if (!value || value.disabled) throw new Error('USER_DISABLED');
  return value;
}
export async function reserve(env: AppEnv, userId: string, kind: 'chat' | 'model', id: string = crypto.randomUUID()) {
  const existing=await env.DB.prepare('SELECT user_id,kind FROM quota_reservations WHERE id=?').bind(id).first<{user_id:string;kind:string}>();
  if(existing) { if(existing.user_id!==userId||existing.kind!==kind) throw new Error('QUOTA_CONFLICT'); return id; }
  const day = quotaDay();
  const column = kind === 'chat' ? 'daily_chat' : 'daily_models';
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO quota_reservations(id,user_id,day,kind,created_at)
    SELECT ?,id,?,?,? FROM members m WHERE id=? AND disabled=0
    AND (m.daily_quota_paused=1 OR m.daily_quota_paused_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') OR (SELECT COUNT(*) FROM quota_reservations WHERE user_id=m.id AND day=? AND kind=?) < m.${column})`)
    .bind(id,day,kind,new Date().toISOString(),userId,day,kind).run();
  if (!result.meta.changes) {
    const prior=await env.DB.prepare('SELECT user_id,kind FROM quota_reservations WHERE id=?').bind(id).first<{user_id:string;kind:string}>();
    if(prior?.user_id===userId && prior.kind===kind) return id;
    throw new Error(kind === 'chat' ? 'CHAT_QUOTA_EXCEEDED' : 'MODEL_QUOTA_EXCEEDED');
  }
  return id;
}
export async function quotaSummary(db: D1Database, userId: string, checked?:Member) {
  const m = checked??await member(db,userId), day=quotaDay();
  const [runs, calls] = await db.batch<{n?:number;kind?:string}>([
    db.prepare('SELECT COUNT(*) + COALESCE((SELECT runs FROM quota_carry WHERE user_id=? AND day=?),0) n FROM runs WHERE user_id=? AND started_day=?').bind(userId,day,userId,day),
    db.prepare('SELECT kind,COUNT(*) n FROM quota_reservations WHERE user_id=? AND day=? GROUP BY kind').bind(userId,day),
  ]);
  const pausedUntil=m.daily_quota_paused_until&&Date.parse(m.daily_quota_paused_until)>Date.now()?m.daily_quota_paused_until:null;
  return { resetAt: quotaReset(), paused:m.daily_quota_paused===1||!!pausedUntil,pausedUntil:m.daily_quota_paused===1?null:pausedUntil,
    limits: { runs:m.daily_runs, scheduled:m.scheduled_tasks, queued:m.queued_runs, chat:m.daily_chat, models:m.daily_models },
    used: { runs:Number(runs.results[0]?.n??0), chat:Number(calls.results.find(x=>x.kind==='chat')?.n??0), models:Number(calls.results.find(x=>x.kind==='model')?.n??0) } };
}
