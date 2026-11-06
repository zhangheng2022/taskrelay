/**
 * 账号保存、域名匹配与凭据版本的唯一入口。用户设置写入下一版本，执行只读取领取时固定的版本；
 * 站点允许范围用于凭据和状态归属，不限制普通浏览。密文沿用既有 MASTER_KEY 和 account AAD。
 */
import {validator} from 'hono/validator';
import { z } from 'zod';
import { Hono } from 'hono';
import type { AppEnv, Variables } from './env';
import type { TaskRun } from '../../../packages/contracts/src/index';
import { publicUrl } from '../../../packages/contracts/src/security';
import { now, uid, type Row } from './store';
import { seal, unseal } from './crypto';

export const accountInputSchema = z.object({
  name: z.string().trim().min(1).max(80), origin: z.url().max(2000),
  username: z.string().max(200), password: z.string().max(2000),
  businessDomains: z.array(z.string().min(1).max(253)).min(1).max(20).optional(),
  loginOrigins: z.array(z.url().max(2000)).min(1).max(20).optional(),
}).strict();
export type AccountInput = z.infer<typeof accountInputSchema>;
export type AccountSecret = {username:string;password:string};
type Router = Hono<{Bindings:AppEnv;Variables:Variables}>;

export function accountDomains(row:Row) {
  const business=JSON.parse(row.business_domains||'[]') as string[],login=JSON.parse(row.login_origins||'[]') as string[];
  return {businessDomains:business.length?business:[new URL(row.origin).hostname],loginOrigins:login.length?login:[new URL(row.origin).origin]};
}
export function normalizeAccount(input:AccountInput) {
  const origin=publicUrl(input.origin).origin;
  const businessDomains=[...new Set((input.businessDomains??[new URL(origin).hostname]).map(value=>{
    if(value.includes('*')||value.includes('/')||value.includes(':')||value.includes('@'))throw Error('ACCOUNT_DOMAIN_INVALID');
    return publicUrl(`https://${value}`).hostname;
  }))];
  if(!businessDomains.includes(new URL(origin).hostname))throw Error('ACCOUNT_ORIGIN_MISMATCH');
  const loginOrigins=[...new Set((input.loginOrigins??[origin]).map(value=>publicUrl(value).origin))];
  return {name:input.name,username:input.username,password:input.password,origin,businessDomains,loginOrigins};
}
export function accountMatchesDomain(row:Row,url:string) {
  return accountDomains(row).businessDomains.includes(publicUrl(url).hostname);
}
export function accountAllowsOrigin(row:Row,url:string) {
  return accountDomains(row).loginOrigins.includes(publicUrl(url).origin);
}
export function accountSummary(row:Row) {
  return {id:row.id,name:row.name,origin:row.origin,usernameHint:row.username_hint,createdAt:row.created_at,
    assignedDeviceId:row.assigned_device_id,loginReset:!!row.login_reset,...accountDomains(row),
    credentialVersion:row.credential_version,stateEpoch:row.state_epoch,credentialStatus:row.credential_status,
    stateRevision:row.state_revision,syncStatus:row.sync_status,syncError:row.sync_error??undefined,lastDeviceId:row.last_device_id};
}
export async function ownAccount(env:AppEnv,userId:string,id:string) {
  const row=await env.DB.prepare('SELECT * FROM accounts WHERE id=? AND user_id=?').bind(id,userId).first<Row>();
  if(!row)throw Error('ACCOUNT_NOT_FOUND');
  return row;
}
export async function readRunCredentials(env:AppEnv,run:TaskRun,origin:string) {
  const binding=await env.DB.prepare(`SELECT r.account_id,r.account_credential_version,r.account_state_epoch
    FROM runs r JOIN account_locks l ON l.run_id=r.id AND l.account_key=r.account_id
    WHERE r.id=? AND r.user_id=? AND r.device_id=? AND r.lease_epoch=? AND r.lease_expires_at>?
    AND r.cancel_requested=0 AND r.context_withdrawn=0 AND r.status IN ('running','waiting_user','verifying')`)
    .bind(run.id,run.userId,run.deviceId,run.leaseEpoch,now()).first<Row>();
  if(!binding?.account_id)throw Error('CREDENTIAL_NOT_AUTHORIZED');
  const a=await ownAccount(env,run.userId,binding.account_id);
  const version=await env.DB.prepare('SELECT secret,login_origins FROM account_credential_versions WHERE account_id=? AND version=?')
    .bind(a.id,binding.account_credential_version).first<Row>();
  if(!version||!(JSON.parse(version.login_origins) as string[]).includes(publicUrl(origin).origin))throw Error('CREDENTIAL_ORIGIN_MISMATCH');
  return {account:await unseal<AccountSecret>(version.secret,env.MASTER_KEY,`account:${a.id}`),origin:publicUrl(origin).origin,
    accountId:a.id,credentialVersion:binding.account_credential_version,stateEpoch:binding.account_state_epoch};
}
export async function createAccount(env:AppEnv,userId:string,input:AccountInput) {
  const body=normalizeAccount(input),id=uid('account'),at=now();
  const secret=await seal({username:body.username,password:body.password},env.MASTER_KEY,`account:${id}`);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO accounts(id,name,origin,username_hint,secret,created_at,user_id,profile_id,business_domains,login_origins)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(id,body.name,body.origin,body.username?body.username.slice(0,2)+'***':'未设置',secret,at,userId,uid('profile'),JSON.stringify(body.businessDomains),JSON.stringify(body.loginOrigins)),
    env.DB.prepare('INSERT INTO account_credential_versions(account_id,version,secret,login_origins,created_at) VALUES(?,1,?,?,?)').bind(id,secret,JSON.stringify(body.loginOrigins),at),
  ]);
  return {id};
}
const accountRoutesBase =new Hono<{Bindings:AppEnv;Variables:Variables}>();

const accountUpdateInput=accountInputSchema.partial().extend({expectedCredentialVersion:z.number().int().positive()}).strict();
const accountStateClearInput=z.object({expectedStateEpoch:z.number().int().positive()}).strict();
export const accountRoutes=accountRoutesBase
.post('/accounts',validator('json',(value:z.input<typeof accountInputSchema>)=>accountInputSchema.parse(value)), async c=>c.json(await createAccount(c.env,c.get('userId'),c.req.valid('json')),201))
.get('/accounts/:id',async c=>{
    const row=await ownAccount(c.env,c.get('userId'),c.req.param('id'));
    return c.json({account:accountSummary(row),...await unseal<AccountSecret>(row.secret,c.env.MASTER_KEY,`account:${row.id}`)});
  })
.patch('/accounts/:id',validator('json',(value:z.input<typeof accountUpdateInput>)=>accountUpdateInput.parse(value)), async c=>{
    const body=c.req.valid('json');
    const row=await ownAccount(c.env,c.get('userId'),c.req.param('id'));
    if(row.credential_version!==body.expectedCredentialVersion)throw Error('ACCOUNT_VERSION_CONFLICT');
    const previous=await unseal<AccountSecret>(row.secret,c.env.MASTER_KEY,`account:${row.id}`);
    const value=normalizeAccount({...previous,name:row.name,origin:row.origin,...accountDomains(row),...body});
    const changed=value.username!==previous.username||value.password!==previous.password||value.origin!==row.origin||
      JSON.stringify(value.businessDomains)!==JSON.stringify(accountDomains(row).businessDomains)||JSON.stringify(value.loginOrigins)!==JSON.stringify(accountDomains(row).loginOrigins);
    const secret=await seal({username:value.username,password:value.password},c.env.MASTER_KEY,`account:${row.id}`);
    const at=now(),next=row.credential_version+Number(changed);
    // 名称不改变认证版本，也不让有效快照失效；认证变更才推进凭据和状态版本。
    const writes=await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE accounts SET name=?,origin=?,username_hint=?,secret=?,business_domains=?,login_origins=?,credential_version=?,
        state_epoch=state_epoch+?,credential_status=CASE WHEN ? THEN 'unverified' ELSE credential_status END,
        login_reset=CASE WHEN ? THEN 1 ELSE login_reset END,state_object_key=CASE WHEN ? THEN NULL ELSE state_object_key END,
        previous_state_object_key=CASE WHEN ? THEN NULL ELSE previous_state_object_key END,sync_status=CASE WHEN ? THEN 'none' ELSE sync_status END,
        sync_error=CASE WHEN ? THEN NULL ELSE sync_error END
        WHERE id=? AND user_id=? AND credential_version=?`)
        .bind(value.name,value.origin,value.username?value.username.slice(0,2)+'***':'未设置',secret,JSON.stringify(value.businessDomains),JSON.stringify(value.loginOrigins),next,
          Number(changed),Number(changed),Number(changed),Number(changed),Number(changed),Number(changed),Number(changed),row.id,c.get('userId'),body.expectedCredentialVersion),
      c.env.DB.prepare(`INSERT OR IGNORE INTO account_credential_versions(account_id,version,secret,login_origins,created_at)
        SELECT id,credential_version,secret,login_origins,? FROM accounts WHERE id=? AND credential_version=? AND secret=?`).bind(at,row.id,next,secret),
    ]);
    if(!writes[0].meta.changes)throw Error('ACCOUNT_VERSION_CONFLICT');
    return c.json({account:accountSummary(await ownAccount(c.env,c.get('userId'),row.id))});
  })
.post('/accounts/:id/clear-state',validator('json',(value:z.input<typeof accountStateClearInput>)=>accountStateClearInput.parse(value)), async c=>{
    const {expectedStateEpoch}=c.req.valid('json');
    const row=await ownAccount(c.env,c.get('userId'),c.req.param('id'));
    const saved=await c.env.DB.prepare(`UPDATE accounts SET state_epoch=state_epoch+1,state_object_key=NULL,previous_state_object_key=NULL,
      sync_status='none',sync_error=NULL,login_reset=1 WHERE id=? AND user_id=? AND state_epoch=?`).bind(row.id,c.get('userId'),expectedStateEpoch).run();
    if(!saved.meta.changes)throw Error('ACCOUNT_VERSION_CONFLICT');
    return c.json({account:accountSummary(await ownAccount(c.env,c.get('userId'),row.id))});
  });
