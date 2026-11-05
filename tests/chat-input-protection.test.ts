import test from 'node:test';
import assert from 'node:assert/strict';
import {productionModelFixture} from './production-model-fixture';
import {appendMessage,conversationContext} from '../apps/cloud/src/chat-messages';
import {retainHistory} from '../apps/cloud/src/ai/lifecycle';

test('历史维护在运行结束后加密提前回复并清理工具回显，保留本人原文且可重入',async t=>{
 const s=await productionModelFixture(t);
 const thread=(await s.request('/api/user/threads',{modelId:'model_test',taskId:s.run.taskId})).data;
 s.sql.prepare('UPDATE runs SET thread_id=? WHERE id=?').run(thread.id,s.run.id);
 const original='00early! "空 格"';
 await appendMessage(s.env,thread.id,{id:'early_plaintext',role:'user',source:'user',runId:s.run.id,content:original});
 await appendMessage(s.env,thread.id,{id:'plain_echo',source:'executor',runId:s.run.id,content:'正在填写 '+original,
  parts:[{type:'tool',name:'act',result:JSON.stringify({actions:[{arguments:[original]}]})}]});
 await appendMessage(s.env,thread.id,{id:'unrelated',source:'executor',runId:s.run.id,content:'未受影响',parts:[]});
 await appendMessage(s.env,thread.id,{id:'tool_only',source:'executor',runId:s.run.id,content:'填写成功',parts:[{type:'tool',name:'act',result:JSON.stringify({value:original})}]});
 const cutoff='2000-01-01T00:00:00Z';
 await retainHistory(s.env,cutoff);
 assert.equal(s.sql.prepare("SELECT private_content FROM ai_messages WHERE id='early_plaintext'").get()!.private_content,null);
 assert.equal(s.sql.prepare("SELECT key FROM settings WHERE key='chatInputProtectionBackfillV1'").get(),undefined);
 s.sql.prepare("UPDATE runs SET status='succeeded' WHERE id=?").run(s.run.id);
 await retainHistory(s.env,cutoff);
 const raw=s.sql.prepare('SELECT * FROM ai_messages WHERE thread_id=?').all(thread.id);
 assert.ok(!JSON.stringify(raw).includes('00early!'));
 assert.ok(raw.find(m=>m.id==='early_plaintext')!.private_content);
 const echo=raw.find(m=>m.id==='plain_echo')!;
 assert.ok(echo.private_content);assert.ok(JSON.parse(String(echo.parts))[0].result.includes('[已隐藏]'));
 assert.equal(raw.find(m=>m.id==='unrelated')!.content,'未受影响');
 const context=await conversationContext(s.env,thread.id,0,{runId:s.run.id});
 assert.ok(context.some(m=>m.id==='early_plaintext'&&m.content===original&&m.private));
 const page=(await s.request(`/api/user/threads/${thread.id}`,undefined,'GET')).data;
 assert.ok(page.messages.some((m:any)=>m.content===original));
 await retainHistory(s.env,cutoff);
 assert.deepEqual(s.sql.prepare('SELECT * FROM ai_messages WHERE thread_id=?').all(thread.id),raw);
});
