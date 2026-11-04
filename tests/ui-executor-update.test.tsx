import './ui-dom';
import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {render,fireEvent,cleanup,waitFor} from '@testing-library/react';
import {ExecutorApp} from '../packages/ui/src/executor-app';
import type {DesktopStatus,Transport} from '../packages/contracts/src/index';
afterEach(cleanup);
test('执行器展示新版本，点击才向真实 Transport 请求确认，等待时禁用更新入口',async()=>{
  const calls:string[]=[];
  let changed=()=>{};
  const status:DesktopStatus={paired:true,cloudUrl:'https://example.com',paused:false,online:true,activeRunId:'live-run',version:'0.4.7',autoStart:false,error:null,
    update:{phase:'available',release:{version:'0.4.8',sha1:'a'.repeat(40),sha256:'a'.repeat(64),bytes:10,notes:'改进更新体验',publishedAt:'2026-11-04T00:00:00.000Z'},checkedAt:null,error:null,progress:null}};
  const executor:NonNullable<Transport['desktop']>={status:async()=>structuredClone(status),configure:async()=>({url:'',code:''}),pairPoll:async()=>true,pause:async()=>{},autoStart:async()=>{},stop:async()=>{},diagnostics:async()=>'',subscribe:fn=>{changed=fn;return()=>{};},checkUpdate:async()=>{calls.push('check');},downloadUpdate:async v=>{calls.push(v);status.update.phase='waiting';changed();}};
  const view=render(<ExecutorApp executor={executor}/>);
  await view.findByText('发现新版本 0.4.8');assert.deepEqual(calls,[]);
  fireEvent.click(view.getByRole('button',{name:'检查更新'}));await waitFor(()=>assert.deepEqual(calls,['check']));
  await waitFor(()=>assert.equal((view.getByRole('button',{name:'下载并安装'}) as HTMLButtonElement).disabled,false));
  fireEvent.click(view.getByRole('button',{name:'下载并安装'}));await view.findByText(/下载完成，已暂停领取/);
  assert.deepEqual(calls,['check','0.4.8']);assert.equal(status.activeRunId,'live-run');
  assert.equal(view.queryByRole('button',{name:'下载并安装'}),null);
  assert.equal((view.getByRole('button',{name:'检查更新'}) as HTMLButtonElement).disabled,true);
});
