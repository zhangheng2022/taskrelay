import test from 'node:test';
import assert from 'node:assert/strict';
import { productionModelFixture } from './production-model-fixture';
import { executeTurn } from '../apps/cloud/src/ai/conversations';
import { enqueue } from '../apps/cloud/src/store';

test('历史报告绑定所选运行和当时任务快照；异步期间新运行不能替换事实',async t=>{
  const s=await productionModelFixture(t);
  const old=s.run.id;
  s.sql.prepare("UPDATE runs SET status='failed',result=?,created_at='2020-01-01' WHERE id=?").run(JSON.stringify({summary:'OLD_RESULT_ONLY'}),old);
  s.sql.prepare("INSERT INTO run_events(id,run_id,sequence,kind,message,at) VALUES('old_event',?,1,'failed','OLD_STEP_ONLY','2020-01-01')").run(old);
  s.env.AI_TURNS={getByName:()=>({enqueue:async()=>{}})} as any;
  const th=(await s.request('/api/user/threads',{kind:'chat',taskId:s.run.taskId,modelId:'model_test'})).data;
  const body={requestId:'old-report',expectedVersion:0,mode:'report',runId:old,content:'生成所选运行报告'};
  const sent=await s.request(`/api/user/threads/${th.id}/messages`,body);
  assert.equal(sent.status,202);
  const newer=await enqueue(s.db,{...s.run.task,title:'NEW_TASK_ONLY'},'newer-report');
  s.sql.prepare("UPDATE runs SET status='succeeded',result=? WHERE id=?").run(JSON.stringify({summary:'NEW_RESULT_ONLY'}),newer.id);
  s.replies('{"reply":"旧运行未完成，有失败步骤"}');
  await executeTurn({...s.env,requestUserId:'legacy_owner'},th.id,sent.data.turnId,'report');
  const prompt=JSON.stringify(s.requests[0].body);
  assert.match(prompt,/OLD_RESULT_ONLY/);assert.match(prompt,/OLD_STEP_ONLY/);
  assert.doesNotMatch(prompt,/NEW_RESULT_ONLY|NEW_TASK_ONLY/);
  assert.equal(s.sql.prepare('SELECT run_id FROM ai_turns WHERE id=?').get(sent.data.turnId)!.run_id,old);
  assert.equal((await s.request(`/api/user/threads/${th.id}/messages`,body)).data.status,'done');
  assert.equal((await s.request(`/api/user/threads/${th.id}/messages`,{...body,runId:newer.id})).data.error,'MESSAGE_CONFLICT');
  assert.equal(s.jobs(),1);
});

test('报告缺少运行、跨用户或跨任务运行均在创建回合和调用模型前拒绝',async t=>{
  const s=await productionModelFixture(t);
  const th=(await s.request('/api/user/threads',{kind:'chat',taskId:s.run.taskId,modelId:'model_test'})).data;
  const body={requestId:'rejected',expectedVersion:0,mode:'report',content:'生成报告'};
  assert.equal((await s.request(`/api/user/threads/${th.id}/messages`,body)).data.error,'REPORT_RUN_REQUIRED');
  assert.equal((await s.request(`/api/user/threads/${th.id}/messages`,{...body,runId:'other_run'})).data.error,'RUN_NOT_FOUND');
  s.sql.prepare("INSERT INTO members(id,role,email) VALUES('other','user','other@example.com')").run();
  s.sql.prepare("UPDATE runs SET user_id='other' WHERE id=?").run(s.run.id);
  assert.equal((await s.request(`/api/user/threads/${th.id}/messages`,{...body,runId:s.run.id})).data.error,'RUN_NOT_FOUND');
  assert.equal(s.sql.prepare('SELECT COUNT(*) n FROM ai_turns').get()!.n,0);assert.equal(s.jobs(),0);
});

test('创建不接受模型拼接的多段判据，明确引用的连续原文仍可生成草稿',async t=>{
  const s=await productionModelFixture(t);
  const th=(await s.request('/api/user/threads',{kind:'compose',modelId:'model_test'})).data;
  const task={title:'提交',goal:'虚构验收',entryUrl:'https://example.com/',allowedOrigins:['https://example.com'],allowedActions:['read'],verification:{kind:'text_present',value:'QA-SUBMITTED；已提交次数：1'},schedule:{kind:'manual'}};
  const reply=JSON.stringify({reply:'请确认',task,partial:'虚构验收',missing:[]});
  s.replies(reply);
  const first=await s.request(`/api/user/threads/${th.id}/messages`,{requestId:'multi',expectedVersion:0,content:'查看 https://example.com/，出现 QA-SUBMITTED，并且已提交次数：1'});
  assert.equal(first.data.status,'done');assert.equal(first.data.draft,null);assert.match(first.data.messages.at(-1).content,/连续的页面原文/);
  assert.equal(s.sql.prepare('SELECT COUNT(*) n FROM tasks').get()!.n,1);
  s.replies(reply);
  const second=await s.request(`/api/user/threads/${th.id}/messages`,{requestId:'literal',expectedVersion:1,content:'页面连续原文为“QA-SUBMITTED；已提交次数：1”'});
  assert.equal(second.data.draft.verification.value,task.verification.value);
});

test('快照和运行详情解释排队阻塞，并分别返回平台与个人预算',async t=>{
  const s=await productionModelFixture(t);
  s.sql.prepare("UPDATE runs SET status='queued',device_id=NULL,started_day=NULL WHERE id=?").run(s.run.id);
  s.sql.prepare('DELETE FROM account_locks').run();
  s.sql.prepare("INSERT INTO platform_budget VALUES(?,'model',99)").run(new Date().toISOString().slice(0,10));
  const get=()=>s.request('/api/user/snapshot',undefined,'GET');
  let snap=(await get()).data;
  assert.equal(snap.platformBudget.used.model,99);assert.equal(snap.platformBudget.limits.model,100);
  assert.notEqual(snap.quota.resetAt,snap.platformBudget.resetAt);
  assert.match(snap.runs[0].queueReason,/最近在线/);
  s.sql.prepare("UPDATE devices SET last_seen=?").run(new Date().toISOString());
  assert.match((await get()).data.runs[0].queueReason,/等待设备领取/);
  s.sql.prepare("UPDATE members SET daily_runs=0 WHERE id='legacy_owner'").run();
  assert.match((await s.request(`/api/user/runs/${s.run.id}`,undefined,'GET')).data.run.queueReason,/启动额度/);
  s.sql.prepare("UPDATE settings SET value='0' WHERE key='claimsEnabled'").run();
  assert.match((await get()).data.runs[0].queueReason,/管理员已暂停/);
});
