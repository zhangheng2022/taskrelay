import test from 'node:test';
import assert from 'node:assert/strict';
import {productionModelFixture} from './production-model-fixture';
import {hash} from '../packages/contracts/src/security';
const decision=(start=true)=>JSON.stringify({reply:start?'已交给执行器。':'请说明要处理哪个网站。',start,title:start?'读取页面':null,goal:start?'查看当前页面并报告':null,entryUrl:start?'https://example.com/':null,accountId:null,executionOutline:start?['打开目标网站','读取页面内容并反馈']:[]});
for(const protocol of ['chat','responses'] as const)test(`新交办/${protocol}：意图检查后直接启动，同一会话且重复发送不重复启动`,async t=>{
  const s=await productionModelFixture(t,protocol),th=(await s.request('/api/user/threads',{modelId:'model_test'})).data;
  s.replies(decision());const b={requestId:'start_one',content:'查看 example.com'};
  const r=await s.request(`/api/user/threads/${th.id}/messages`,b);
  assert.equal(r.status,202,JSON.stringify(r.data));assert.ok(r.data.taskId,JSON.stringify(r.data));
  const retry=await s.request(`/api/user/threads/${th.id}/messages`,b);
  assert.equal(retry.data.id,th.id);assert.equal(s.jobs(),1);
  assert.equal(retry.data.messages.filter((m:{role:string})=>m.role==='user').length,1,'重试已启动交办不能再追加一条执行中补充');
  assert.equal(s.sql.prepare('SELECT COUNT(*) n FROM runs WHERE task_id=?').get(r.data.taskId)!.n,1);
  assert.equal(s.sql.prepare('SELECT execution_protocol FROM runs WHERE task_id=?').get(r.data.taskId)!.execution_protocol,15);
});
test('意图不明只追问，不创建运行',async t=>{
  const s=await productionModelFixture(t),th=(await s.request('/api/user/threads',{modelId:'model_test'})).data;
  s.replies(decision(false));const r=await s.request(`/api/user/threads/${th.id}/messages`,{requestId:'question',content:'帮我处理一下'});
  assert.equal(r.data.taskId,null);assert.match(r.data.messages.at(-1).content,/请说明/);
});

test('交办已入队但尚未提升时，原请求重试继续处理且不重复入队',async t=>{
 const s=await productionModelFixture(t),th=(await s.request('/api/user/threads',{modelId:'model_test'})).data;
 const body={requestId:'queued_retry',content:'查看 example.com'};
 const turnId='turn_'+await hash(th.id+':'+body.requestId);
 s.sql.prepare("INSERT INTO conversation_inbox(id,thread_id,request_id,digest,content,mode,created_at) VALUES(?,?,?,?,?,'chat',?)")
  .run(turnId,th.id,body.requestId,await hash(body.content),body.content,new Date().toISOString());
 s.replies(decision());
 const reply=await s.request(`/api/user/threads/${th.id}/messages`,body);
 assert.equal(reply.data.status,'done',JSON.stringify(reply.data));
 assert.equal(s.jobs(),1);
 assert.equal(s.sql.prepare('SELECT COUNT(*) n FROM conversation_inbox WHERE thread_id=?').get(th.id)!.n,1);
 assert.equal(reply.data.messages.filter((m:{role:string})=>m.role==='user').length,1);
});
test('执行中补充直接进入聊天，不调用第二个云端规划模型',async t=>{
  const s=await productionModelFixture(t),th=(await s.request('/api/user/threads',{modelId:'model_test',taskId:s.run.taskId})).data;
  s.sql.prepare('UPDATE runs SET thread_id=? WHERE id=?').run(th.id,s.run.id);
  const r=await s.request(`/api/user/threads/${th.id}/messages`,{requestId:'steer',content:'只处理免费项目'});
  assert.equal(r.status,202);assert.equal(s.jobs(),0);assert.match(r.data.messages.at(-1).content,/免费/);
  const ctx=await s.request(`/api/runner/runs/${s.run.id}/context`,{epoch:s.run.leaseEpoch});
  assert.match(JSON.stringify(ctx.data),/免费/);
});
test('执行器文字和截图引用进入同一聊天，最终答复不触发报告模型',async t=>{
  const s=await productionModelFixture(t),th=(await s.request('/api/user/threads',{modelId:'model_test',taskId:s.run.taskId})).data;
  s.sql.prepare('UPDATE runs SET thread_id=? WHERE id=?').run(th.id,s.run.id);
  const base=`/api/runner/runs/${s.run.id}`;
  assert.equal((await s.request(base+'/messages',{epoch:s.run.leaseEpoch,id:'progress_one',content:'已经打开页面',parts:[{type:'tool',name:'navigate',result:'页面已打开'}]})).status,200);
  const finish={epoch:s.run.leaseEpoch,status:'succeeded',result:{summary:'实际完成了查询。',outcome:'reported',evidence:[]}};
  assert.equal((await s.request(base+'/finish',finish)).status,200);
  assert.equal((await s.request(base+'/finish',finish)).status,200);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ai_messages WHERE id=?").get('final_'+s.run.id)!.n,1);
  const page=await s.request(`/api/user/threads/${th.id}`,null,'GET');
  assert.equal(page.data.messages.at(-1).content,'实际完成了查询。');assert.equal(s.jobs(),0);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM conversation_inbox WHERE mode='report'").get()!.n,0);
});
test('本人聊天和当前任务模型可读协助回复，普通存储仍为密文',async t=>{
  const s=await productionModelFixture(t),th=(await s.request('/api/user/threads',{modelId:'model_test',taskId:s.run.taskId})).data;
  s.sql.prepare('UPDATE runs SET thread_id=? WHERE id=?').run(th.id,s.run.id);
  s.replies(JSON.stringify({message:'请输入验证码。',askUser:true,accountId:null}));
  const help={epoch:s.run.leaseEpoch,id:'help_code',origin:'https://example.com',message:'需要验证码'};
  const h=await s.request(`/api/runner/runs/${s.run.id}/help`,help);assert.equal(h.data.ready,false,JSON.stringify(h.data));
  const pending=(await s.request('/api/user/snapshot',null,'GET')).data;
  assert.deepEqual(pending.waitingHelp,[{id:'help_code',runId:s.run.id,taskId:s.run.taskId}]);
  assert.deepEqual(pending.challenges,[]);
  const r=await s.request(`/api/user/threads/${th.id}/messages`,{requestId:'secret_reply',content:'0012Ab!'});
  assert.ok(r.data.messages.some((m:any)=>m.content==='0012Ab!'));
  assert.deepEqual((await s.request('/api/user/snapshot',null,'GET')).data.waitingHelp,[]);
  assert.doesNotMatch(JSON.stringify(s.sql.prepare('SELECT content FROM ai_messages').all()),/0012Ab/);
  const ctx=await s.request(`/api/runner/runs/${s.run.id}/context`,{epoch:s.run.leaseEpoch});assert.match(JSON.stringify(ctx.data),/0012Ab/);
  s.replies(JSON.stringify({message:'已收到回复，请结合原文继续。',askUser:false,accountId:null}));
  const delivery=await s.request(`/api/runner/runs/${s.run.id}/help`,help);assert.equal(delivery.data.message,'已收到回复，请结合原文继续。');assert.equal(s.jobs(),2);
});
test('最长原始交办超过模型窗口时明确拒绝，不把用户原话压缩后交办',async t=>{
  const s=await productionModelFixture(t),th=(await s.request('/api/user/threads',{modelId:'model_test'})).data;
  s.sql.prepare("UPDATE model_profiles SET config=json_set(config,'$.contextTokens',6000,'$.outputTokens',1024) WHERE id='model_test'").run();
  s.respond(body=>JSON.stringify(JSON.stringify(body).includes('"summary"')?{summary:'用户要求读取网站信息，保留最新范围，不执行提交。'}:{reply:'请说明目标网站。',start:false,title:null,goal:null,entryUrl:null,accountId:null,executionOutline:[]}));
  const content='请读取网站信息，不要执行提交。'.repeat(700).slice(0,12000);
  const r=await s.request(`/api/user/threads/${th.id}/messages`,{requestId:'long_request',content});
  assert.equal(r.data.status,'failed');assert.equal(r.data.error,'MODEL_CONTEXT_CONFIGURATION_TOO_SMALL');assert.equal(r.data.messages[0].content,content);
  assert.equal(s.requests.length,0);
});

test('上下文整理保留最新页面结构与真实选择器',async t=>{
 const s=await productionModelFixture(t);
 s.respond(body=>JSON.stringify(JSON.stringify(body).includes('"summary"')?{summary:'已填写账号，尚未提交。'}:{__model:{text:'继续登录',calls:[{id:'next',name:'act',arguments:JSON.stringify({instruction:'点击下一步'})}]}}));
 const page={url:'https://example.com/login',text:'登录 下一步',elements:[{tag:'BUTTON',id:'next',label:'下一步'}]};
 const response=await s.request(`/api/runner/runs/${s.run.id}/model`,{epoch:s.run.leaseEpoch,requestId:'context_current_page',messages:[{role:'system',content:'执行浏览器任务'},{role:'user',content:JSON.stringify({goal:'登录',history:'旧观察'.repeat(5000),untrustedPage:page})}]});
 assert.equal(response.status,200,JSON.stringify(response.data));
 const last=JSON.stringify(s.requests.at(-1)?.body);assert.match(last,/untrustedPage/);assert.match(last,/#next|next/);
});

test('原文和当前页面占用较多时，历史摘要仍使用独立请求窗口而非碎片回合',async t=>{
 const s=await productionModelFixture(t);
 const original='请保留原始输入：'+'原'.repeat(3900);
 const page={url:'https://example.com',tree:'页'.repeat(2000)};
 s.respond(body=>JSON.stringify(JSON.stringify(body).includes('"summary"')?{summary:'已查看旧页面。'}:{__model:{text:'根据当前页面继续。',calls:[]}}));
 const response=await s.request(`/api/runner/runs/${s.run.id}/model`,{epoch:s.run.leaseEpoch,requestId:'large_retained_context',messages:[{role:'system',content:'执行浏览器任务。'},{role:'user',content:JSON.stringify({goal:'检查当前页面',userMessages:[{role:'user',content:original}],untrustedPage:page,history:'旧'.repeat(12000)})}]});
 assert.equal(response.status,200,JSON.stringify(response.data));
 assert.ok(s.requests.length<=6,`历史摘要不应产生 ${s.requests.length} 次碎片请求`);
 const last=s.requests.at(-1)!.body.messages.at(-1).content;
 assert.equal(JSON.parse(last).userMessages[0].content,original);assert.deepEqual(JSON.parse(last).untrustedPage,page);
 for(const request of s.requests)assert.ok(new TextEncoder().encode(JSON.stringify(request.body.messages)).length/2<10404);
});

test('运行停止后不继续发起历史摘要请求',async t=>{
 const s=await productionModelFixture(t);
 s.respond(()=>{s.sql.prepare('UPDATE runs SET cancel_requested=1 WHERE id=?').run(s.run.id);return JSON.stringify({summary:'已查看历史。'});});
 const response=await s.request(`/api/runner/runs/${s.run.id}/model`,{epoch:s.run.leaseEpoch,requestId:'stop_during_summary',messages:[{role:'user',content:JSON.stringify({history:'旧记录'.repeat(15000)})}]});
 assert.notEqual(response.status,200);assert.equal(s.requests.length,1);
});

test('ASCII 页面历史按真实编码窗口分块，避免空耗窗口和串行摘要回合',async t=>{
 const s=await productionModelFixture(t);
 s.respond(body=>JSON.stringify(JSON.stringify(body).includes('"summary"')?{summary:'已查看历史页面。'}:{__model:{text:'继续。',calls:[]}}));
 const response=await s.request(`/api/runner/runs/${s.run.id}/model`,{epoch:s.run.leaseEpoch,requestId:'ascii_context_window',messages:[{role:'user',content:JSON.stringify({userMessages:[{role:'user',content:'继续处理当前任务'}],history:'page-node '.repeat(3000)})}]});
 assert.equal(response.status,200,JSON.stringify(response.data));
 assert.ok(s.requests.length<=3,`ASCII 历史产生了 ${s.requests.length} 次请求`);
 for(const request of s.requests)assert.ok(new TextEncoder().encode(JSON.stringify(request.body.messages)).length/2<10404);
});

test('摘要超过建议字数继续按实际窗口合并，不用字段长度拒绝模型结果',async t=>{
 const s=await productionModelFixture(t);
 const original='原'.repeat(3900),page={tree:'页'.repeat(2000)};
 s.respond(body=>JSON.stringify(JSON.stringify(body).includes('"summary"')?{summary:JSON.stringify(body).includes('合并执行事实摘要')?'已查看旧页面。':'旧结果。'.repeat(120)}:{__model:{text:'可以继续',calls:[]}}));
 const response=await s.request(`/api/runner/runs/${s.run.id}/model`,{epoch:s.run.leaseEpoch,requestId:'summary_length_advisory',messages:[{role:'user',content:JSON.stringify({userMessages:[{role:'user',content:original}],untrustedPage:page,history:'旧'.repeat(12000)})}]});
 assert.equal(response.status,200,JSON.stringify(response.data));
 assert.ok(s.requests.some(request=>JSON.stringify(request.body).includes('合并执行事实摘要')));
 assert.equal(JSON.parse(s.requests.at(-1)!.body.messages.at(-1).content).userMessages[0].content,original);
});
