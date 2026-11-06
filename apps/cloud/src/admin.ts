import { PROTOCOL_VERSION } from "../../../packages/contracts/src/index";
import { z } from 'zod';
import { admin } from './user';
import { now,type Row } from './store';
import { quotaSummary } from './tenancy';
export { admin };
admin.get('/operations',async c=>{
 const [members,devices,runs,accounts,settings]=await c.env.DB.batch<Row>([
  c.env.DB.prepare('SELECT id,email,role,disabled,daily_runs,scheduled_tasks,queued_runs,daily_chat,daily_models FROM members ORDER BY email'),
  c.env.DB.prepare('SELECT id,name,last_seen,revoked,protocol_version FROM devices ORDER BY name'),
  c.env.DB.prepare("SELECT id,user_id,device_id,status,created_at,updated_at,json_extract(result,'$.errorCode') error_code FROM runs ORDER BY created_at DESC LIMIT 200"),
  c.env.DB.prepare('SELECT id,user_id,assigned_device_id,login_reset FROM accounts'),
  c.env.DB.prepare("SELECT key,value FROM settings WHERE key='claimsEnabled'"),
 ]);
 return c.json({users:members.results,devices:devices.results,runs:runs.results,accounts:accounts.results,settings:Object.fromEntries(settings.results.map(x=>[x.key,x.value]))});
});
admin.get('/users/:id/usage',async c=>c.json(await quotaSummary(c.env.DB,c.req.param('id'))));
const quota=z.number().int().min(0).max(100000);
admin.put('/users/:id',async c=>{
 const b=z.object({disabled:z.boolean(),daily_runs:quota,scheduled_tasks:quota,queued_runs:quota,daily_chat:quota,daily_models:quota}).strict().parse(await c.req.json());
 const id=c.req.param('id');
 if(id===c.get('userId')&&b.disabled) throw new Error('CANNOT_DISABLE_SELF');
 const exists=await c.env.DB.prepare('SELECT id FROM members WHERE id=?').bind(id).first();
 if(!exists) throw new Error('USER_NOT_FOUND');
 await c.env.DB.batch<Row>([
  c.env.DB.prepare('UPDATE members SET disabled=?,daily_runs=?,scheduled_tasks=?,queued_runs=?,daily_chat=?,daily_models=? WHERE id=?').bind(Number(b.disabled),b.daily_runs,b.scheduled_tasks,b.queued_runs,b.daily_chat,b.daily_models,id),
  c.env.DB.prepare("UPDATE runs SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=? WHERE user_id=? AND ?=1 AND status IN ('queued','running','waiting_user','verifying')").bind(now(),id,Number(b.disabled)),
  c.env.DB.prepare('DELETE FROM auth_session WHERE userId=(SELECT auth_id FROM members WHERE id=?) AND ?=1').bind(id,Number(b.disabled)),
 ]);
 return c.json({ok:true});
});
admin.put('/pool',async c=>{
 const b=z.object({claimsEnabled:z.boolean()}).strict().parse(await c.req.json());
 await c.env.DB.batch<Row>([
 c.env.DB.prepare("UPDATE settings SET value=? WHERE key='claimsEnabled'").bind(b.claimsEnabled?'1':'0'),
 ]);return c.json({ok:true});
});
admin.post('/accounts/:id/migrate',async c=>{
 const b=z.object({deviceId:z.string().min(1).max(100),oldExecutionStopped:z.literal(true)}).strict().parse(await c.req.json());
 const id=c.req.param('id');
 // 管理员确认旧执行已停止，只能补确认已终态进程；未知业务结果仍保留锁。
 // 不再旋转 profile 或丢弃云端状态，目标设备下次领取后尝试恢复。
 const eligible=`EXISTS(SELECT 1 FROM accounts a WHERE a.id=?
   AND EXISTS(SELECT 1 FROM devices WHERE id=? AND revoked=0 AND protocol_version=${PROTOCOL_VERSION})
   AND NOT EXISTS(SELECT 1 FROM runs WHERE account_key=a.id AND status IN ('running','waiting_user','verifying','unknown')))`;
 const results=await c.env.DB.batch([
  c.env.DB.prepare(`UPDATE browser_state_candidates SET retired=1 WHERE run_id IN(SELECT id FROM runs WHERE account_key=? AND status IN ('succeeded','failed','cancelled','expired')) AND ${eligible}`).bind(id,id,b.deviceId),
  c.env.DB.prepare(`UPDATE runs SET cleanup_pending=0,cleanup_confirmed=1,state_candidate_key=NULL WHERE account_key=? AND status IN ('succeeded','failed','cancelled','expired') AND ${eligible}`).bind(id,id,b.deviceId),
  c.env.DB.prepare(`DELETE FROM account_locks WHERE account_key=? AND run_id IN(SELECT id FROM runs WHERE cleanup_pending=0 AND status IN ('succeeded','failed','cancelled','expired')) AND ${eligible}`).bind(id,id,b.deviceId),
  c.env.DB.prepare(`UPDATE accounts SET assigned_device_id=?,last_device_id=? WHERE id=? AND ${eligible}
    AND NOT EXISTS(SELECT 1 FROM account_locks WHERE account_key=accounts.id)`).bind(b.deviceId,b.deviceId,id,id,b.deviceId),
 ]);
 if(results[3].meta.changes!==1) throw new Error('ACCOUNT_MIGRATION_BLOCKED');
 const account=await c.env.DB.prepare('SELECT state_revision,login_reset FROM accounts WHERE id=?').bind(id).first<{state_revision:number;login_reset:number}>();
 return c.json({ok:true,requiresLogin:!account?.state_revision||!!account.login_reset});
});
