import test from 'node:test';
import assert from 'node:assert/strict';
import {execute,type RuntimePort} from '../apps/desktop/src/executor/runtime';
import {run} from './ui-fixtures';
import type {ModelResponse} from '../packages/model/src/index';
import type {ClientLLM} from '@browserbasehq/stagehand';
const answer=(text:string):ModelResponse=>({text,calls:[],usage:{input:null,output:null}});
const tool=(name:string,args:Record<string,unknown>={}):ModelResponse=>({...answer(''),calls:[{id:crypto.randomUUID(),name,arguments:JSON.stringify(args)}]});
async function scenario(turns:ModelResponse[],options:{actionError?:boolean;actionRejected?:boolean;emptyObserve?:boolean;navigationError?:boolean;cancelConnect?:boolean;createError?:boolean;closeError?:boolean;original?:string;origin?:string;fill?:string;method?:string;helpMessage?:string;cancel?:boolean;cancelStagehand?:boolean;newInstruction?:boolean;compact?:boolean;navigationObservationFailure?:boolean}={}){
 let attached=false,clicks=0,cancelled=false,closed=false,sessionCloses=0,navigations=0,snapshotFailures=0,planned=0,changed=false;
 const metadata={actionId:'sdk_action_test',cache:{status:'DISABLED'},usage:{inputTokens:1,outputTokens:1}};
 let llm:ClientLLM;const calls:Array<{path:string;body:any}>=[],checkpoints:any[]=[];
 const original=options.original??'请处理当前页面';
 const chat:any[]=[{seq:1,role:'user',source:'user',content:original,private:!!options.original,origin:options.origin??'https://example.com'}];
 const page={url:async()=> 'https://example.com/',goto:async()=>{navigations++;if(options.navigationError)throw Error('NAVIGATION_FAILED');},screenshot:async()=>Buffer.from('png'),
  snapshot:async()=>{if(snapshotFailures>0){snapshotFailures--;throw Error('Execution context destroyed during navigation');}return {formattedTree:'[1] button 继续登录\n[2] textbox 密码',xpathMap:{},urlMap:{}};},
  evaluate:async()=>({readyState:'complete'}),locator:()=>{throw Error('RAW_SELECTOR_PATH_MUST_NOT_BE_USED');},
 };
 const port:RuntimePort={cancelled:()=>cancelled,checkpoint:async(state,payload)=>{checkpoints.push({state,payload});},rpc:async<T>(path:string,body?:any)=>{
  calls.push({path,body});if(path==='local:browser')return {cdpUrl:'test'} as T;
  if(path.endsWith('/context'))return {messages:chat.filter(m=>m.seq>body.after)} as T;
  if(path.endsWith('/model')){if(options.cancel)cancelled=true;planned++;return {response:turns.shift()??answer('已处理当前页面，结果如上。'),memory:options.compact&&planned===1?{summaries:['旧操作历史摘要']}:null} as T;}
  if(path.endsWith('/stagehand')){
   if(options.cancelStagehand)cancelled=true;
   if(options.newInstruction&&!changed){changed=true;chat.push({seq:2,role:'user',source:'user',content:'先不要提交，改为只读查看'});}
   const value={action:{method:options.method??(options.fill?'fill':'click'),arguments:options.fill?[options.fill]:[]}};
   return {text:JSON.stringify(value),structured:value} as T;
  }
  if(path.endsWith('/tool'))return {execute:true} as T;
  if(path.endsWith('/snapshots'))return {id:'snapshot_test'} as T;
  if(path.endsWith('/help'))return {ready:true,message:options.helpMessage??'请结合用户原文继续'} as T;
  return {} as T;
 }};
 const infer=async(instruction:string)=>llm.generate({messages:[{role:'user',content:{type:'text',text:instruction}}],systemPrompt:'Stagehand actual callback',responseFormat:{type:'json_schema',name:'action',schema:{type:'object',properties:{action:{type:'object'}}}}});
 const session={close:async()=>{sessionCloses++;if(options.closeError)throw Error('CLOSE_FAILED');},act:async(instruction:string)=>{
  await infer(instruction);clicks++;if(options.navigationObservationFailure)snapshotFailures=1;if(options.actionError&&clicks===1)throw Error('TARGET_NOT_FOUND');
  return {data:{success:!options.actionRejected,message:options.actionRejected?'TARGET_NOT_FOUND':'已执行',actions:[]},metadata};
 },observe:async(instruction:string)=>{await infer(instruction);return {data:options.emptyObserve?[]:[{description:'继续登录'}],metadata};},extract:async(instruction:string)=>{await infer(instruction);return {data:{text:'实际页面信息'},metadata};}};
 await execute({...run,task:{...run.task,entryUrl:'https://example.com/'}},port,{loadSdk:async()=>({Stagehand:{create:async(opts:any)=>{if(options.createError)throw Error('CREATE_FAILED');attached=true;llm=opts.model;if(options.cancelConnect)cancelled=true;return session;}},localBrowser:{connect:async()=>({get context(){if(!attached)throw Error('Browser context is unavailable');return {setDomainPolicy:async()=>{},pages:async()=>[page]};}})}} as any),startProxy:async()=>({port:1,close:async()=>{closed=true;}}),delay:async()=>{}});
 return {calls,checkpoints,clicks,closed,sessionCloses,navigations,finish:calls.find(c=>c.path.endsWith('/finish'))?.body};
}

test('初始化期间停止不再导航，关闭 Stagehand 失败仍释放代理',async()=>{
 const s=await scenario([],{cancelConnect:true,closeError:true});
 assert.equal(s.navigations,0);assert.equal(s.finish.status,'cancelled');assert.equal(s.sessionCloses,1);assert.equal(s.closed,true);
});

test('Stagehand 初始化失败保留失败事实并释放代理，由 Host 收回浏览器',async()=>{
 const s=await scenario([],{createError:true});
 assert.equal(s.navigations,0);assert.equal(s.finish.status,'failed');assert.match(s.finish.result.summary,/CREATE_FAILED/);
 assert.equal(s.sessionCloses,0);assert.equal(s.closed,true);
});

test('空观察候选如实反馈并保留 Stagehand 元数据，不登记动作',async()=>{
 const s=await scenario([tool('observe',{instruction:'查看登录入口'}),tool('extract',{instruction:'读取状态'})],{emptyObserve:true});
 const messages=s.calls.filter(c=>c.path.endsWith('/messages'));
 assert.ok(messages.some(c=>c.body.content.includes('未找到符合指令的可操作内容')));
 assert.equal(s.clicks,0);assert.equal(s.calls.some(c=>c.path.endsWith('/tool')),false);
 const history=JSON.parse(s.calls.filter(c=>c.path.endsWith('/model')).at(-1)!.body.messages[1].content).history;
 assert.deepEqual(history[0].result.data,[]);
 for(const item of history)assert.equal(item.result.metadata.actionId,'sdk_action_test');
});

test('导航异常不展示已打开，错误交回模型继续处理',async()=>{
 const s=await scenario([tool('navigate',{url:'https://example.com/next'})],{navigationError:true});
 const messages=s.calls.filter(c=>c.path.endsWith('/messages'));
 assert.equal(messages.some(c=>/已打开/.test(c.body.content)),false);
 assert.match(JSON.stringify(s.calls.filter(c=>c.path.endsWith('/model'))),/NAVIGATION_FAILED/);
});

test('act 返回失败而未抛异常时保留错误和元数据，不自动重放',async()=>{
 const s=await scenario([tool('act',{instruction:'点击登录'})],{actionRejected:true});
 const history=JSON.parse(s.calls.filter(c=>c.path.endsWith('/model')).at(-1)!.body.messages[1].content).history;
 assert.equal(s.clicks,1);assert.equal(history[0].result.error,'TARGET_NOT_FOUND');
 assert.equal(history[0].result.metadata.actionId,'sdk_action_test');
 assert.equal(s.sessionCloses,1);
});
test('真实 execute 使用原生工具调用和普通文字结束，不再解析业务动作计划',async()=>{
 const s=await scenario([tool('observe',{instruction:'查看登录入口'}),tool('act',{instruction:'点击继续登录'}),tool('extract',{instruction:'读取登录状态'})]);
 assert.equal(s.clicks,1);assert.equal(s.finish.status,'succeeded');assert.equal(s.finish.result.outcome,'reported');assert.equal(s.closed,true);
 assert.equal(s.calls.filter(c=>c.path.endsWith('/stagehand')).length,3);
 const sent=s.calls.findIndex(c=>c.path.endsWith('/stagehand')&&JSON.stringify(c.body).includes('点击继续登录'));
 const intent=s.calls.findIndex(c=>c.path.endsWith('/tool')&&c.body.phase==='start');assert.ok(intent>sent);
});
test('Stagehand 工具错误回到同一执行上下文，不强制结束或偷偷重放',async()=>{
 const s=await scenario([tool('act',{instruction:'点击登录'}),tool('act',{instruction:'重新观察后点击继续'})],{actionError:true});
 assert.equal(s.clicks,2);assert.match(JSON.stringify(s.calls.filter(c=>c.path.endsWith('/model'))),/TARGET_NOT_FOUND/);
});
test('完整原始回复同时到达执行器模型和 Stagehand，摘要不能丢掉密码与补充要求',async()=>{
 const original='密码是 0012Ab!，但是请先确认页面，再填写。';
 const s=await scenario([tool('ask',{message:'请确认登录信息'}),tool('act',{instruction:'根据用户回复填写密码'})],{original,fill:'0012Ab!',compact:true});
 assert.equal(s.clicks,1);
 for(const call of s.calls.filter(c=>c.path.endsWith('/model')||c.path.endsWith('/stagehand')))assert.ok(JSON.stringify(call.body).includes(original));
 assert.doesNotMatch(JSON.stringify(s.checkpoints),/0012Ab!/);
 assert.doesNotMatch(JSON.stringify(s.calls.filter(c=>c.path.endsWith('/messages'))),/0012Ab!/);
});
test('用户改变登录方式的原文交给 Stagehand，无字段提取和强制填写',async()=>{
 const original='不要填密码了，改用邮箱验证码。';
 const s=await scenario([tool('act',{instruction:'按用户新要求更换登录方式'})],{original});
 assert.equal(s.clicks,1);assert.ok(JSON.stringify(s.calls.find(c=>c.path.endsWith('/stagehand'))?.body).includes(original));
});
test('模型在完整上下文中生成的实际填写值仍校验所属站点',async()=>{
 const s=await scenario([tool('act',{instruction:'根据原文填写'})],{original:'密码是 0012Ab!',origin:'https://login.example.com',fill:'0012Ab!'});
 assert.equal(s.clicks,0);assert.equal(s.calls.some(c=>c.path.endsWith('/tool')&&c.body.phase==='start'),false);
 assert.match(JSON.stringify(s.calls.filter(c=>c.path.endsWith('/model'))),/CREDENTIAL_ORIGIN_MISMATCH/);
});
test('原生下拉选项不因数字与其他站点密码重合而被当成凭据填写',async()=>{
 const s=await scenario([tool('act',{instruction:'将数量选择为 1'})],{original:'登录密码 001234',origin:'https://login.example.com',fill:'1',method:'selectOptionFromDropdown'});
 assert.equal(s.clicks,1);assert.equal(s.calls.filter(c=>c.path.endsWith('/tool')&&c.body.phase==='start').length,1);
});
test('超过四十步可如实给出受阻答复，不做独立成功审核',async()=>{
 const s=await scenario([...Array.from({length:41},()=>tool('act',{instruction:'查看下一页'})),answer('已完成部分，其余网站暂不可用。')]);
 assert.equal(s.clicks,41);assert.equal(s.finish.result.summary,'已完成部分，其余网站暂不可用。');assert.equal(s.finish.result.outcome,'reported');
 assert.equal(JSON.parse(s.calls.filter(c=>c.path.endsWith('/model')).at(-1)!.body.messages[1].content).history.length,41);
});
test('模型等待期间停止，不执行返回的工具调用',async()=>{
 const s=await scenario([tool('act',{instruction:'点击提交'})],{cancel:true});assert.equal(s.clicks,0);assert.equal(s.finish.status,'cancelled');
});
test('Stagehand 定位推理期间停止不把未点击动作标成 unknown',async()=>{
 const s=await scenario([tool('act',{instruction:'点击提交'})],{cancelStagehand:true});assert.equal(s.clicks,0);assert.equal(s.finish.status,'cancelled');
 assert.equal(s.calls.some(c=>c.path.endsWith('/tool')&&c.body.phase==='start'),false);
});
test('Stagehand 推理期间收到用户新要求，旧动作作废',async()=>{
 const s=await scenario([tool('act',{instruction:'点击提交'}),answer('已按新要求停止提交。')],{newInstruction:true});
 assert.equal(s.clicks,0);assert.equal(s.calls.some(c=>c.path.endsWith('/tool')&&c.body.phase==='start'),false);
});
test('导航过渡观察失败只重新观察，不重复提交',async()=>{
 const s=await scenario([tool('act',{instruction:'点击提交'})],{navigationObservationFailure:true});assert.equal(s.clicks,1);
 assert.equal(s.calls.filter(c=>c.path.endsWith('/tool')&&c.body.phase==='start').length,1);assert.equal(s.calls.filter(c=>c.path.endsWith('/tool')&&c.body.phase==='result').length,1);
});
