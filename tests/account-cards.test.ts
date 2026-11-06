import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {app} from '../apps/cloud/src/index';
import type {AppEnv} from '../apps/cloud/src/env';
import {claim,enqueue,getRun,now} from '../apps/cloud/src/store';
import {PROTOCOL_VERSION} from '../packages/contracts/src/index';
import {hash} from '../packages/contracts/src/security';
import {testDb,insertTask,task} from './helpers';
import {cleanupAccountCards,pendingCardOrigins} from '../apps/cloud/src/account-cards';
import {readRunCredentials} from '../apps/cloud/src/accounts';

const input={name:'测试账号',origin:'https://shop.example.com',businessDomains:['shop.example.com'],loginOrigins:['https://login.example.com'],username:'person@example.com',password:'fixture-secret-123'};
async function fixture(t:TestContext,bound=false){
  const {db,sql}=testDb();t.after(()=>sql.close());
  const env={DB:db,MASTER_KEY:Buffer.alloc(32,7).toString('base64'),DEV_MODE:'1'} as AppEnv;
  const token='a'.repeat(64);
  await db.prepare('INSERT INTO devices(id,name,token_hash,protocol_version) VALUES(?,?,?,?)').bind('device_cards','fixture',await hash(token),PROTOCOL_VERSION).run();
  const request=async(path:string,body?:unknown,method=body===undefined?'GET':'POST')=>{
    const response=await app.request('http://localhost'+path,{method,headers:{'content-type':'application/json',...(path.startsWith('/api/runner/')?{authorization:`Bearer ${token}`,'x-taskrelay-protocol':String(PROTOCOL_VERSION)}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})},env);
    return {status:response.status,data:await response.json() as Record<string,any>};
  };
  const accountId=bound?(await request('/api/user/accounts',input)).data.id:null;
  const definition=await insertTask(db,task({accountId,entryUrl:input.origin}));
  await db.prepare(`INSERT INTO ai_threads(id,user_id,task_id,kind,model_id,model_version,created_at,updated_at) VALUES('thread_cards','legacy_owner',?,'chat','model_test',1,?,?)`).bind(definition.id,now(),now()).run();
  await enqueue(db,definition,'card_fixture');
  const run=(await claim(db,'device_cards','card_claim'))!;assert.ok(run);
  const offer=async(kind:'save'|'update'='save',suffix='one')=>request(`/api/runner/runs/${run.id}/account-card`,{epoch:run.leaseEpoch,requestId:`offer_${suffix}`,kind,...(kind==='save'?{...input,verified:true,evidence:'已提交此凭据，页面显示当前账号主页',observedOrigin:'https://login.example.com'}:{accountId,origin:'https://login.example.com',evidence:'页面明确提示刚提交的密码不正确'})});
  return {db,sql,env,request,run,accountId,offer};
}

test('登录保存卡片由本人确认；密文草稿、引用消息和临时环境转正',async t=>{
  const s=await fixture(t),offered=await s.offer();assert.equal(offered.status,200,JSON.stringify(offered.data));
  const cardId=offered.data.cardId;
  assert.deepEqual(await pendingCardOrigins(s.env,s.run.id),[input.origin,'https://login.example.com']);
  const raw=s.sql.prepare('SELECT * FROM account_cards').get()!;
  assert.ok(raw.secret);assert.ok(!JSON.stringify(raw).includes(input.password));
  const messages=s.sql.prepare('SELECT content,parts FROM ai_messages').all();
  assert.equal(messages.length,1);assert.ok(!JSON.stringify(messages).includes(input.password));
  assert.deepEqual(JSON.parse(String(messages[0].parts)),[{type:'account-card',cardId}]);
  assert.equal((await s.request(`/api/user/account-cards/${cardId}`)).data.password,input.password);
  const saved=await s.request(`/api/user/account-cards/${cardId}/confirm`,input);assert.equal(saved.status,200,JSON.stringify(saved.data));
  const binding=s.sql.prepare('SELECT account_id,account_key,profile_id FROM runs WHERE id=?').get(s.run.id)!;
  assert.equal(binding.account_id,saved.data.accountId);assert.equal(binding.account_key,saved.data.accountId);
  const account=s.sql.prepare('SELECT * FROM accounts WHERE id=?').get(saved.data.accountId)!;
  assert.equal(account.profile_id,s.run.profileId);assert.equal(account.credential_status,'valid');
  assert.equal(account.last_device_id,s.run.deviceId,'已验证登录不必等待快照成功才记住设备');
  assert.equal(s.sql.prepare('SELECT account_key FROM account_locks WHERE run_id=?').get(s.run.id)!.account_key,saved.data.accountId);
  assert.equal(s.sql.prepare('SELECT secret FROM account_cards WHERE id=?').get(cardId)!.secret,null);
  assert.deepEqual((await s.request(`/api/user/account-cards/${cardId}/confirm`,input)).data,saved.data);
  assert.equal((await s.request(`/api/user/account-cards/${cardId}/confirm`,{...input,password:'different'})).status,409);
  const credentials=await readRunCredentials(s.env,await getRun(s.db,s.run.id),'https://login.example.com/path');
  assert.equal(credentials.account.password,input.password);
  await assert.rejects(readRunCredentials(s.env,await getRun(s.db,s.run.id),'https://login.example.com.attacker.com'),/CREDENTIAL_ORIGIN_MISMATCH/);
});

test('修改卡片绑定账号版本和本次执行，保存后同代继续；旧卡片不能覆盖新设置',async t=>{
  const s=await fixture(t,true),offered=await s.offer('update');assert.equal(offered.status,200,JSON.stringify(offered.data));
  assert.equal(s.sql.prepare('SELECT status FROM runs WHERE id=?').get(s.run.id)!.status,'waiting_user');
  const saved=await s.request(`/api/user/account-cards/${offered.data.cardId}/confirm`,{...input,password:'corrected-secret'});
  assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(saved.data.resumed,true);
  const current=await getRun(s.db,s.run.id);assert.equal(current.status,'running');assert.equal(current.credentialVersion,2);
  assert.equal((await readRunCredentials(s.env,current,'https://login.example.com')).account.password,'corrected-secret');
  assert.equal(s.sql.prepare('SELECT credential_status FROM accounts WHERE id=?').get(s.accountId)!.credential_status,'unverified');
  const again=await s.offer('update','again');assert.equal(again.status,200);
  const edit=await s.request(`/api/user/accounts/${s.accountId}`,{expectedCredentialVersion:2,password:'settings-secret'},'PATCH');assert.equal(edit.status,200);
  assert.equal((await s.request(`/api/user/account-cards/${again.data.cardId}/confirm`,input)).status,409);
  // 设置修改供下一轮使用，当前执行仍能读取它固定的旧凭据版本。
  assert.equal((await readRunCredentials(s.env,current,'https://login.example.com')).account.password,'corrected-secret');
});

test('编辑已验证卡片的凭据不会继承验证和当前环境；晚确认不重新启动任务',async t=>{
  const s=await fixture(t),offered=await s.offer();assert.equal(offered.status,200);
  const saved=await s.request(`/api/user/account-cards/${offered.data.cardId}/confirm`,{...input,password:'edited-secret'});
  assert.equal(saved.status,200);const account=s.sql.prepare('SELECT * FROM accounts WHERE id=?').get(saved.data.accountId)!;
  assert.equal(account.credential_status,'unverified');assert.notEqual(account.profile_id,s.run.profileId);
  assert.equal(account.last_device_id,null,'修改过凭据的卡片不能把来源设备当作已验证设备');
  assert.equal(s.sql.prepare('SELECT account_id FROM runs WHERE id=?').get(s.run.id)!.account_id,null);
  const late=await s.offer('save','late');assert.equal(late.status,200);
  s.sql.prepare("UPDATE runs SET status='succeeded',lease_expires_at=NULL,cleanup_pending=0,cleanup_confirmed=1 WHERE id=?").run(s.run.id);
  const lateSaved=await s.request(`/api/user/account-cards/${late.data.cardId}/confirm`,input);
  assert.equal(lateSaved.status,200,JSON.stringify(lateSaved.data));assert.equal(lateSaved.data.resumed,false);
  assert.equal(s.sql.prepare('SELECT status FROM runs WHERE id=?').get(s.run.id)!.status,'succeeded');
  assert.equal(s.sql.prepare('SELECT last_device_id FROM accounts WHERE id=?').get(lateSaved.data.accountId)!.last_device_id,s.run.deviceId);
});

test('关闭、撤回、过期和跨用户访问均使卡片不可使用；草稿可回收',async t=>{
  const s=await fixture(t),offered=await s.offer();assert.equal(offered.status,200);
  const id=offered.data.cardId;
  s.sql.prepare("INSERT INTO members(id) VALUES('other_user')").run();
  s.sql.prepare("UPDATE account_cards SET user_id='other_user' WHERE id=?").run(id);
  assert.equal((await s.request(`/api/user/account-cards/${id}`)).status,404);
  s.sql.prepare("UPDATE account_cards SET user_id='legacy_owner',expires_at='2000-01-01' WHERE id=?").run(id);
  await cleanupAccountCards(s.env);
  assert.equal(s.sql.prepare('SELECT status FROM account_cards WHERE id=?').get(id)!.status,'expired');
  assert.equal((await s.request(`/api/user/account-cards/${id}/confirm`,input)).status,409);
  const second=await s.offer('save','second');assert.equal(second.status,200);
  s.sql.prepare("UPDATE ai_threads SET closed=1 WHERE id='thread_cards'").run();
  assert.equal(s.sql.prepare('SELECT secret FROM account_cards WHERE id=?').get(second.data.cardId)!.secret,null);
  assert.equal((await s.request(`/api/user/account-cards/${second.data.cardId}/confirm`,input)).status,404);
});

test('账号设置精确域名、同域多账号、名称修改和清除状态版本',async t=>{
  const s=await fixture(t,true);
  assert.equal((await s.request('/api/user/accounts',{...input,username:'second@example.com'})).status,201);
  assert.equal((await s.request('/api/user/accounts',{...input,businessDomains:['*.example.com']})).status,400);
  const rename=await s.request(`/api/user/accounts/${s.accountId}`,{expectedCredentialVersion:1,name:'新名称'},'PATCH');
  assert.equal(rename.status,200);assert.equal(rename.data.account.credentialVersion,1);assert.equal(rename.data.account.stateEpoch,1);
  const clear=await s.request(`/api/user/accounts/${s.accountId}/clear-state`,{expectedStateEpoch:1});
  assert.equal(clear.status,200);assert.equal(clear.data.account.stateEpoch,2);
  assert.equal((await s.request(`/api/user/accounts/${s.accountId}/clear-state`,{expectedStateEpoch:1})).status,409);
  const snapshot=await s.request('/api/user/snapshot');assert.equal(snapshot.status,200);
  assert.ok(!JSON.stringify(snapshot.data.accounts).includes(input.password));
});

test('修改卡片等待时原聊天补充会使旧卡片失效，并恢复本次执行处理新指令',async t=>{
  const s=await fixture(t,true),offered=await s.offer('update');assert.equal(offered.status,200);
  const message=await s.request('/api/user/threads/thread_cards/messages',{requestId:'new_direction',content:'先不要登录，继续查看公开页面。'});
  assert.equal(message.status,202,JSON.stringify(message.data));
  // 即使确认按钮的请求抢在执行器下一次轮询前到达，也不能恢复被新指令替换的等待。
  assert.equal((await s.request(`/api/user/account-cards/${offered.data.cardId}/confirm`,input)).status,409);
  assert.equal(s.sql.prepare('SELECT credential_version FROM accounts WHERE id=?').get(s.accountId)!.credential_version,1);
  const status=await s.request(`/api/runner/runs/${s.run.id}/account-card-status`,{epoch:s.run.leaseEpoch,cardId:offered.data.cardId,afterUserSeq:0});
  assert.equal(status.status,200);assert.equal(status.data.status,'dismissed');
  assert.equal(s.sql.prepare('SELECT status FROM runs WHERE id=?').get(s.run.id)!.status,'running');
  assert.equal(s.sql.prepare('SELECT secret FROM account_cards WHERE id=?').get(offered.data.cardId)!.secret,null);
  assert.equal((await s.request(`/api/user/account-cards/${offered.data.cardId}/confirm`,input)).status,409);
});

test('SSO跳回业务域后可保存已访问的登录域；未访问建议域不进入临时快照',async t=>{
  const s=await fixture(t);
  const offered=await s.request(`/api/runner/runs/${s.run.id}/account-card`,{epoch:s.run.leaseEpoch,requestId:'sso_return',kind:'save',...input,
    loginOrigins:[...input.loginOrigins,'https://unvisited.example.org'],verified:true,evidence:'已登录并跳回业务页面',observedOrigin:input.origin,
    observedOrigins:[input.origin,'https://login.example.com','https://other.example.org']});
  assert.equal(offered.status,200,JSON.stringify(offered.data));
  assert.deepEqual(await pendingCardOrigins(s.env,s.run.id),[input.origin,'https://login.example.com']);
});

test('同一卡片并发确认只创建一个账号，两个响应返回同一个已提交身份',async t=>{
  const s=await fixture(t),offered=await s.offer(),before=Number(s.sql.prepare('SELECT COUNT(*) n FROM accounts').get()!.n);
  assert.equal(offered.status,200);
  const responses=await Promise.all([s.request(`/api/user/account-cards/${offered.data.cardId}/confirm`,input),s.request(`/api/user/account-cards/${offered.data.cardId}/confirm`,input)]);
  assert.equal(responses[0].status,200);assert.equal(responses[1].status,200);
  assert.equal(responses[0].data.accountId,responses[1].data.accountId);
  assert.equal(Number(s.sql.prepare('SELECT COUNT(*) n FROM accounts').get()!.n),before+1);
});

test('候选快照关联故障不把已经提交的账号确认报告为保存失败',async t=>{
  const s=await fixture(t),offered=await s.offer();assert.equal(offered.status,200);
  const prepare=s.db.prepare.bind(s.db);
  t.mock.method(s.db,'prepare',(query:string)=>{
    if(query.startsWith('UPDATE browser_state_candidates SET account_id='))throw Error('DB_UNAVAILABLE');
    return prepare(query);
  });
  const saved=await s.request(`/api/user/account-cards/${offered.data.cardId}/confirm`,input);
  assert.equal(saved.status,200);assert.equal(saved.data.status,'saved');
  assert.equal(s.sql.prepare('SELECT sync_status FROM accounts WHERE id=?').get(saved.data.accountId)!.sync_status,'failed');
  assert.equal(s.sql.prepare('SELECT sync_error FROM accounts WHERE id=?').get(saved.data.accountId)!.sync_error,'SYNC_FAILED');
  assert.equal(s.sql.prepare('SELECT last_device_id FROM accounts WHERE id=?').get(saved.data.accountId)!.last_device_id,s.run.deviceId);
});

test('当前账号凭据验证更新优先设备；状态版本改变或运行绑定丢失不能回写',async t=>{
  const s=await fixture(t,true);
  s.sql.prepare("INSERT INTO devices(id,name,token_hash,protocol_version) VALUES('old_device','old','old_device_hash',?)").run(PROTOCOL_VERSION);
  s.sql.prepare("UPDATE accounts SET last_device_id='old_device' WHERE id=?").run(s.accountId);
  const verify=()=>s.request(`/api/runner/runs/${s.run.id}/account-status`,{epoch:s.run.leaseEpoch,accountId:s.accountId,credentialVersion:1,origin:input.origin,evidence:'实际提交凭据并跳回账号主页',status:'valid'});
  assert.equal((await verify()).status,200);
  assert.equal(s.sql.prepare('SELECT last_device_id FROM accounts WHERE id=?').get(s.accountId)!.last_device_id,s.run.deviceId);
  s.sql.prepare("UPDATE accounts SET last_device_id='old_device' WHERE id=?").run(s.accountId);
  const clear=await s.request(`/api/user/accounts/${s.accountId}/clear-state`,{expectedStateEpoch:1});assert.equal(clear.status,200);
  assert.equal((await verify()).data.error,'ACCOUNT_VERSION_CONFLICT');
  assert.equal(s.sql.prepare('SELECT last_device_id FROM accounts WHERE id=?').get(s.accountId)!.last_device_id,'old_device');
  s.sql.prepare('UPDATE runs SET account_state_epoch=2 WHERE id=?').run(s.run.id);
  s.sql.prepare("UPDATE account_locks SET run_id='different_run' WHERE run_id=?").run(s.run.id);
  assert.equal((await verify()).data.error,'ACCOUNT_VERSION_CONFLICT');
  assert.equal(s.sql.prepare('SELECT last_device_id FROM accounts WHERE id=?').get(s.accountId)!.last_device_id,'old_device');
});

test('已确认卡片重复请求和过期运行代次不能覆盖新的设备偏好',async t=>{
  const s=await fixture(t),offered=await s.offer(),saved=await s.request(`/api/user/account-cards/${offered.data.cardId}/confirm`,input);
  assert.equal(saved.status,200);
  s.sql.prepare("UPDATE accounts SET last_device_id='newer_device' WHERE id=?").run(saved.data.accountId);
  const again=await s.request(`/api/user/account-cards/${offered.data.cardId}/confirm`,input);assert.equal(again.status,200);
  assert.equal(s.sql.prepare('SELECT last_device_id FROM accounts WHERE id=?').get(saved.data.accountId)!.last_device_id,'newer_device');
  const pending=await s.offer('save','stale_epoch');assert.equal(pending.status,200);
  s.sql.prepare("UPDATE runs SET lease_epoch=lease_epoch+1,status='succeeded',lease_expires_at=NULL WHERE id=?").run(s.run.id);
  const late=await s.request(`/api/user/account-cards/${pending.data.cardId}/confirm`,input);assert.equal(late.status,200);
  assert.equal(s.sql.prepare('SELECT last_device_id FROM accounts WHERE id=?').get(late.data.accountId)!.last_device_id,'newer_device');
});
