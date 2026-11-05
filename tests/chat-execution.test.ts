import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {execute,type RuntimePort} from '../apps/desktop/src/executor/runtime';
import {productionModelFixture} from './production-model-fixture';
const tool=(name:string,args:Record<string,unknown>)=>JSON.stringify({__model:{text:'',calls:[{id:crypto.randomUUID(),name,arguments:JSON.stringify(args)}]}});
test('完整生产链：执行器模型转发、多项目操作、云端求助、原聊天回复和最终总结',async t=>{
 const s=await productionModelFixture(t,'responses'),thread=(await s.request('/api/user/threads',{modelId:'model_test',taskId:s.run.taskId})).data;
 s.sql.prepare('UPDATE runs SET thread_id=? WHERE id=?').run(thread.id,s.run.id);
 const images=new Map<string,ArrayBuffer>();
 s.env.EVIDENCE_STORE={getByName:(key:string)=>({put:async(_key:string,bytes:ArrayBuffer)=>images.set(key,bytes),get:async()=>images.get(key)??null})} as any;
 const dom=new JSDOM('<body><button id="one">处理第一项</button><input id="answer"><button id="two">处理第二项</button><p id="result">待处理</p></body>',{url:'https://example.com/',runScripts:'outside-only'});t.after(()=>dom.window.close());
 (dom.window as any).__name=(fn:unknown)=>fn;
 Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 dom.window.HTMLElement.prototype.getClientRects=(()=>[{width:100,height:20}]) as any;
 let first=0,second=0;let sdkModel:any;
 const page={snapshot:async()=>({formattedTree:dom.window.document.body.textContent,xpathMap:{},urlMap:{}}),url:async()=>dom.window.location.href,goto:async()=>{},screenshot:async()=>Buffer.from([137,80,78,71,13,10,26,10]),evaluate:async(fn:Function,arg?:unknown)=>dom.window.eval(`(${fn.toString()})(${JSON.stringify(arg)??'undefined'})`),locator:(selector:string)=>({
   click:async()=>{if(selector==='#one')first++;if(selector==='#two')second++;dom.window.document.querySelector('#result')!.textContent=`已处理 ${first+second} 项`;},
   fill:async(value:string)=>{(dom.window.document.querySelector(selector) as HTMLInputElement).value=value;},inputValue:async()=>(dom.window.document.querySelector(selector) as HTMLInputElement).value,
 })};
 const original='本次测试码是 0012Ab!，请继续处理第二项。';
 const steps=[tool('act',{instruction:'处理第一项'}),tool('ask',{message:'需要测试确认码'}),tool('act',{instruction:'根据用户原始回复填写确认码'}),tool('act',{instruction:'处理第二项'}),'两项均已处理，页面已显示完成。'];
 s.respond(body=>{
  const text=JSON.stringify(body);
  if(text.includes('Stagehand-SDK fixture')){if(text.includes('根据用户原始回复填写确认码'))assert.ok(text.includes(original));return JSON.stringify({done:true});}
  if(text.includes('askUser')){
   const input=s.sql.prepare("SELECT id FROM ai_messages WHERE role='user' AND private_content IS NOT NULL ORDER BY seq DESC LIMIT 1").get();
   return JSON.stringify(input?{message:'用户已提供完整回复，请自行理解并继续。',askUser:false,accountId:null}:{message:'请输入本次测试确认码。',askUser:true,accountId:null});
  }
  return steps.shift()!;
 });
 let replied=false;
 const port:RuntimePort={cancelled:()=>false,checkpoint:async()=>{},rpc:async<T>(path:string,body:any)=>{
  if(path==='local:browser')return {cdpUrl:'fixture'} as T;
  const response=await s.request(path,body);if(response.status!==200)throw Error(response.data.error??'REQUEST_FAILED');
  if(path.endsWith('/help')&&!response.data.ready&&!replied){
   replied=true;await s.request(`/api/user/threads/${thread.id}/messages`,{requestId:'verify',content:original});
  }
  return response.data as T;
 }};
 await execute(s.run,port,{loadSdk:async()=>({Stagehand:{create:async(options:any)=>{sdkModel=options.model;return {close:async()=>{},act:async(instruction:string)=>{
  await sdkModel.generate({systemPrompt:'Stagehand-SDK fixture',messages:[{role:'user',content:{type:'text',text:instruction}}],responseFormat:{type:'json_schema',name:'Act',schema:{type:'object',properties:{done:{type:'boolean'}},required:['done']}}});
  if(instruction.includes('第一项'))await page.locator('#one').click();
  else if(instruction.includes('第二项'))await page.locator('#two').click();
  else await page.locator('#answer').fill('0012Ab!');
  return {data:{success:true,message:'实际完成当前操作',actions:[]}};
 }}}},localBrowser:{connect:async()=>({context:{setDomainPolicy:async()=>{},pages:async()=>[page]}})}} as any),startProxy:async()=>({port:1,close:async()=>{}}),delay:async()=>{}});
 assert.equal(first,1);assert.equal(second,1,JSON.stringify(s.sql.prepare('SELECT content,parts FROM ai_messages WHERE source=\'executor\'').all()));assert.equal((dom.window.document.querySelector('#answer') as HTMLInputElement).value,'0012Ab!');
 const saved=s.sql.prepare('SELECT status,result FROM runs WHERE id=?').get(s.run.id)!;assert.equal(saved.status,'succeeded',String(saved.result));
 const chat=(await s.request(`/api/user/threads/${thread.id}`,null,'GET')).data;
 assert.ok(chat.messages.some((m:any)=>m.source==='cloud'&&/确认码/.test(m.content)));
 assert.ok(chat.messages.some((m:any)=>m.parts.some((p:any)=>p.type==='image')));
 assert.match(chat.messages.at(-1).content,/两项/);assert.ok(s.jobs()>=8);
 assert.match(JSON.stringify(s.requests),/0012Ab/);
 assert.equal(s.sql.prepare('SELECT COUNT(*) n FROM batch_progress').get()!.n,0);
});
