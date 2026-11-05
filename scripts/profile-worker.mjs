// Runs only a temporary local workerd with synthetic data. No production keys,
// bindings, provider calls, region bypass or live service configuration.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { mkdir,readFile,writeFile,readdir } from 'node:fs/promises';
import path from 'node:path';
const out=path.resolve(process.argv[2]??'.cache/ai-profile/workerd');
await mkdir(out,{recursive:true});
if(!process.argv.includes('--reuse-bundle'))await build({entryPoints:['scripts/perf/worker.ts'],bundle:true,format:'esm',platform:'neutral',mainFields:['module','main'],target:'es2023',conditions:['workerd','worker','browser'],alias:{fs:'node:fs','fs/promises':'node:fs/promises'},banner:{js:"import * as fs from 'node:fs'; import * as fsp from 'node:fs/promises'; const require = name => { if(name==='node:fs')return fs;if(name==='node:fs/promises')return fsp;throw Error('Unexpected require '+name); };"},external:['node:*','cloudflare:*'],outfile:path.join(out,'worker.js'),sourcemap:true});
const mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,inspectorHost:'127.0.0.1',inspectorPort:0,workers:[{name:'taskrelay-cpu-local',scriptPath:path.join(out,'worker.js'),modules:true,compatibilityDate:'2026-11-03',compatibilityFlags:['nodejs_compat'],d1Databases:['DB']}]}));
let socket;
try{
 const db=await mf.getD1Database('DB');
 for(const f of (await readdir('apps/cloud/migrations')).filter(x=>x.endsWith('.sql')).sort()){
  const sql=await readFile(path.join('apps/cloud/migrations',f),'utf8');
  await db.exec(sql.replace(/--[^\n]*/g,'').replace(/\r?\n/g,' '));
 }
 const origin=(await mf.ready).origin;
 const login=await fetch(origin+'/init');if(login.status!==200)throw Error(await login.text());
 const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 const req=async(route,body)=>{
  const r=await fetch(origin+route,{method:body?'POST':'GET',headers:{Cookie:cookie,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const data=await r.json();if(!r.ok)throw Error(JSON.stringify(data));return data;
 };
 await req('/api/user/me');
 const inspector=await mf.getInspectorURL();
 const discovery=new URL('/json',inspector);discovery.protocol='http:';
 const targets=await (await fetch(discovery)).json();
 const target=targets.find(x=>x.title.includes('taskrelay-cpu-local'))??targets[0];
 socket=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
 let id=0;const pending=new Map();
 socket.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}};
 const command=(method,params={})=>new Promise((resolve,reject)=>{const seq=++id;pending.set(seq,{resolve,reject});socket.send(JSON.stringify({id:seq,method,params}));});
 await command('Profiler.enable');await command('Profiler.setSamplingInterval',{interval:100});
 const report={runtime:'local workerd inspector, synthetic provider, local D1',cases:{}};
 for(const [name,route,units] of [['authenticated-read','/api/user/me',1],['crypto-roundtrip','/bench/crypto',10],['checkpoint-roundtrip','/bench/checkpoint',10],['langchain-structured','/bench/model',1],['compose-route',null,1]]){
  const requests=Number(process.env.PROFILE_REQUESTS??24),threads=[];
  if(!route)for(let i=0;i<requests;i++)threads.push(await req('/api/user/threads',{modelId:'model_test'}));
  await command('Profiler.start');
  for(let i=0;i<requests;i++){
   const r=await req(route??`/api/user/threads/${threads[i].id}/messages`,route?undefined:{requestId:'profile-'+i,content:'只读检查 https://example.com/ 的页面正文。'});
   if(!route&&r.status!=='done')throw Error(JSON.stringify(r));
  }
  const {profile}=await command('Profiler.stop');
  await writeFile(path.join(out,name+'.cpuprofile'),JSON.stringify(profile));
  const nodes=new Map(profile.nodes.map(n=>[n.id,n]));let active=0,gc=0,idle=0;const self=new Map();
  for(let i=0;i<(profile.samples??[]).length;i++){
   const f=nodes.get(profile.samples[i]).callFrame,ms=(profile.timeDeltas[i]??0)/1000;
   if(f.functionName==='(idle)'){idle+=ms;continue;}
   if(f.functionName==='(garbage collector)')gc+=ms;
   active+=ms;const key=f.functionName+' '+f.url+':'+(f.lineNumber+1);self.set(key,(self.get(key)??0)+ms);
  }
  report.cases[name]={requests,operations:requests*units,sampledActiveMs:active,sampledGcMs:gc,idleMs:idle,activePerOperationMs:active/(requests*units),topSelf:[...self].sort((a,b)=>b[1]-a[1]).slice(0,15)};
  console.log(name,JSON.stringify({activePerOperationMs:active/(requests*units),sampledActiveMs:active}));
 }
 await writeFile(path.join(out,'summary.json'),JSON.stringify(report,null,2));
}finally{socket?.close();await mf.dispose();}
