// Isolated CPU benchmark: real application interfaces, in-memory SQLite and a
// test-only egress/provider adapter. Never reads production credentials or calls
// a real model. Node CPU measurements are not Cloudflare billing measurements.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { productionModelFixture } from '../tests/production-model-fixture';
import { identity } from '../apps/cloud/src/identity';
import { app } from '../apps/cloud/src/index';
import { structuredGraph } from '../apps/cloud/src/ai/graph';
import { D1Checkpointer } from '../apps/cloud/src/ai/checkpointer';
import { seal, unseal } from '../apps/cloud/src/crypto';

test('isolated application CPU profile', async t => {
  const out=resolve(process.env.PROFILE_OUTPUT ?? '.cache/ai-profile/current');
  await mkdir(out,{recursive:true});
  const s=await productionModelFixture(t);
  Object.assign(s.env,{AUTH_SECRET:'isolated-profiling-secret-at-least-32-characters',AUTH_BASE_URL:'http://localhost',OWNER_EMAIL:'profile@example.com'});
  const at=Date.now(),password='isolated-profiling-password';
  s.sql.prepare('INSERT INTO auth_user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run('profiler','Profiler','profile@example.com',at,at);
  s.sql.prepare("INSERT INTO auth_account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,'credential',?,?,?,?)").run('profiler','profiler','profiler',await hashPassword(password),at,at);
  const login=await identity(s.env).handler(new Request('http://localhost/api/auth/sign-in/email',{method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json'},body:JSON.stringify({email:'profile@example.com',password})}));
  assert.equal(login.status,200);
  const headers={Cookie:login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),'Content-Type':'application/json'};
  s.env.DEV_MODE='0';
  s.sql.prepare('UPDATE members SET daily_models=10000,daily_chat=10000').run();
  s.env.requestUserId='legacy_owner';
  const request=async(path:string,body?:unknown)=>{
    const r=await app.request('http://localhost'+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined},s.env);
    const data=await r.json() as any;
    assert.equal(r.status,200,JSON.stringify(data));return data;
  };
  await request('/api/user/me');
  const profiler=new Session();profiler.connect();
  await profiler.post('Profiler.enable');
  await profiler.post('Profiler.setSamplingInterval',{interval:100});
  const report:any={runtime:process.version,platform:process.platform,measurement:'Node process CPU; synthetic provider; no network; not deployed CPU',cases:{}};
  async function measure(name:string,run:(i:number)=>Promise<void>,prepare?:(i:number)=>Promise<void>){
    const rows=[];
    await profiler.post('Profiler.start');
    for(let i=0;i<21;i++){
      await prepare?.(i);
      const cpu=process.cpuUsage(),wall=performance.now();await run(i);
      const used=process.cpuUsage(cpu);rows.push({cpuMs:(used.user+used.system)/1000,wallMs:performance.now()-wall});
    }
    const {profile}=await profiler.post('Profiler.stop');
    await writeFile(resolve(out,name+'.cpuprofile'),JSON.stringify(profile));
    const sorted=rows.slice(1).map(x=>x.cpuMs).sort((a,b)=>a-b);
    report.cases[name]={first:rows[0],warmCpuMeanMs:sorted.reduce((a,b)=>a+b,0)/sorted.length,warmCpuP50Ms:sorted[9],warmCpuP95Ms:sorted[18],rows};
  }
  await measure('authenticated-read',async()=>{await request('/api/user/me');});
  const value={text:'中文 checkpoint '.repeat(700)};
  await measure('crypto-roundtrip',async()=>{assert.deepEqual(await unseal(await seal(value,s.env.MASTER_KEY,'profile'),s.env.MASTER_KEY,'profile'),value);});
  const saver=new D1Checkpointer(s.db,'legacy_owner',s.env.MASTER_KEY);
  await measure('checkpoint-roundtrip',async i=>{
    const c={configurable:{thread_id:'cp-'+i}},cp=emptyCheckpoint();cp.id=String(i);cp.channel_values={output:value};
    const saved=await saver.put(c,cp,{source:'input',step:0,parents:{}});assert.ok(await saver.getTuple(saved));
  });
  const schema=z.object({reply:z.string()});
  await measure('structured-graph',async i=>{
    assert.deepEqual(await structuredGraph({env:s.env,owner:'legacy_owner',id:'profile-graph-'+i,kind:'chat',modelId:'model_test',version:1,schema,messages:[{role:'user',content:'只读查询'}]}),{reply:'ok'});
  },async()=>{s.replies('{"reply":"ok"}');});
  let thread:any;
  await measure('compose-route',async i=>{
    const result=await request(`/api/user/threads/${thread.id}/messages`,{requestId:'profile-'+i,expectedVersion:0,content:'只读检查 https://example.com/ 的页面正文。'});
    assert.equal(result.status,'done',JSON.stringify(result));
  },async()=>{
    thread=await request('/api/user/threads',{kind:'compose',modelId:'model_test'});
    s.replies(JSON.stringify({reply:'请提供成功判据',task:null,partial:'只读检查 example.com',missing:['成功判据']}));
  });
  profiler.disconnect();
  report.providerCalls=s.requests.length;
  await writeFile(resolve(out,'summary.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({out,cases:Object.fromEntries(Object.entries(report.cases).map(([k,v]:[string,any])=>[k,{first:v.first.cpuMs,mean:v.warmCpuMeanMs,p50:v.warmCpuP50Ms,p95:v.warmCpuP95Ms}]))},null,2));
});
