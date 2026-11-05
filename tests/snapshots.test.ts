import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {productionModelFixture} from './production-model-fixture';
import {app} from '../apps/cloud/src/index';
import {maskedScreenshot,redactSnapshot,loadingFacts} from '../apps/desktop/src/executor/snapshots';

test('业务进度条不表示页面加载，显式 aria-busy 作为独立现场事实',async()=>{
 const dom=new JSDOM('<body><div role="progressbar" aria-valuenow="5931" aria-valuemax="10000"></div></body>',{runScripts:'outside-only'});
 try{
  const page={evaluate:async(fn:Function)=>dom.window.eval(`(${fn.toString()})()`)};
  const first=await loadingFacts(page as any);assert.equal(first.busy,false);assert.equal(first.progressBars,1);
  dom.window.document.body.setAttribute('aria-busy','true');assert.equal((await loadingFacts(page as any)).busy,true);
 }finally{dom.window.close();}
});
import sharp from 'sharp';

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
   assert.equal(dom.window.document.querySelectorAll('[data-taskrelay-mask]').length,1);
   assert.equal(dom.window.document.querySelector('img')!.style.visibility,'hidden');
   assert.equal(dom.window.document.querySelector('iframe')!.style.visibility,'hidden');
   assert.equal(dom.window.document.querySelector('input')!.value,'synthetic-secret');
   if(fails)throw Error('CAPTURE_FAILED');return sharp({create:{width:1024,height:768,channels:4,background:'#fff'}}).png().toBuffer();
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

test('不可信页面无法通过截图读取其他站点秘密；敏感文字在本地像素中遮蔽',async()=>{
 const dom=new JSDOM('<body><p>visible-secret</p><p>ordinary text</p></body>',{url:'https://other.example',runScripts:'outside-only'});
 try{
  (dom.window as any).__name=(f:unknown)=>f;
  dom.window.eval(`window.captured=[];const original=Array.prototype.some;Array.prototype.some=function(...args){window.captured.push(...this);return original.apply(this,args);};`);
  dom.window.Range.prototype.getClientRects=function(this:Range){return [{left:10,top:this.startContainer.textContent==='visible-secret'?10:60,width:100,height:20}];} as any;
  const inputs:string[]=[];
  const page={evaluate:async(fn:Function,arg:unknown)=>{
   inputs.push(fn.toString()+JSON.stringify(arg));
   return dom.window.eval(`(${fn.toString()})(${JSON.stringify(arg)})`);
  },screenshot:async()=>sharp({create:{width:1024,height:768,channels:4,background:'#fff'}}).png().toBuffer()};
  const image=await maskedScreenshot(page as any,['visible-secret','other-site-password','001234']);
  assert.doesNotMatch(inputs.join('\n'),/visible-secret|other-site-password|001234/);
  assert.deepEqual(Array.from((dom.window as any).captured),[]);
  const {data,info}=await sharp(Buffer.from(image,'base64')).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const pixel=(x:number,y:number)=>Array.from(data.subarray((y*info.width+x)*4,(y*info.width+x)*4+4));
  assert.deepEqual(pixel(20,20),[119,119,119,255]);
  assert.deepEqual(pixel(20,70),[255,255,255,255]);
  assert.equal(dom.window.document.querySelectorAll('[data-taskrelay-mask]').length,0);
 }finally{dom.window.close();}
});

test('相邻 span 分割秘密和邮箱仍遮蔽全部片段，跨块普通文本保持可见',async()=>{
 const dom=new JSDOM('<body><p><span>visible-</span><span>secret</span></p><p><span>fixture</span><span>@example</span><span>.com</span></p><p>ordinary text</p><p>visible-secret</p></body>',{runScripts:'outside-only'});
 try{
  (dom.window as any).__name=(f:unknown)=>f;
  const positions=new Map([['visible-',{left:10,top:10,width:50,height:20}],['secret',{left:60,top:10,width:50,height:20}],
   ['fixture',{left:10,top:40,width:40,height:20}],['@example',{left:50,top:40,width:40,height:20}],['.com',{left:90,top:40,width:30,height:20}],
   ['ordinary text',{left:10,top:70,width:100,height:20}],['visible-secret',{left:10,top:100,width:100,height:20}]]);
  dom.window.Range.prototype.getClientRects=function(this:Range){return [positions.get(this.startContainer.textContent!)!];} as any;
  const inputs:string[]=[];
  const page={evaluate:async(fn:Function,arg:unknown)=>{inputs.push(fn.toString()+JSON.stringify(arg));return dom.window.eval(`(${fn.toString()})(${JSON.stringify(arg)})`);},
   screenshot:async()=>sharp({create:{width:1024,height:768,channels:4,background:'#fff'}}).png().toBuffer()};
  const image=await maskedScreenshot(page as any,['visible-secret','invisible-other-site-secret']);
  const {data,info}=await sharp(Buffer.from(image,'base64')).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const pixel=(x:number,y:number)=>Array.from(data.subarray((y*info.width+x)*4,(y*info.width+x)*4+4));
  for(const [x,y] of [[20,20],[70,20],[20,50],[60,50],[100,50],[20,110]])assert.deepEqual(pixel(x,y),[119,119,119,255]);
  assert.deepEqual(pixel(20,80),[255,255,255,255]);
  assert.doesNotMatch(inputs.join('\n'),/visible-secret|invisible-other-site-secret|fixture@example\.com/);
  assert.equal(dom.window.document.querySelectorAll('[data-taskrelay-mask]').length,0);
 }finally{dom.window.close();}
});
