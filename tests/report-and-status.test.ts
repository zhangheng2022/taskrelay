import test from 'node:test';
import assert from 'node:assert/strict';
import {productionModelFixture} from './production-model-fixture';
test('聊天图片长期保存，清空聊天同时删除图片，旧运行不会迁入新聊天',async t=>{
 const s=await productionModelFixture(t),images=new Map<string,ArrayBuffer>();
 s.env.EVIDENCE_STORE={getByName:(key:string)=>({put:async(_key:string,bytes:ArrayBuffer,expires:number|null)=>{assert.equal(expires,null);images.set(key,bytes);},get:async()=>images.get(key)??null,remove:async()=>{images.delete(key);}})} as any;
 const th=(await s.request('/api/user/threads',{modelId:'model_test',taskId:s.run.taskId})).data;s.sql.prepare('UPDATE runs SET thread_id=? WHERE id=?').run(th.id,s.run.id);
 const r=await s.request(`/api/runner/runs/${s.run.id}/snapshots`,{epoch:s.run.leaseEpoch,captureId:'shot_one',image:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')});assert.equal(r.status,200,JSON.stringify(r.data));
 assert.ok(Date.parse(String(s.sql.prepare('SELECT expires_at FROM artifacts').get()!.expires_at))>Date.now()+86400000);assert.equal(images.size,1);
 const deleted=await s.request(`/api/user/threads/${th.id}`,{},'DELETE');assert.equal(deleted.status,200);assert.equal(images.size,0);assert.equal(s.sql.prepare('SELECT COUNT(*) n FROM artifacts').get()!.n,0);
 await s.request('/api/user/threads',{modelId:'model_test',taskId:s.run.taskId});
 const message=await s.request(`/api/runner/runs/${s.run.id}/messages`,{epoch:s.run.leaseEpoch,id:'late_message',content:'不应回填'});assert.notEqual(message.status,200);
});
test('图片删除暂时失败后本人可以重试，删除标记阻止新写入',async t=>{
 const s=await productionModelFixture(t),th=(await s.request('/api/user/threads',{modelId:'model_test',taskId:s.run.taskId})).data;
 s.sql.prepare("INSERT INTO artifacts(id,run_id,object_key,content_type,expires_at,thread_id,persistent) VALUES('delete_retry',?,'image','image/png','9999-01-01',?,1)").run(s.run.id,th.id);
 let fails=true;s.env.EVIDENCE_STORE={getByName:()=>({remove:async()=>{if(fails)throw Error('STORAGE_OFFLINE');}})} as any;
 const accepted=await s.request(`/api/user/threads/${th.id}`,{},'DELETE');
 assert.equal(accepted.status,200);
 assert.equal(s.sql.prepare('SELECT error FROM history_cleanup_jobs WHERE id=?').get(accepted.data.job.id)?.error,'CLEANUP_RETRYING');
 assert.equal(s.sql.prepare('SELECT deleted FROM ai_threads WHERE id=?').get(th.id)!.deleted,1);
 fails=false;assert.equal((await s.request(`/api/user/threads/${th.id}`,{},'DELETE')).status,200);
 assert.equal(s.sql.prepare('SELECT COUNT(*) n FROM artifacts WHERE thread_id=?').get(th.id)!.n,0);
});
