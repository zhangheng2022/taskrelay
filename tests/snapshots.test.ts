import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {productionModelFixture} from './production-model-fixture';
import {app} from '../apps/cloud/src/index';
import {maskedScreenshot,redactSnapshot} from '../apps/desktop/src/executor/snapshots';

test('私有快照：生产上传校验租约、文件类型、归属及过期，重试不重复存储',async t=>{
 const s=await productionModelFixture(t),images=new Map<string,ArrayBuffer>();let puts=0;
 s.env.EVIDENCE_STORE={getByName:(key:string)=>({put:async(_key:string,bytes:ArrayBuffer)=>{puts++;images.set(key,bytes);},get:async()=>images.get(key)??null})} as any;
 const thread=(await s.request('/api/user/threads',{modelId:'model_test',taskId:s.run.taskId})).data;
 s.sql.prepare('UPDATE runs SET thread_id=? WHERE id=?').run(thread.id,s.run.id);
 const root='/api/runner/runs/'+s.run.id+'/snapshots';
 const body={epoch:s.run.leaseEpoch,captureId:crypto.randomUUID(),phase:'waiting',image:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')};
 assert.equal((await s.request(root,{...body,epoch:99})).data.error,'LEASE_EXPIRED');
 assert.equal((await s.request(root,{...body,image:'text'})).data.error,'PNG_REQUIRED');
 const saved=await s.request(root,body);assert.equal(saved.status,200,JSON.stringify(saved.data));
 assert.equal((await s.request(root,body)).data.id,saved.data.id);assert.equal(puts,1);
 const read=()=>app.request('http://127.0.0.1/api/user/artifacts/'+saved.data.id,{},s.env);
 assert.equal((await read()).status,200);
 s.sql.exec("INSERT INTO members(id,role) VALUES('other_snapshot','user')");
 s.sql.prepare("UPDATE runs SET user_id='other_snapshot' WHERE id=?").run(s.run.id);
 assert.equal((await read()).status,404);
 s.sql.prepare("UPDATE runs SET user_id='legacy_owner' WHERE id=?").run(s.run.id);
 s.sql.prepare("UPDATE artifacts SET expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(saved.data.id);
 assert.equal((await read()).status,404);assert.equal(s.jobs(),0);
});

for(const fails of [false,true])test('截图遮蔽不改变登录字段，成功或截图失败都清除临时覆盖层 '+fails,async()=>{
 const dom=new JSDOM('<body><img style="visibility:visible!important"><input value="synthetic-secret"><p>fixture@example.com</p><iframe></iframe></body>',{runScripts:'outside-only'});
 try{
  (dom.window as any).__name=(f:unknown)=>f;
  dom.window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,width:100,height:30,right:100,bottom:30,toJSON:()=>({})});
  dom.window.Range.prototype.getClientRects=(()=>[{left:0,top:50,width:100,height:20}]) as any;
  const page={evaluate:async(fn:Function,arg:unknown)=>dom.window.eval(`(${fn.toString()})(${JSON.stringify(arg)})`),screenshot:async()=>{
   assert.equal(dom.window.document.querySelectorAll('[data-taskrelay-mask]').length,2);
   assert.equal(dom.window.document.querySelector('img')!.style.visibility,'hidden');
   assert.equal(dom.window.document.querySelector('iframe')!.style.visibility,'hidden');
   assert.equal(dom.window.document.querySelector('input')!.value,'synthetic-secret');
   if(fails)throw Error('CAPTURE_FAILED');return new Uint8Array([137,80,78,71]);
  }};
  if(fails)await assert.rejects(maskedScreenshot(page as any,['synthetic-secret']),/CAPTURE_FAILED/);else await maskedScreenshot(page as any,['synthetic-secret']);
  assert.equal(dom.window.document.querySelectorAll('[data-taskrelay-mask]').length,0);
  assert.equal(dom.window.document.querySelectorAll('[data-taskrelay-media-mask]').length,0);
  assert.equal(dom.window.document.querySelector('img')!.style.visibility,'visible');
  assert.equal(dom.window.document.querySelector('img')!.style.getPropertyPriority('visibility'),'important');
  assert.equal(dom.window.document.querySelector('input')!.value,'synthetic-secret');
  assert.doesNotMatch(redactSnapshot('synthetic-secret fixture@example.com',['synthetic-secret']),/synthetic-secret|fixture@example/);
 }finally{dom.window.close();}
});
