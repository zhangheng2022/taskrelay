import test from 'node:test';
import assert from 'node:assert/strict';
import {productionModelFixture} from './production-model-fixture';
import {executeTurn} from '../apps/cloud/src/ai/conversations';
import {retainHistory} from '../apps/cloud/src/ai/lifecycle';
import {invoke} from '../apps/cloud/src/models';
import {quotaDay} from '../apps/cloud/src/tenancy';

test('移除全站每日额度后，高用量账号仍可通过生产消息与模型入口，保留用量和幂等',async t=>{
 const s=await productionModelFixture(t,'responses');
 s.sql.prepare("UPDATE members SET daily_quota_paused=1 WHERE id='legacy_owner'").run();
 s.sql.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2500)
 INSERT INTO quota_reservations(id,user_id,day,kind,created_at)
 SELECT 'historical-'||x,'legacy_owner',?,'model',? FROM n`).run(quotaDay(),new Date().toISOString());
 assert.equal(s.sql.prepare("SELECT name FROM sqlite_master WHERE name='platform_budget'").get(),undefined);
 assert.equal(s.sql.prepare("SELECT value FROM settings WHERE key='globalDailyModels'").get(),undefined);
 s.replies('budget-free');
 const answer=await invoke({...s.env,requestUserId:'legacy_owner'},'model_test',1,{messages:[{role:'user',content:'read only fixture'}]},undefined,'after-global-cap');
 assert.equal(answer.text,'budget-free');
 assert.equal((await invoke({...s.env,requestUserId:'legacy_owner'},'model_test',1,{messages:[{role:'user',content:'read only fixture'}]},undefined,'after-global-cap')).text,'budget-free');
 assert.equal(s.jobs(),1);
 s.env.AI_TURNS={getByName:()=>({enqueue:async()=>{}})} as any;
 const thread=(await s.request('/api/user/threads',{modelId:'model_test'})).data;
 const body={requestId:'uncapped-turn',content:'只读查看 https://example.com/'};
 const first=await s.request(`/api/user/threads/${thread.id}/messages`,body);
 assert.equal(first.status,202);
 assert.equal((await s.request(`/api/user/threads/${thread.id}/messages`,body)).data.turnId,first.data.turnId);
 assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM quota_reservations WHERE kind='model'").get()!.n,2501);
});

test('异步提交原子保存待执行回合，唤醒丢失后仍可执行且同请求不重放',async t=>{
 const s=await productionModelFixture(t,'responses');
 s.env.AI_TURNS={getByName:()=>({enqueue:async()=>{throw Error('wake interrupted');}})} as any;
 const thread=(await s.request('/api/user/threads',{modelId:'model_test'})).data;
 const body={requestId:'durable_async',content:'只读查看 https://example.com/'};
 const queued=await s.request(`/api/user/threads/${thread.id}/messages`,body);
 assert.equal(queued.status,202);assert.equal(s.jobs(),0);
 const row=s.sql.prepare('SELECT * FROM ai_dispatch').get()!;
 assert.equal(row.turn_id,queued.data.turnId);assert.equal(row.owner,'legacy_owner');
 assert.equal((await s.request(`/api/user/threads/${thread.id}/messages`,body)).data.turnId,row.turn_id);
 s.replies(JSON.stringify({reply:'请补充判据',task:null,partial:'查看页面',missing:['判据']}));
 const done=await executeTurn({...s.env,requestUserId:'legacy_owner'},thread.id,String(row.turn_id));
 assert.equal(done.status,'done');assert.equal(s.jobs(),1);
 await assert.rejects(executeTurn({...s.env,requestUserId:'legacy_owner'},thread.id,String(row.turn_id)),/TURN_STALE/);
 assert.equal(s.jobs(),1);
});

test('已删除异步会话不能执行',async t=>{
 const s=await productionModelFixture(t);
 s.env.AI_TURNS={getByName:()=>({enqueue:async()=>{}})} as any;
 const thread=(await s.request('/api/user/threads',{modelId:'model_test'})).data;
 const queued=await s.request(`/api/user/threads/${thread.id}/messages`,{requestId:'cancel_async',content:'https://example.com/'});
 await s.request(`/api/user/threads/${thread.id}`,{},'DELETE');
 await assert.rejects(executeTurn({...s.env,requestUserId:'legacy_owner'},thread.id,queued.data.turnId),/TURN_STALE/);
 assert.equal(s.jobs(),0);

});

test('重复保留期清理不反复改写已删除会话版本',async t=>{
 const s=await productionModelFixture(t);
 const thread=(await s.request('/api/user/threads',{modelId:'model_test'})).data;
 s.sql.prepare("UPDATE ai_threads SET updated_at='2000-01-01' WHERE id=?").run(thread.id);
 await retainHistory(s.env,'2020-01-01');
 const first=s.sql.prepare('SELECT version FROM ai_threads WHERE id=?').get(thread.id)!.version;
 await retainHistory(s.env,'2020-01-01');
 assert.equal(s.sql.prepare('SELECT version FROM ai_threads WHERE id=?').get(thread.id)!.version,first);
});
