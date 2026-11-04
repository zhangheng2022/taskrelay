import test from 'node:test';
import assert from 'node:assert/strict';
import {productionModelFixture} from './production-model-fixture';
import {executeTurn} from '../apps/cloud/src/ai/conversations';
import {admit} from '../apps/cloud/src/free-budget';
import {retainHistory} from '../apps/cloud/src/ai/lifecycle';

test('异步提交原子保存待执行回合，唤醒丢失后仍可执行且同请求不重放',async t=>{
 const s=await productionModelFixture(t,'responses');
 s.env.AI_TURNS={getByName:()=>({enqueue:async()=>{throw Error('wake interrupted');}})} as any;
 const thread=(await s.request('/api/user/threads',{kind:'compose',modelId:'model_test'})).data;
 const body={requestId:'durable_async',expectedVersion:0,content:'只读查看 https://example.com/'};
 const queued=await s.request(`/api/user/threads/${thread.id}/messages`,body);
 assert.equal(queued.status,202);assert.equal(s.jobs(),0);
 const row=s.sql.prepare('SELECT * FROM ai_dispatch').get()!;
 assert.equal(row.turn_id,queued.data.turnId);assert.equal(row.owner,'legacy_owner');
 assert.equal((await s.request(`/api/user/threads/${thread.id}/messages`,body)).data.turnId,row.turn_id);
 s.replies(JSON.stringify({reply:'请补充判据',task:null,partial:'查看页面',missing:['判据']}));
 const done=await executeTurn({...s.env,requestUserId:'legacy_owner'},thread.id,String(row.turn_id),'chat');
 assert.equal(done.status,'done');assert.equal(s.jobs(),1);
 await assert.rejects(executeTurn({...s.env,requestUserId:'legacy_owner'},thread.id,String(row.turn_id),'chat'),/TURN_STALE/);
 assert.equal(s.jobs(),1);
});

test('已删除异步会话不能执行；免费额度超限拒绝接收新回合',async t=>{
 const s=await productionModelFixture(t);
 s.env.AI_TURNS={getByName:()=>({enqueue:async()=>{}})} as any;
 const thread=(await s.request('/api/user/threads',{kind:'compose',modelId:'model_test'})).data;
 const queued=await s.request(`/api/user/threads/${thread.id}/messages`,{requestId:'cancel_async',expectedVersion:0,content:'https://example.com/'});
 await s.request(`/api/user/threads/${thread.id}`,{},'DELETE');
 await assert.rejects(executeTurn({...s.env,requestUserId:'legacy_owner'},thread.id,queued.data.turnId,'chat'),/TURN_STALE/);
 assert.equal(s.jobs(),0);
 const day=new Date().toISOString().slice(0,10);
 s.sql.prepare("INSERT OR REPLACE INTO platform_budget VALUES(?,'turn',50)").run(day);
 await assert.rejects(admit(s.env,'turn'),/PLATFORM_DAILY_LIMIT/);
 assert.equal(s.sql.prepare("SELECT n FROM platform_budget WHERE kind='turn'").get()!.n,50);
});

test('重复保留期清理不反复改写已删除会话版本',async t=>{
 const s=await productionModelFixture(t);
 const thread=(await s.request('/api/user/threads',{kind:'compose',modelId:'model_test'})).data;
 s.sql.prepare("UPDATE ai_threads SET updated_at='2000-01-01' WHERE id=?").run(thread.id);
 await retainHistory(s.env,'2020-01-01');
 const first=s.sql.prepare('SELECT version FROM ai_threads WHERE id=?').get(thread.id)!.version;
 await retainHistory(s.env,'2020-01-01');
 assert.equal(s.sql.prepare('SELECT version FROM ai_threads WHERE id=?').get(thread.id)!.version,first);
});
