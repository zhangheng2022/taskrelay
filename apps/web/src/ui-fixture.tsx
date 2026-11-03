// Dedicated development entry, not imported by index.html or included in production build.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {TaskEditor} from '../../../packages/ui/src/task-editor';
import type {Snapshot,TaskInput,Transport} from '../../../packages/contracts/src/index';
import '../../../packages/ui/src/styles.css';
const draft:TaskInput={title:'演示 · 每日查询',goal:'每天上午9点查询 https://example.com 的信息',entryUrl:'https://example.com/',allowedOrigins:['https://example.com'],accountId:null,modelId:'fixture_model',allowedActions:['read','navigate'],verification:{kind:'text_present',value:'操作成功'},schedule:{kind:'cron',expression:'0 9 * * *',timezone:'Asia/Shanghai'}};
const snapshot:Snapshot={tasks:[],runs:[],accounts:[],devices:[],challenges:[],serverTime:new Date().toISOString(),models:[{id:'fixture_model',version:1,name:'模拟模型（仅界面验收）',baseUrl:'https://example.com/v1',model:'fixture',protocol:'chat',hasKey:true,inputPrice:null,outputPrice:null,capabilities:{connection:true,tools:true,structured:'schema',vision:false,testedAt:null}}]};
const transport:Transport={request:async<T,>(_method:string,path:string):Promise<T>=>{if(path==='/api/user/tasks/draft')return draft as T;throw new Error('UI_FIXTURE_ONLY');}};
if(import.meta.env.DEV)createRoot(document.getElementById('root')!).render(<><p>界面验收夹具，全部数据为模拟；不会创建真实任务。</p><TaskEditor task={null} snapshot={snapshot} transport={transport} onClose={()=>{}} onSaved={async()=>{}}/></>);
