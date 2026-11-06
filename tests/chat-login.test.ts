import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import type {ClientLLM} from '@browserbasehq/stagehand';
import {execute,type RuntimePort} from '../apps/desktop/src/executor/runtime';
import {productionModelFixture} from './production-model-fixture';

// 从生产聊天接口回复，经过云端协助图及 execute，再进入 Stagehand 模型回调。
// 提供方和网页仅用虚构值；不把隔离回归当作真实 Microsoft 登录证明。
for(const split of [false,true])test(`聊天登录生产链：${split?'分次提供、错误密码更正':'账号密码一起提供'}及验证码续接`,async t=>{
 const s=await productionModelFixture(t,'responses');
 const thread=(await s.request('/api/user/threads',{modelId:'model_test',taskId:s.run.taskId})).data;
 s.sql.prepare('UPDATE runs SET thread_id=? WHERE id=?').run(thread.id,s.run.id);
 const origin='https://login.example.com',account='qa@example.com',password='00Good! pass',otp='001234';
 const replies=split?['账号 qa@example.com','密码 wrong!','刚才密码错误，更正为 00Good! pass','本次验证码 001234']:
  ['账号 qa@example.com，密码 00Good! pass','本次验证码 001234'];
 type Step={name:string;args:Record<string,string>;field?:string;value?:string};
 const ask=(message:string):Step=>({name:'ask',args:{message}});
 const fill=(field:string,value:string):Step=>({name:'act',args:{instruction:`填写${field}`},field,value});
 const submit=(instruction:string):Step=>({name:'act',args:{instruction}});
 const steps:Step[]=[ask(split?'请在原聊天回复账号':'请在原聊天回复账号和密码'),fill('账号',account),
  ...(split?[ask('请回复密码'),fill('密码','wrong!'),submit('提交密码'),ask('密码错误，请回复更正后的密码')]:[]),
  fill('密码',password),submit('提交密码'),ask('请回复验证码'),fill('验证码',otp),submit('提交验证码')];
 let current:Step|undefined,replyIndex=0,passwordSubmissions=0,otpSubmissions=0,loggedIn=false;
 const fields:Record<string,string>={},posted=new Set<string>();let sdkModel:ClientLLM;
 const screenshot=await sharp({create:{width:1,height:1,channels:4,background:'#fff'}}).png().toBuffer();
 const page={title:async()=>'登录测试页面',url:async()=>origin+'/',goto:async()=>{},snapshot:async()=>({formattedTree:loggedIn?'已登录':passwordSubmissions?'密码已提交，按反馈继续':'账号和密码登录',xpathMap:{},urlMap:{}}),
  screenshot:async()=>screenshot,evaluate:async()=>({readyState:'complete',width:1,height:1,text:[]})};
 s.respond(body=>{
  const text=JSON.stringify(body);
  if(text.includes('压缩下面的执行历史供同一助手继续'))return '此前登录操作已返回，按当前协助回复与工具结果继续，不重放提交。';
  if(text.includes('LOGIN-SDK fixture')){
   assert.ok(current);
   for(const original of replies.slice(0,replyIndex))assert.ok(text.includes(original),'Stagehand 必须收到完整原文');
   return JSON.stringify({action:{method:current.field?'fill':'click',arguments:current.field?[current.value]:[]}});
  }
  if(text.includes('askUser')){
   const pending=s.sql.prepare('SELECT reply_message_id FROM execution_help ORDER BY created_at DESC LIMIT 1').get();
   return JSON.stringify(pending?.reply_message_id?{message:'已收到原文，请按页面继续。',askUser:false,accountId:null}:{message:current!.args.message,askUser:true,accountId:null});
  }
  current=steps.shift();
  if(!current)return '页面已确认登录完成。';
  return JSON.stringify({__model:{text:'',calls:[{id:crypto.randomUUID(),name:current.name,arguments:JSON.stringify(current.args)}]}});
 });
 const port:RuntimePort={cancelled:()=>false,checkpoint:async()=>{},rpc:async<T>(path:string,body:any)=>{
  if(path==='local:browser')return {cdpUrl:'fixture'} as T;
  const response=await s.request(path,body);if(response.status!==200)throw Error(response.data.error??'REQUEST_FAILED');
  if(path.endsWith('/help')&&!response.data.ready&&!posted.has(body.id)){
   posted.add(body.id);const content=replies[replyIndex++];assert.equal(typeof content,'string');
   const reply=await s.request(`/api/user/threads/${thread.id}/messages`,{requestId:`login_${replyIndex}`,content});
   assert.equal(reply.status,202);assert.ok(reply.data.messages.some((m:any)=>m.content===content&&m.private));
  }
  return response.data as T;
 }};
 await execute(s.run,port,{loadSdk:async()=>({Stagehand:{create:async(options:any)=>{
  sdkModel=options.model;return {close:async()=>{},act:async(instruction:string)=>{
   await sdkModel.generate({systemPrompt:'LOGIN-SDK fixture',messages:[{role:'user',content:{type:'text',text:instruction}}],responseFormat:{type:'json_schema',name:'Action',schema:{type:'object',properties:{action:{type:'object'}}}}});
   if(current?.field)fields[current.field]=current.value!;
   if(instruction==='提交密码'){passwordSubmissions++;assert.equal(fields.账号,account);}
   if(instruction==='提交验证码'){otpSubmissions++;loggedIn=fields.账号===account&&fields.密码===password&&fields.验证码===otp;}
   return {data:{success:true,message:instruction==='提交密码'&&fields.密码!==password?'密码错误':'操作已返回',actions:[]}};
  }};
 }},localBrowser:{connect:async()=>({context:{setDomainPolicy:async()=>{},pages:async()=>[page]}})}} as any),startProxy:async()=>({port:1,close:async()=>{}}),delay:async()=>{}});
 assert.equal(loggedIn,true);assert.equal(passwordSubmissions,split?2:1);assert.equal(otpSubmissions,1);
 assert.equal(replyIndex,replies.length);
 assert.equal(s.sql.prepare('SELECT status FROM runs WHERE id=?').get(s.run.id)!.status,'succeeded');
 const raw=s.sql.prepare("SELECT content,private_content,reply_to FROM ai_messages WHERE role='user' AND thread_id=?").all(thread.id);
 assert.equal(raw.length,replies.length);assert.ok(raw.every(row=>row.private_content&&row.reply_to));
 assert.ok(!JSON.stringify(raw).includes(password));assert.ok(!JSON.stringify(raw).includes(otp));
 const savedHelps=s.sql.prepare('SELECT request FROM execution_help WHERE run_id=?').all(s.run.id);
 assert.ok(savedHelps.every(row=>JSON.parse(String(row.request)).origin===origin));
 const chat=(await s.request(`/api/user/threads/${thread.id}`,null,'GET')).data;
 for(const original of replies)assert.ok(chat.messages.some((m:any)=>m.content===original));
});
