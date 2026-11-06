import test from 'node:test';
import assert from 'node:assert/strict';
import {execute,type RuntimePort} from '../apps/desktop/src/executor/runtime';
import {run} from './ui-fixtures';
import type {ModelResponse} from '../packages/model/src/index';
import type {ClientLLM} from '@browserbasehq/stagehand';
import sharp from 'sharp';
const answer=(text:string):ModelResponse=>({text,calls:[],usage:{input:null,output:null}});
const tool=(name:string,args:Record<string,unknown>={}):ModelResponse=>({...answer(''),calls:[{id:crypto.randomUUID(),name,arguments:JSON.stringify(args)}]});

test('正式 execute 保存账号工具只发布私有卡片请求，不把凭据写入恢复记录或普通消息',async()=>{
 const s=await scenario([tool('offerAccountSave',{name:'测试账号',username:'private-user',password:'private-password',loginOrigins:['https://example.com'],evidence:'本次提交后看到账号主页'})],{browserState:true,unbound:true});
 const card=s.calls.find(c=>c.path.endsWith('/account-card'))!.body;
 assert.equal(card.kind,'save');assert.equal(card.observedOrigin,'https://example.com');assert.equal(card.password,'private-password');
 assert.equal(s.clicks,0);assert.equal(s.finish.stateCandidateKey,'candidate_1');
 assert.doesNotMatch(JSON.stringify(s.checkpoints),/private-password|private-user/);
 assert.doesNotMatch(JSON.stringify(s.calls.filter(c=>c.path.endsWith('/messages'))),/private-password|private-user/);
});
test('正式执行图修改账号卡片 interrupt 同代恢复，重新取本次版本凭据后才继续操作',async()=>{
 const s=await scenario([tool('requestAccountUpdate',{evidence:'实际提交后网站提示密码错误'}),tool('act',{instruction:'使用更新后的凭据重新登录'}),tool('confirmAccountLogin',{evidence:'已使用更新后的密码登录成功'})],{browserState:true,fill:'updated-secret'});
 assert.equal(s.calls.filter(c=>c.path.endsWith('/account-card')).length,1);
 assert.equal(s.calls.filter(c=>c.path.endsWith('/account-card-status')).length,2);
 assert.equal(s.calls.find(c=>c.path.endsWith('/account-status'))?.body.credentialVersion,2);
 assert.equal(s.clicks,1);assert.equal(s.finish.status,'succeeded');
 assert.doesNotMatch(JSON.stringify(s.checkpoints),/updated-secret/);
});
test('修改账号卡片等待中停止，不执行原批次剩余操作',async()=>{
 const s=await scenario([tool('requestAccountUpdate',{evidence:'网站拒绝密码'}),tool('act',{instruction:'不能执行'})],{browserState:true,cancelCard:true});
 assert.equal(s.clicks,0);assert.equal(s.finish.status,'cancelled');assert.equal(s.sessionCloses,1);
});
test('同域不同账号的历史私密凭据不能填入当前账号环境，原文仍完整传递',async()=>{
 const original='上一个账号密码是 other-account-secret';
 const s=await scenario([tool('act',{instruction:'填写密码'})],{browserState:true,original,originalAccountId:'account_other',fill:'other-account-secret'});
 assert.equal(s.clicks,0);assert.match(JSON.stringify(s.calls.filter(c=>c.path.endsWith('/model'))),/CREDENTIAL_ACCOUNT_MISMATCH/);
 assert.ok(JSON.stringify(s.calls.find(c=>c.path.endsWith('/stagehand'))?.body).includes(original));
});
test('收尾前新指令使旧候选失效，再次完成时重新捕获状态',async()=>{
 const s=await scenario([],{browserState:true,finalRpcInstruction:true});
 const finishes=s.calls.filter(c=>c.path.endsWith('/finish'));
 assert.equal(finishes.length,2);assert.equal(finishes[0].body.stateCandidateKey,'candidate_1');assert.equal(finishes[1].body.stateCandidateKey,'candidate_2');
});

test('八次读取保留八份反馈但只在首尾拍照，相同图片复用；相同提供方调用标识不吞真实调用',async()=>{
 const repeated=tool('extract',{instruction:'读取当前结果'});
 const s=await scenario(Array.from({length:8},()=>structuredClone(repeated)));
 assert.equal(s.captures,2);assert.equal(s.calls.filter(c=>c.path.endsWith('/snapshots')).length,1);
 const messages=s.calls.filter(c=>c.path.endsWith('/messages')&&c.body.parts.some((p:any)=>p.type==='tool'));
 assert.equal(messages.length,8);assert.equal(new Set(messages.map(c=>c.body.id)).size,8);
 const history=s.calls.filter(c=>c.path.endsWith('/model')).at(-1)!.body.messages.filter((m:any)=>m.role==='tool');
 assert.deepEqual(JSON.parse(history.at(-1).content).readFeedback,{unchangedFromPreviousRead:true,consecutiveSameRead:8});
});

test('普通点击和填写不截图，明确请求截图仍可用',async()=>{
 const s=await scenario([tool('act',{instruction:'填写账号'}),tool('act',{instruction:'点击下一步'}),tool('screenshot')]);
 assert.equal(s.captures,3);assert.equal(s.clicks,2);
 assert.equal(s.calls.filter(c=>c.path.endsWith('/snapshots')).length,1);
 assert.equal(s.calls.some(c=>c.path.endsWith('/messages')&&c.body.content.includes('沿用此前截图')),true);
});

test('相同页面重复报错只拍一次，新页面报错再拍，不阻止模型重新操作',async()=>{
 const s=await scenario([tool('act',{instruction:'尝试按钮'}),tool('act',{instruction:'换个按钮'}),tool('navigate',{url:'https://example.com/other'}),tool('act',{instruction:'新页面按钮'})],{actionRejected:true});
 assert.equal(s.clicks,3);assert.equal(s.captures,4);
});

test('模型附带的求助文字不提前回显，内部协助立即解决不拍照',async()=>{
 const request=tool('ask',{message:'请提供账号'});request.text='请提供账号';
 const s=await scenario([request]);assert.equal(s.captures,2);
 assert.equal(s.calls.some(c=>c.path.endsWith('/messages')&&c.body.content==='请提供账号'),false);
});
async function scenario(turns:ModelResponse[],options:{actionError?:boolean;actionRejected?:boolean;emptyObserve?:boolean;navigationError?:boolean;cancelConnect?:boolean;createError?:boolean;closeError?:boolean;original?:string;origin?:string;fill?:string;fills?:string[];account?:{account:Record<string,string>;origin:string};method?:string;helpMessage?:string;cancel?:boolean;cancelStagehand?:boolean;newInstruction?:boolean;navigationObservationFailure?:boolean;unknownActionResult?:boolean;helpWaits?:number;cancelHelp?:boolean;executionOutline?:string[];finalShotInstruction?:boolean;finalMessageInstruction?:boolean;finalRpcInstruction?:boolean;browserState?:boolean;unbound?:boolean;cardWait?:boolean;cancelCard?:boolean;originalAccountId?:string}={}){
 let attached=false,clicks=0,cancelled=false,closed=false,sessionCloses=0,navigations=0,snapshotFailures=0,changed=false,helpRequests=0,finalReply=false,captures=0;
 const metadata={actionId:'sdk_action_test',cache:{status:'DISABLED'},usage:{inputTokens:1,outputTokens:1}};
 let llm:ClientLLM,currentUrl='https://example.com/',stagehandCalls=0;const calls:Array<{path:string;body:any}>=[],checkpoints:any[]=[];
 let cardPolls=0,stateCaptures=0;
 const original=options.original??'请处理当前页面';
 const chat:any[]=[{seq:1,role:'user',source:'user',content:original,private:!!options.original,origin:options.origin??'https://example.com',accountId:options.originalAccountId}];
 const changeInstructions=()=>{if(!changed){changed=true;chat.push({seq:2,role:'user',source:'user',content:'请先核对新补充要求，再结束。'});}};
 const screenshot=await sharp({create:{width:1,height:1,channels:4,background:'#fff'}}).png().toBuffer();
 const page={title:async()=>'测试页面',url:async()=>currentUrl,goto:async(url:string)=>{navigations++;if(options.navigationError)throw Error('NAVIGATION_FAILED');currentUrl=url;},screenshot:async()=>{captures++;if(options.finalShotInstruction&&finalReply)changeInstructions();return screenshot;},
  snapshot:async()=>{if(snapshotFailures>0){snapshotFailures--;throw Error('Execution context destroyed during navigation');}return {formattedTree:'[1] button 继续登录\n[2] textbox 密码',xpathMap:{},urlMap:{}};},
  evaluate:async()=>({readyState:'complete',width:1,height:1,text:[]}),locator:()=>{throw Error('RAW_SELECTOR_PATH_MUST_NOT_BE_USED');},
 };
 const port:RuntimePort={cancelled:()=>cancelled,checkpoint:async(state,payload)=>{checkpoints.push({state,payload});},rpc:async<T>(path:string,body?:any)=>{
  calls.push({path,body});if(path==='local:browser')return {cdpUrl:'test',...(options.browserState?{state:{accountId:options.unbound?null:'account_test',credentialVersion:1,stateEpoch:1,revision:0,origins:['https://example.com'],state:null}}:{})} as T;
  if(path==='local:state-capture')return {key:'candidate_'+(++stateCaptures)} as T;
  if(path.endsWith('/account-card'))return {cardId:'card_test'} as T;
  if(path.endsWith('/account-card-status')){cardPolls++;if(options.cancelCard)cancelled=true;return {status:cardPolls===1?'pending':'saved',resumed:cardPolls>1,accountId:'account_test',credentialVersion:2,stateEpoch:2} as T;}
  if(path.endsWith('/context'))return {messages:chat.filter(m=>m.seq>body.after)} as T;
  if(path.endsWith('/model')){if(body.purpose==='summary')return {response:answer('已读取页面并尝试操作，保留最近工具反馈继续。')} as T;if(options.cancel)cancelled=true;const response=turns.shift()??answer('已处理当前页面，结果如上。');finalReply=!response.calls.length;return {response} as T;}
  if(path.endsWith('/messages')&&['当前页面。','当前页面未变化，沿用此前截图。'].includes(body.content)&&options.finalMessageInstruction)changeInstructions();
  if(path.endsWith('/finish')&&options.finalRpcInstruction&&!changed){changeInstructions();throw Error('INSTRUCTIONS_CHANGED');}
  if(path.endsWith('/stagehand')){
   if(options.cancelStagehand)cancelled=true;
   if(options.newInstruction&&!changed){changed=true;chat.push({seq:2,role:'user',source:'user',content:'先不要提交，改为只读查看'});}
   const fill=options.fills?.[stagehandCalls++]??options.fill;
   const value={action:{method:options.method??(fill?'fill':'click'),arguments:fill?[fill]:[]}};
   return {text:JSON.stringify(value),structured:value} as T;
  }
  if(path.endsWith('/tool'))return {execute:true} as T;
  if(path.endsWith('/snapshots'))return {id:'snapshot_test'} as T;
  if(path.endsWith('/help')){helpRequests++;if(options.cancelHelp)cancelled=true;return {ready:helpRequests>(options.helpWaits??0),questionRound:0,message:options.helpMessage??'请结合用户原文继续',accountId:options.account?'account_test':undefined} as T;}
  if(path.endsWith('/credentials'))return (options.browserState?{account:options.account?.account??{username:'fixture-user',password:cardPolls>1?'updated-secret':'fixture-secret'},origin:'https://example.com',accountId:'account_test',credentialVersion:cardPolls>1?2:1,stateEpoch:cardPolls>1?2:1}:options.account) as T;
  return {} as T;
 }};
 const infer=async(instruction:string)=>llm.generate({messages:[{role:'user',content:{type:'text',text:instruction}}],systemPrompt:'Stagehand actual callback',responseFormat:{type:'json_schema',name:'action',schema:{type:'object',properties:{action:{type:'object'}}}}});
 const session={close:async()=>{sessionCloses++;if(options.closeError)throw Error('CLOSE_FAILED');},act:async(instruction:string)=>{
  await infer(instruction);clicks++;if(options.navigationObservationFailure)snapshotFailures=1;if(options.unknownActionResult)snapshotFailures=Infinity;if(options.actionError&&clicks===1)throw Error('TARGET_NOT_FOUND');
  return {data:{success:!options.actionRejected,message:options.actionRejected?'TARGET_NOT_FOUND':'已执行',actions:[]},metadata};
 },observe:async(instruction:string)=>{await infer(instruction);return {data:options.emptyObserve?[]:[{description:'继续登录'}],metadata};},extract:async(instruction:string)=>{await infer(instruction);return {data:{text:'实际页面信息'},metadata};}};
 await execute({...run,task:{...run.task,entryUrl:'https://example.com/',executionOutline:options.executionOutline}},port,{loadSdk:async()=>({Stagehand:{create:async(opts:any)=>{if(options.createError)throw Error('CREATE_FAILED');attached=true;llm=opts.model;if(options.cancelConnect)cancelled=true;return session;}},localBrowser:{connect:async()=>({get context(){if(!attached)throw Error('Browser context is unavailable');return {setDomainPolicy:async()=>{},pages:async()=>[page]};}})}} as any),startProxy:async()=>({port:1,close:async()=>{closed=true;}}),delay:async()=>{}});
 return {calls,checkpoints,clicks,closed,sessionCloses,navigations,captures,finish:calls.filter(c=>c.path.endsWith('/finish')).at(-1)?.body};
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
 const history=s.calls.filter(c=>c.path.endsWith('/model')).at(-1)!.body.messages.filter((m:{role:string})=>m.role==='tool').map((m:{content:string})=>({result:JSON.parse(m.content)}));
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
 const history=s.calls.filter(c=>c.path.endsWith('/model')).at(-1)!.body.messages.filter((m:{role:string})=>m.role==='tool').map((m:{content:string})=>({result:JSON.parse(m.content)}));
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
 const s=await scenario([tool('ask',{message:'请确认登录信息'}),...Array.from({length:20},()=>tool('act',{instruction:'根据用户回复填写密码'}))],{original,fill:'0012Ab!'});
 assert.equal(s.clicks,20);assert.ok(s.calls.some(c=>c.path.endsWith('/model')&&c.body.purpose==='summary'));
 for(const call of s.calls.filter(c=>(c.path.endsWith('/model')&&c.body.purpose!=='summary')||c.path.endsWith('/stagehand')))assert.ok(JSON.stringify(call.body).includes(original));
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

for(const fill of ['prefix:0012Ab!','0012Ab!:suffix','prefix:0012Ab!:suffix'])test('完整已知凭据加前后缀仍拒绝跨站填写：'+fill,async()=>{
 const s=await scenario([tool('act',{instruction:'根据原文填写'})],{original:'0012Ab!',origin:'https://login.example.com',fill});
 assert.equal(s.clicks,0);assert.equal(s.calls.some(c=>c.path.endsWith('/tool')&&c.body.phase==='start'),false);
 assert.match(JSON.stringify(s.calls.filter(c=>c.path.endsWith('/model'))),/CREDENTIAL_ORIGIN_MISMATCH/);
});

test('同站拼接凭据可使用且脱敏，从完整原文填写过的值保留站点来源',async()=>{
 const same=await scenario([tool('act',{instruction:'按原文填写'})],{original:'0012Ab!',fill:'prefix:0012Ab!:suffix'});
 assert.equal(same.clicks,1);
 assert.doesNotMatch(JSON.stringify(same.calls.filter(c=>c.path.endsWith('/messages'))),/0012Ab!/);
 const s=await scenario([tool('act',{instruction:'填写用户密码'}),tool('navigate',{url:'https://other.example.com'}),tool('act',{instruction:'按页面格式填写'})],{
  original:'密码是 0012Ab!，请先确认页面。',fills:['0012Ab!','prefix:0012Ab!:suffix'],
 });
 assert.equal(s.clicks,1);assert.match(JSON.stringify(s.calls.filter(c=>c.path.endsWith('/model'))),/CREDENTIAL_ORIGIN_MISMATCH/);
 assert.equal(s.calls.filter(c=>c.path.endsWith('/tool')&&c.body.phase==='start').length,2);
});

test('拼接多个站点凭据时本网站来源不能为其他站点凭据放行',async()=>{
 const s=await scenario([tool('navigate',{url:'https://other.example.com'}),tool('ask',{message:'读取此站点账号'}),tool('navigate',{url:'https://example.com'}),tool('act',{instruction:'填写拼接内容'})],{
  original:'current-site-secret',fill:'current-site-secret:other-site-secret',account:{origin:'https://other.example.com',account:{password:'other-site-secret'}},
 });
 assert.equal(s.clicks,0);assert.match(JSON.stringify(s.calls.filter(c=>c.path.endsWith('/model'))),/CREDENTIAL_ORIGIN_MISMATCH/);
});
test('原生下拉选项不因数字与其他站点密码重合而被当成凭据填写',async()=>{
 const s=await scenario([tool('act',{instruction:'将数量选择为 1'})],{original:'登录密码 001234',origin:'https://login.example.com',fill:'1',method:'selectOptionFromDropdown'});
 assert.equal(s.clicks,1);assert.equal(s.calls.filter(c=>c.path.endsWith('/tool')&&c.body.phase==='start').length,1);
});
test('超过四十步可如实给出受阻答复，不做独立成功审核',async()=>{
 const s=await scenario([...Array.from({length:41},()=>tool('act',{instruction:'查看下一页'})),answer('已完成部分，其余网站暂不可用。')]);
 assert.equal(s.clicks,41);assert.equal(s.finish.result.summary,'已完成部分，其余网站暂不可用。');assert.equal(s.finish.result.outcome,'reported');
 const sent=s.calls.filter(c=>c.path.endsWith('/model')).at(-1)!.body.messages;
 assert.ok(sent.filter((m:{role:string})=>m.role==='tool').length<41);
 assert.ok(s.calls.some(c=>c.path.endsWith('/model')&&c.body.purpose==='summary'));
 assert.doesNotMatch(JSON.stringify(s.calls.filter(c=>c.path.endsWith('/model'))),/formattedTree|textbox 密码/);
 assert.equal(JSON.parse(sent[1].content).history,undefined);
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

test('真实 execute 协助中断以相同请求恢复，不重复登记或重放之前动作',async()=>{
 const s=await scenario([tool('act',{instruction:'检查页面'}),tool('ask',{message:'请提供验证码'}),tool('act',{instruction:'按回复继续'})],{helpWaits:2});
 const requests=s.calls.filter(c=>c.path.endsWith('/help'));
 assert.equal(requests.length,3);assert.equal(new Set(requests.map(c=>c.body.id)).size,1);assert.equal(s.clicks,2);
 assert.equal(s.calls.filter(c=>c.path.endsWith('/messages')&&c.body.content==='请提供验证码').length,0);
 assert.equal(s.captures,3); // 首次、同一协助轮次一次、最终；轮询不重复拍。
 assert.equal(s.calls.filter(c=>c.path.endsWith('/snapshots')).length,1); // 相同脱敏图片仅上传一次。
 assert.equal(s.calls.filter(c=>c.path.includes('/help/')&&c.path.endsWith('/ack')).length,1);
 assert.equal(s.finish.status,'succeeded');
});

test('等待协助时停止清理同代图，不执行后续动作',async()=>{
 const s=await scenario([tool('ask',{message:'请提供验证码'}),tool('act',{instruction:'提交'})],{helpWaits:1,cancelHelp:true});
 assert.equal(s.clicks,0);assert.equal(s.finish.status,'cancelled');assert.equal(s.sessionCloses,1);assert.equal(s.closed,true);
});

test('观察始终不可用时新图保留 unknown，禁止重复提交',async()=>{
 const s=await scenario([tool('act',{instruction:'提交'}),tool('act',{instruction:'再次提交'}),answer('当前提交结果无法确认。')],{unknownActionResult:true});
 assert.equal(s.clicks,1);assert.equal(s.finish.status,'unknown');assert.equal(s.finish.result.outcome,'unconfirmed');
 assert.equal(s.calls.filter(c=>c.path.endsWith('/tool')&&c.body.phase==='start').length,1);
 assert.match(JSON.stringify(s.calls.filter(c=>c.path.endsWith('/model'))),/ACTION_RESULT_PENDING/);
});

test('可调整粗步骤传给两层模型，摘要后仍由任务快照提供',async()=>{
 const executionOutline=['按现场需要登录','查询库存','整理查询结果'];
 const s=await scenario([...Array.from({length:20},()=>tool('observe',{instruction:'查看页面'})),tool('act',{instruction:'查询库存'})],{executionOutline});
 assert.ok(s.calls.some(c=>c.path.endsWith('/model')&&c.body.purpose==='summary'));
 for(const request of s.calls.filter(c=>(c.path.endsWith('/model')&&c.body.purpose!=='summary')||c.path.endsWith('/stagehand'))){
  for(const step of executionOutline)assert.ok(JSON.stringify(request.body).includes(step));
 }
 assert.equal(s.finish.status,'succeeded');
});

for(const arrival of ['finalShotInstruction','finalMessageInstruction','finalRpcInstruction'] as const){
 test(`真实 execute 收尾期间收到新要求时重读上下文，不提交旧结果：${arrival}`,async()=>{
  const s=await scenario([answer('旧目标已完成'),answer('已核对新补充要求。')],{[arrival]:true});
  const requests=s.calls.filter(c=>c.path.endsWith('/model'));
  assert.equal(requests.length,2);assert.match(JSON.stringify(requests[1].body),/请先核对新补充要求/);
  assert.equal(s.finish.status,'succeeded');assert.equal(s.finish.result.summary,'已核对新补充要求。');assert.equal(s.finish.expectedUserSeq,2);
  const finishes=s.calls.filter(c=>c.path.endsWith('/finish'));
  assert.equal(finishes.length,arrival==='finalRpcInstruction'?2:1);
  assert.equal(s.checkpoints.filter(c=>c.state==='finished').length,1);
  assert.equal(s.calls.some(c=>c.path.endsWith('/tool')&&c.body.phase==='start'),false);
 });
}
