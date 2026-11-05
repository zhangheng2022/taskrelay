import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UtilityProcess, utilityProcess } from 'electron';
import { ExecutorHost } from '../apps/desktop/src/main/executor-host';
import { OwnedBrowser } from '../apps/desktop/src/main/browser';
import { Journal } from '../apps/desktop/src/main/journal';
import { run as baseRun } from './ui-fixtures';
import { RunnerPoller } from '../apps/desktop/src/main/runner-poller';
import { DesktopUpdater } from '../apps/desktop/src/main/updater';
import { createHash } from 'node:crypto';
import type {TaskRun} from '../packages/contracts/src/index';

const settle = () => new Promise<void>(r => setImmediate(r));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((a,b) => { resolve=a; reject=b; });
  return {promise,resolve,reject};
}
class Child extends EventEmitter {
  messages: any[] = [];
  killed = false;
  postMessage(value: any) { this.messages.push(value); }
  kill() { this.killed=true; this.emit('exit',0); return true; }
  rpc(p: string, body: unknown = {}) {
    this.emit('message',{generation:this.messages[0].generation,type:'rpc',id:crypto.randomUUID(),path:p,body});
  }
}
function fixture(t: TestContext) {
  const dir=mkdtempSync(path.join(tmpdir(),'relay-host-'));
  const journal=new Journal(dir);
  const children: Child[]=[];
  const browser={launch:async()=>({cdpUrl:'fixture'}),close:async()=>{},recover:async()=>{}};
  const cloud={request:async <T>(_method:string,_path:string,_body?:unknown):Promise<T> => ({leaseExpiresAt:new Date(Date.now()+90000).toISOString(),cancelRequested:false}) as T};
  const host=new ExecutorHost(cloud,journal,browser,'fixture','extension',()=>{},
    (()=>{const c=new Child();children.push(c);return c as unknown as UtilityProcess;}) as typeof utilityProcess.fork);
  const run=(id:string)=>({...baseRun,id,status:'running' as const,leaseExpiresAt:new Date(Date.now()+90000).toISOString()});
  t.after(async()=>{await host.stop();journal.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,journal,children,browser,cloud,host,run};
}

test('云端控制通知立即检查停止，不等待下一次十五秒心跳或模型响应',async t=>{
  const s=fixture(t);let closed=0;
  s.browser.close=async()=>{closed++;};
  await s.host.start(s.run('notify-stop'));
  s.cloud.request=async<T>()=>({leaseExpiresAt:new Date(Date.now()+90000).toISOString(),cancelRequested:true}) as T;
  await s.host.refreshControl();
  assert.equal(closed,1);assert.equal(s.children[0].killed,true);assert.equal(s.host.active,null);
});

test('真实 Poller + Host + Updater：领取响应丢失、人工等待、清理和回传完成前都不安装',async t=>{
  const s=fixture(t),claim=deferred<{run:TaskRun}>();
  const bytes=Buffer.from('update fixture');
  const release={version:'0.4.8',bytes:bytes.length,sha1:createHash('sha1').update(bytes).digest('hex'),sha256:createHash('sha256').update(bytes).digest('hex'),notes:'',publishedAt:new Date().toISOString()};
  let checks=0,requests=0,first=true,allowFlush=false;
  const ids:string[]=[];
  const native=Object.assign(new EventEmitter(),{setFeedURL:()=>{},checkForUpdates:()=>{checks++;}});
  let poller:RunnerPoller;
  const updater=new DesktopUpdater({version:'0.4.7',supported:true,directory:path.join(s.dir,'updates'),native,
    busy:()=>poller.unsettled||!s.host.idleForUpdate||s.journal.pending().length>0||s.journal.incomplete().length>0,
    changed:()=>{},available:()=>{},restart:()=>{},fetcher:async url=>String(url).endsWith('latest.json')?Response.json({release}):new Response(bytes,{headers:{'Content-Length':String(bytes.length)}}),
  });t.after(()=>updater.stop());
  const cloud={paired:true,connect:async()=>({maintenance:false,historyEpoch:3}),request:async<T>(_method:string,p:string,body?:unknown):Promise<T>=>{
    if(p.endsWith('/claim')){requests++;ids.push((body as {requestId:string}).requestId);if(first){first=false;throw Error('OFFLINE');}return await claim.promise as T;}
    return {} as T;
  }};
  s.cloud.request=async<T>()=>{if(!allowFlush)throw Error('OFFLINE');return {} as T;};
  poller=new RunnerPoller(cloud,s.host,s.journal,{quitting:()=>false,blocksClaims:()=>updater.blocksClaims,installing:()=>updater.status.phase==='installing',result:()=>{},settled:()=>updater.tryInstall()});
  await poller.poll();assert.equal(poller.unsettled,true);
  await updater.check();await updater.download(release.version);assert.equal(checks,0);
  // Retry the identical cloud claim even though updates now block fresh claims.
  const pending=poller.poll();await settle();assert.equal(requests,2);assert.equal(ids[0],ids[1]);
  claim.resolve({run:{...s.run('waiting'),status:'waiting_user'}});await pending;
  assert.equal(s.host.active,'waiting');assert.equal(checks,0);assert.equal(s.children[0].killed,false);
  await poller.poll();assert.equal(requests,2);assert.equal(checks,0);
  const closing=deferred<void>();s.browser.close=()=>closing.promise;
  const ending=s.host.stop(false);updater.tryInstall();assert.equal(checks,0);
  closing.resolve();await ending;assert.equal(s.host.idleForUpdate,true);assert.ok(s.journal.pending().length);
  await poller.poll();assert.equal(checks,0);
  allowFlush=true;await poller.poll();assert.equal(checks,1);assert.equal(requests,2);
});

test('Poller 在 connect 等待后重新检查更新门闩，避免新增租约',async t=>{
  const s=fixture(t),connection=deferred<{maintenance:boolean;historyEpoch:number}>();let blocked=false,claims=0;
  const cloud={paired:true,connect:()=>connection.promise,request:async<T>()=>{claims++;return {run:null} as T;}};
  const poller=new RunnerPoller(cloud,s.host,s.journal,{quitting:()=>false,blocksClaims:()=>blocked,installing:()=>false,result:()=>{},settled:()=>{}});
  const pending=poller.poll();blocked=true;connection.resolve({maintenance:false,historyEpoch:3});await pending;
  assert.equal(claims,0);assert.equal(poller.unsettled,false);
});

test('Host 更新空闲状态等待已进入 RPC 的云端请求结束',async t=>{
  const s=fixture(t),response=deferred<unknown>();
  s.cloud.request=async<T>()=>await response.promise as T;
  await s.host.start(s.run('rpc'));
  s.children[0].rpc('/api/runner/runs/rpc/events',{epoch:baseRun.leaseEpoch,events:[{id:'update-event'}]});
  await settle();await s.host.stop();assert.equal(s.host.active,null);assert.equal(s.host.idleForUpdate,false);
  response.resolve({});await settle();assert.equal(s.host.idleForUpdate,true);
});

for(const outcome of ['expired','success'] as const) test(`正式 Host：旧心跳 ${outcome} 不停止或缩短新运行租约`,async t=>{
  const s=fixture(t),old=deferred<any>();
  t.mock.timers.enable({apis:['setInterval','Date']});
  t.mock.method(s.cloud,'request',async(_method:string,p:string)=>p.includes('/old/') ? old.promise : {leaseExpiresAt:new Date(Date.now()+90000).toISOString(),cancelRequested:false});
  await s.host.start(s.run('old'));
  t.mock.timers.tick(15000);await settle();
  await s.host.stop();
  await s.host.start(s.run('new'));
  if(outcome==='expired')old.reject(Error('LEASE_EXPIRED'));
  else old.resolve({leaseExpiresAt:new Date(0).toISOString(),cancelRequested:true});
  await settle();
  t.mock.timers.tick(15000);await settle();
  assert.equal(s.host.active,'new');assert.equal(s.children[1].killed,false);
  assert.equal(s.children[1].messages.some(m=>m.type==='cancel'),false);
});

test('正式 Host：停止期间拒绝新 RPC，清理失败保持占用并可重试',async t=>{
  const s=fixture(t),closing=deferred<void>();let launches=0;
  s.browser.close=()=>closing.promise;
  s.browser.launch=async()=>{launches++;return {cdpUrl:'fixture'};};
  await s.host.start(s.run('old'));
  const stopping=s.host.stop();
  s.children[0].rpc('local:browser',{accountId:baseRun.profileId,proxyPort:1234});
  await settle();assert.equal(launches,0);
  await assert.rejects(s.host.start(s.run('new')),/EXECUTOR_BUSY/);
  closing.reject(Error('CLEANUP_FAILED'));
  await assert.rejects(stopping,/CLEANUP_FAILED/);assert.equal(s.host.active,'old');
  s.browser.close=async()=>{};await s.host.stop();assert.equal(s.host.active,null);
  await s.host.start(s.run('new'));
  s.children[0].rpc('local:checkpoint',{state:'intent',payload:{writePending:true}});
  await settle();assert.equal(s.journal.incomplete().find(r=>r.run_id==='new')?.state,'claimed');
});

test('正式 OwnedBrowser：启动中停止使启动失效，且等待清理完成',async t=>{
  const s=fixture(t);
  writeFileSync(path.join(s.dir,'manifest.json'),JSON.stringify({executable:'must-not-be-read.exe'}));
  const browser=new OwnedBrowser(s.dir,path.join(s.dir,'profiles'),s.journal);
  const launch=browser.launch('profile',1234);
  const rejected=assert.rejects(launch,/BROWSER_START_CANCELLED/);
  const close=browser.close();
  await assert.rejects(browser.launch('other',1234),/BROWSER_ALREADY_RUNNING/);
  await Promise.all([close,rejected]);assert.equal(s.journal.get('ownedBrowser'),null);
});

test('正式 Host：恢复保留 unknown 与已有终态 outbox，失败上传可再次投递',async t=>{
  const s=fixture(t);
  s.journal.checkpoint('uncertain','g',1,'finishing',{status:'unknown'});
  s.journal.checkpoint('known','g',1,'finishing',{status:'succeeded'});
  s.journal.queue('finish_known','/api/runner/runs/known/finish',{epoch:1,status:'succeeded'});
  await s.host.recover();
  assert.equal(JSON.parse(s.journal.pending().find(r=>r.id==='finish_uncertain')!.body).status,'unknown');
  assert.equal(JSON.parse(s.journal.pending().find(r=>r.id==='finish_known')!.body).status,'succeeded');
  assert.equal(s.journal.incomplete().length,0);
  t.mock.method(s.cloud,'request',async()=>{throw Error('OFFLINE');});
  await assert.rejects(s.host.flush(),/OFFLINE/);assert.equal(s.journal.pending().length,2);
  t.mock.restoreAll();await s.host.flush();assert.equal(s.journal.pending().length,0);
});

test('正式 Host：旧指令完成请求被明确拒绝后不保留待上传成功，网络失败仍保留',async t=>{
  const s=fixture(t);
  await s.host.start(s.run('steered'));
  s.cloud.request=async()=>{throw Error('INSTRUCTIONS_CHANGED');};
  s.children[0].rpc('/api/runner/runs/steered/finish',{epoch:baseRun.leaseEpoch,instructionVersion:0,status:'succeeded'});
  await settle();
  assert.equal(s.journal.pending().length,0);
  assert.ok(s.children[0].messages.some(m=>m.error==='INSTRUCTIONS_CHANGED'));
  s.cloud.request=async()=>{throw Error('OFFLINE');};
  s.children[0].rpc('/api/runner/runs/steered/finish',{epoch:baseRun.leaseEpoch,instructionVersion:1,status:'succeeded'});
  await settle();assert.equal(s.journal.pending().length,1);
});
