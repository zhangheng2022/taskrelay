import test from 'node:test';
import assert from 'node:assert/strict';
import {productionModelFixture} from './production-model-fixture';
import {app} from '../apps/cloud/src/index';
test('设备身份、协议和租约仍守卫新版模型入口',async t=>{
 const s=await productionModelFixture(t),path=`/api/runner/runs/${s.run.id}/model`;
 const missing=await app.request('http://127.0.0.1'+path,{method:'POST',headers:{'content-type':'application/json'},body:'{}'},s.env);assert.notEqual(missing.status,200);
 const stale=await s.request(path,{epoch:s.run.leaseEpoch-1,requestId:'stale',messages:[]});assert.notEqual(stale.status,200);assert.equal(s.jobs(),0);
});
test('相同工具请求不重复执行，不同业务记录不受选择器指纹拦截',async t=>{
 const s=await productionModelFixture(t),root=`/api/runner/runs/${s.run.id}/tool`;
 const b={epoch:s.run.leaseEpoch,id:'action_a',phase:'start',digest:'same-target'};
 assert.equal((await s.request(root,b)).data.execute,true);assert.equal((await s.request(root,b)).data.execute,false);
 await s.request(root,{...b,phase:'result',result:'已观察'});
 assert.equal((await s.request(root,{...b,id:'action_b'})).data.execute,true);
});
test('停止后不接受新的模型调用或工具动作',async t=>{
 const s=await productionModelFixture(t);await s.request(`/api/user/runs/${s.run.id}/cancel`,{});
 const r=await s.request(`/api/runner/runs/${s.run.id}/tool`,{epoch:s.run.leaseEpoch,id:'late',phase:'start',digest:'late'});
 assert.notEqual(r.status,200);assert.equal(s.sql.prepare('SELECT COUNT(*) n FROM actions WHERE run_id=?').get(s.run.id)!.n,0);
});
