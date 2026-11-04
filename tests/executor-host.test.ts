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
