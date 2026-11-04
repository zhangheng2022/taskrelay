import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from 'better-auth/crypto';
import { app } from '../apps/cloud/src/index';
import type { AppEnv } from '../apps/cloud/src/env';
import { testDb,task,insertTask } from './helpers';
import { claim,enqueue,finish,getRun } from '../apps/cloud/src/store';
import { quotaDay,quotaReset,reserve } from '../apps/cloud/src/tenancy';
import { hash } from '../packages/contracts/src/security';
import { seal } from '../apps/cloud/src/crypto';

async function fixture() {
 const {db,sql}=testDb();
 const env={DB:db,DEV_MODE:'0',AUTH_BASE_URL:'http://localhost',AUTH_SECRET:'multiuser-test-secret-at-least-32-characters',OWNER_EMAIL:'owner@example.com',MASTER_KEY:Buffer.alloc(32,1).toString('base64'),REGISTRATION_OPEN:'0'} as unknown as AppEnv;
 const password='fixture-long-password';
 const digest=await hashPassword(password);
 async function request(path:string,cookie='',body?:unknown,method=body?'POST':'GET') {
  return app.request('http://localhost'+path,{method,headers:{'Content-Type':'application/json',Origin:'http://localhost',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)},env);
 }
 const cookies:Record<string,string>={};
 for(const [id,email] of [['alice','alice@example.com'],['bob','bob@example.com'],['owner','owner@example.com']]) {
  const at=Date.now();
  sql.prepare('INSERT INTO auth_user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run(id,id,email,at,at);
  sql.prepare("INSERT INTO auth_account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,'credential',?,?,?,?)").run(id,id,id,digest,at,at);
  const login=await request('/api/auth/sign-in/email','',{email,password});
  assert.equal(login.status,200,await login.clone().text());
  cookies[id]=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
  const me=await request('/api/user/me',cookies[id]);
  assert.equal(me.status,200,await me.clone().text());
 }
 for(const d of ['d1','d2']) sql.prepare('INSERT INTO devices(id,name,token_hash,protocol_version,last_seen) VALUES(?,?,?,3,?)').run(d,d,await hash((d==='d1'?'a':'b').repeat(64)),new Date().toISOString());
 async function ownedTask(user:string,id:string,accountId:string|null=null) {
  const t=await insertTask(db,task({id,accountId}));
  sql.prepare('UPDATE tasks SET user_id=? WHERE id=?').run(user,id);
  return t;
 }
 return {db,sql,env,request,cookies,ownedTask};
}

test('真实登录会话隔离任务、运行、对话、协助、证据和用量；设备不能管理用户',async()=>{
 const s=await fixture();
 const ta=await s.ownedTask('alice','ta'),tb=await s.ownedTask('bob','tb');
 const a=await enqueue(s.db,ta,'alice-key'),b=await enqueue(s.db,tb,'bob-key');
 s.sql.prepare("INSERT INTO artifacts(id,run_id,object_key,content_type,expires_at) VALUES('artifact_b',?,'private','image/png','2099-01-01')").run(b.id);
 for(const who of ['alice','owner']) {
  for(const path of [`/tasks/${tb.id}`,`/tasks/${tb.id}/conversation`,`/runs/${b.id}`,`/runs/${b.id}/usage`,`/artifacts/artifact_b`]) {
   assert.equal((await s.request('/api/user'+path,s.cookies[who])).status,404,path);
  }
 }
 const snapshot=await (await s.request('/api/user/snapshot',s.cookies.alice)).json() as any;
 assert.deepEqual(snapshot.tasks.map((x:any)=>x.id),[ta.id]);
 assert.deepEqual(snapshot.runs.map((x:any)=>x.id),[a.id]);
 assert.deepEqual(snapshot.devices,[]);
 assert.equal((await s.request('/api/admin/operations',s.cookies.alice)).status,403);
 assert.equal((await s.request('/api/admin/operations',s.cookies.owner)).status,200);
 for(const path of ['/api/user/snapshot','/api/admin/operations','/api/device/user/snapshot']) {
  const r=await app.request('http://localhost'+path,{headers:{"x-taskrelay-protocol":"3", Authorization:'Bearer '+'a'.repeat(64)}},s.env);
  assert.equal(r.status,403,path);
 }
});

test('两用户两设备公平领取，并发一，领取重试只记一次额度',async()=>{
 const s=await fixture();
 const ta=await s.ownedTask('alice','ta'),tb=await s.ownedTask('bob','tb');
 s.sql.prepare("UPDATE members SET last_claim_at='2026-01-01' WHERE id='alice'").run();
 await enqueue(s.db,ta,'a1'); await enqueue(s.db,ta,'a2'); await enqueue(s.db,tb,'b1');
 const first=(await claim(s.db,'d1','first'))!;
 assert.equal(first.userId,'bob');
 const second=(await claim(s.db,'d2','second'))!;
 assert.equal(second.userId,'alice');
 assert.equal((await claim(s.db,'d1','first'))?.id,first.id);
 assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM runs WHERE started_day IS NOT NULL").get()!.n,2);
 s.sql.prepare("UPDATE runs SET status='waiting_user' WHERE id=?").run(second.id);
 await finish(s.db,first,'succeeded',{summary:'done',evidence:[],outcome:'completed_now'});
 assert.equal(await claim(s.db,'d1','third'),null);
});

test('模型额度并发预占、全站上限与上海跨日，不因未知结果返还',async()=>{
 const s=await fixture();
 s.sql.prepare("UPDATE members SET daily_models=2 WHERE id='alice'").run();
 const attempts=await Promise.allSettled(Array.from({length:6},()=>reserve(s.env,'alice','model')));
 assert.equal(attempts.filter(x=>x.status==='fulfilled').length,2);
 s.sql.prepare("UPDATE settings SET value='2' WHERE key='globalDailyModels'").run();
 await assert.rejects(()=>reserve(s.env,'bob','model'),/MODEL_QUOTA_EXCEEDED/);
 s.sql.prepare("UPDATE quota_reservations SET day='2000-01-01'").run();
 await reserve(s.env,'bob','model');
 assert.equal(quotaDay(Date.parse('2026-11-03T15:59:59Z')),'2026-11-03');
 assert.equal(quotaDay(Date.parse('2026-11-03T16:00:00Z')),'2026-11-04');
 assert.equal(quotaReset(Date.parse('2026-11-03T15:59:59Z')),'2026-11-03T16:00:00.000Z');
});

test('修改密码的数据库提交同时撤销所有会话',async()=>{
 const s=await fixture();
 const r=await s.request('/api/auth/change-password',s.cookies.alice,{currentPassword:'fixture-long-password',newPassword:'replacement-long-password',revokeOtherSessions:true});
 assert.equal(r.status,200,await r.clone().text());
 assert.equal((await s.request('/api/user/me',s.cookies.alice)).status,401);
 assert.equal((await s.request('/api/user/me',s.cookies.bob)).status,200);
});

test('两用户使用同一幂等编号仍各自创建任务；账号、协助、证据和含用量报告互相隔离',async()=>{
 const s=await fixture();
 s.env.EVIDENCE_STORE={getByName:()=>({get:async()=>new Uint8Array([1,2,3]).buffer})} as any;
 s.sql.prepare('INSERT INTO model_profiles VALUES(?,1,?,?,?,?)').run('model_test',JSON.stringify({name:'shared',baseUrl:'https://provider.example/v1',model:'test',protocol:'chat',inputPrice:1,outputPrice:1}),await seal('key',s.env.MASTER_KEY,'model:model_test:1'),JSON.stringify({connection:true,tools:true,structured:'schema',vision:false,testedAt:null}),new Date().toISOString());
 async function draftBody(who:string,task:unknown,requestId:string) {
  const thread=await (await s.request('/api/user/threads',s.cookies[who],{kind:'compose',modelId:'model_test'})).json() as any;
  const saved=await (await s.request('/api/user/threads/'+thread.id+'/draft',s.cookies[who],{expectedVersion:thread.version,draft:task},'PUT')).json() as any;
  return {requestId,task,threadId:saved.id,draftVersion:saved.version};
 }
 const accounts:Record<string,string>={},tasks:Record<string,string>={},runs:Record<string,string>={};
 for(const who of ['alice','bob']) {
  const created=await s.request('/api/user/accounts',s.cookies[who],{name:who,origin:'https://example.com',username:'fixture',password:'fixture'});
  assert.equal(created.status,201); accounts[who]=(await created.json() as any).id;
 }
 const input=(accountId:string)=>({title:'read',goal:'Read status',entryUrl:'https://example.com/',allowedOrigins:['https://example.com'],accountId,modelId:'model_test',allowedActions:['read','navigate'],verification:{kind:'text_present',value:'Example Domain'},schedule:{kind:'manual'}});
 for(const who of ['alice','bob']) {
  const other=who==='alice'?'bob':'alice';
  const denied=await s.request('/api/user/tasks',s.cookies[who],await draftBody(who,input(accounts[other]),'foreign_account'));
  assert.equal(denied.status,400);assert.equal((await denied.json() as any).error,'ACCOUNT_ORIGIN_MISMATCH');
  const body=await draftBody(who,input(accounts[who]),'same_request_id');
  const created=await s.request('/api/user/tasks',s.cookies[who],body);
  assert.equal(created.status,201,await created.clone().text());tasks[who]=(await created.json() as any).id;
  const retry=await s.request('/api/user/tasks',s.cookies[who],body);
  assert.equal((await retry.json() as any).id,tasks[who]);
  const snapshot=await (await s.request('/api/user/snapshot',s.cookies[who])).json() as any;
  assert.deepEqual(snapshot.accounts.map((a:any)=>a.id),[accounts[who]]);
  runs[who]=snapshot.runs[0].id;
  s.sql.prepare('INSERT INTO artifacts(id,run_id,object_key,content_type,expires_at) VALUES(?,?,?,?,?)').run('image_'+who,runs[who],who,'image/png','2099-01-01');
  s.sql.prepare("INSERT INTO challenges(id,run_id,lease_epoch,version,step_id,kind,instruction,status,expires_at) VALUES(?,?,1,1,'step','code','Code','pending','2099-01-01')").run('challenge_'+who,runs[who]);
  s.sql.prepare('INSERT INTO model_usage(id,run_id,model_id,model_version,input_tokens,output_tokens,at,user_id) VALUES(?,?,?,1,10,20,?,?)').run('usage_'+who,runs[who],'model_test',new Date().toISOString(),who);
 }
 assert.notEqual(tasks.alice,tasks.bob);
 for(const who of ['alice','bob']) {
  const other=who==='alice'?'bob':'alice',cookie=s.cookies[who];
  assert.equal((await s.request('/api/user/threads',cookie,{kind:'chat',taskId:tasks[who],modelId:'model_test'})).status,200);
  assert.equal((await s.request('/api/user/artifacts/image_'+who,cookie)).status,200);
  const report=await s.request('/api/user/runs/'+runs[who],cookie);
  assert.equal(report.status,200);assert.equal((await report.json() as any).usage.length,1);
  for(const [path,body] of [[`/tasks/${tasks[other]}/chat`,undefined],[`/runs/${runs[other]}`,undefined],[`/runs/${runs[other]}/cancel`,{}],[`/challenges/challenge_${other}/reply`,{}],[`/artifacts/image_${other}`,undefined]] as const) {
   assert.equal((await s.request('/api/user'+path,cookie,body)).status,404,path);
  }
 }
});
