import './ui-dom';
import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {render,fireEvent,cleanup,waitFor,act} from '@testing-library/react';
import {Conversation} from '../packages/ui/src/conversation';
import {snapshot,task,run,transportWith,threadPage} from './ui-fixtures';
afterEach(cleanup);
test('统一聊天：协助和补充都使用同一个输入框与消息入口',async()=>{
 const writes:any[]=[];let page:any={...threadPage,taskId:task.id,waiting:{id:'help',request:'{}'},messages:[{id:'help-message',seq:1,role:'assistant',source:'cloud',content:'请输入验证码',parts:[]}]};
 const transport=transportWith(async(method,path,body)=>{
  if(method==='GET'&&path==='/api/user/threads')return [{id:page.id,model_id:task.modelId,task_id:task.id}];
  if(method==='POST'&&path.endsWith('/messages')){writes.push({path,body});page={...page,waiting:null,messages:[...page.messages,{id:'reply',seq:2,role:'user',content:body.content,parts:[]}]};}
  return page;
 });
 const v=render(<Conversation transport={transport} snapshot={snapshot} task={task} run={run} challenges={[]} offline={false} refresh={async()=>{}} onEdit={()=>{}}/>);
 await waitFor(()=>assert.ok(v.getByText('请输入验证码')));assert.equal(v.getAllByRole('textbox').length,1);assert.equal(v.queryByRole('combobox',{name:'消息用途'}),null);
 fireEvent.change(v.getByRole('textbox'),{target:{value:'0012Ab'}});fireEvent.click(v.getByRole('button',{name:'发送消息'}));
 await waitFor(()=>assert.equal(writes.length,1));assert.deepEqual(Object.keys(writes[0].body).sort(),['content','requestId']);assert.equal(writes[0].body.content,'0012Ab');
});
test('截图直接显示在聊天，不渲染旧运行事件卡；停止不调用模型消息',async()=>{
 const writes:any[]=[];const page={...threadPage,taskId:task.id,messages:[{id:'image_message',seq:1,role:'assistant',source:'executor',content:'当前页面',parts:[{type:'image',artifactId:'image_one',alt:'执行现场'}]}]};
 const transport=transportWith(async(method,path,body)=>{
  if(method==='GET'&&path==='/api/user/threads')return [{id:page.id,model_id:task.modelId,task_id:task.id}];
  if(path.includes('/artifacts/'))return {dataUrl:'data:image/png;base64,aGVsbG8='};
  if(method==='POST')writes.push({path,body});return page;
 });
 const v=render(<Conversation transport={transport} snapshot={snapshot} task={task} run={{...run,status:'running'}} challenges={[]} offline={false} refresh={async()=>{}} onEdit={()=>{}}/>);
 await waitFor(()=>assert.ok(v.getByRole('img',{name:'执行现场'})));assert.equal(v.queryByText(/页面快照 #/),null);
 fireEvent.click(v.getByRole('button',{name:'停止执行'}));await waitFor(()=>assert.equal(writes.length,1));assert.ok(writes[0].path.endsWith('/cancel'));
});

test('连续运行通知合并读取，不饿死聊天刷新',async()=>{
 let notify=()=>{},pending:((value:any)=>void)|undefined,reads=0;
 const page={...threadPage,taskId:task.id,messages:[]};
 const transport=transportWith(async(method,path)=>{
  if(path==='/api/user/threads')return [{id:page.id,model_id:task.modelId,task_id:task.id}];
  reads++;if(reads===1)return page;
  return new Promise(resolve=>{pending=resolve;});
 });
 transport.subscribe=fn=>{notify=fn;return()=>{};};
 const v=render(<Conversation transport={transport} snapshot={snapshot} task={task} run={run} challenges={[]} offline={false} refresh={async()=>{}} onEdit={()=>{}}/>);
 await waitFor(()=>assert.equal(v.getByRole('textbox').hasAttribute('disabled'),false));
 await act(async()=>{notify();notify();notify();});
 assert.equal(reads,2);
 await act(async()=>{pending!({...page,messages:[{id:'new',seq:1,role:'assistant',source:'executor',content:'刚刚执行完成',parts:[]}]});});
 await waitFor(()=>assert.ok(v.getByText('刚刚执行完成')));
});
