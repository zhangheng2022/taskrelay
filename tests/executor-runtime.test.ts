import test from 'node:test';
import assert from 'node:assert/strict';
import { execute, type RuntimePort } from '../apps/desktop/src/executor/runtime';
import { hash } from '../packages/contracts/src/security';
import { run as baseRun } from './ui-fixtures';
import type { BrowserAction } from '../packages/contracts/src/index';

async function scenario(options: {action?:Partial<BrowserAction>;fault?:string;reconcile?:boolean;cancelAt?:string;human?:boolean;continueAfterHuman?:boolean}={}) {
  const calls:{path:string;body:any}[]=[],checkpoints:{state:string;payload:any}[]=[],timeline:string[]=[];
  let text='待处理',value='',clicks=0,fills=0,cancelled=false,closed=false,proxyClosed=false;
  const target={tag:'BUTTON',type:'submit',text:'提交',href:null,form:[]};
  const page={
    goto:async()=>{},url:async()=> 'https://example.com/',
    evaluate:async(_fn:unknown,arg?:unknown)=>arg ? target : [],
    locator:(_selector:string)=>({count:async()=>options.fault==='missing-target'?0:1,innerText:async()=>{if(options.fault==='observe'&&clicks)throw Error('PAGE_OBSERVATION_FAILED');return text;},
      click:async()=>{timeline.push('click');clicks++;text='成功';if(options.fault==='click')throw Error('CONNECTION_LOST');},
      fill:async(v:string)=>{fills++;value=v;if(!options.continueAfterHuman)text='成功';},inputValue:async()=>value}),
  };
  const sdk={localBrowser:{connect:async()=>({context:{setDomainPolicy:async()=>{},pages:async()=>[page]}})},
    Stagehand:{create:async()=>({close:async()=>{closed=true;}})}};
  const action={kind:options.human?'human':'click',instruction:'提交虚构表单',effect:'submit',target:'#submit',value:null,challengeKind:null,...options.action};
  const run={...baseRun,status:'running' as const,task:{...baseRun.task,allowedActions:['read','navigate','fill','submit'] as any,verification:{kind:'text_present' as const,value:'成功'}},...(options.reconcile?{reconciliationOf:'old'}:{})};
  const port:RuntimePort={cancelled:()=>cancelled,checkpoint:async(state,payload)=>{
    timeline.push(`checkpoint:${state}`);checkpoints.push({state,payload});if(options.cancelAt===state)cancelled=true;
    if(options.fault===state)throw Error('CHECKPOINT_INTERRUPTED');
  },rpc:async<T>(p:string,b?:any)=>{
    timeline.push(`rpc:${p.split('/').at(-1)}`);calls.push({path:p,body:b});
    if(options.cancelAt===p.split('/').at(-1))cancelled=true;
    if(p==='local:browser')return {cdpUrl:'fixture'} as T;
    if(p.endsWith('/plan'))return (options.continueAfterHuman&&fills?{...action,kind:'finish'}:action) as T;
    if(p.endsWith('/intent'))return {status:'intended',digest:await hash(JSON.stringify({action:b.action,url:b.url,facts:b.facts}))} as T;
    if(p.endsWith('/challenges'))return {id:'challenge',kind:action.challengeKind??'information',stepId:'step',version:1,target:'#code'} as T;
    if(p.endsWith('/consume'))return {ready:true,value:'0012Ab',confirmed:true} as T;
    if(p.endsWith('/credentials'))return {username:'fictional',password:'fixture'} as T;
    if(p.endsWith('/finish')&&options.fault==='finish')throw Error('OFFLINE');
    return {} as T;
  }};
  await execute(run,port,{loadSdk:async()=>sdk as any,startProxy:async()=>({port:1234,close:async()=>{proxyClosed=true;}}),delay:async()=>{}});
  return {calls,checkpoints,timeline,clicks,fills,value,closed,proxyClosed,finishes:calls.filter(c=>c.path.endsWith('/finish')).map(c=>c.body)};
}
test('正式 execute：检查点和云端意图先于唯一提交，重新观察后程序核验成功',async()=>{
  const s=await scenario();assert.equal(s.clicks,1);assert.equal(s.finishes[0].status,'succeeded');
  assert.ok(s.checkpoints.some(x=>x.state==='intent'&&x.payload.writePending));
  for(const predecessor of ['checkpoint:intent','rpc:intent'])assert.ok(s.timeline.indexOf(predecessor)>=0&&s.timeline.indexOf(predecessor)<s.timeline.indexOf('click'));
  assert.ok(s.timeline.indexOf('click')<s.timeline.indexOf('rpc:action-complete'));
  assert.ok(s.calls.findIndex(x=>x.path.endsWith('/intent'))<s.calls.findIndex(x=>x.path.endsWith('/action-complete')));
  assert.equal(s.closed,true);assert.equal(s.proxyClosed,true);
});
for(const fault of ['click','observe','finish'])test(`正式 execute：${fault} 故障不重复提交并保留未知结果`,async()=>{
  const s=await scenario({fault});assert.equal(s.clicks,1);assert.equal(s.finishes.at(-1).status,'unknown');
  assert.equal(s.checkpoints.filter(x=>x.state==='intent').length,1);
  assert.equal(s.closed,true);assert.equal(s.proxyClosed,true);
});
test('正式 execute：提交前取消与只读核查均不执行写操作',async()=>{
  const cancelled=await scenario({cancelAt:'intent'});assert.equal(cancelled.clicks,0);
  const readOnly=await scenario({reconcile:true});assert.equal(readOnly.clicks,0);assert.equal(readOnly.finishes[0].result.errorCode,'RECONCILIATION_READ_ONLY');
});
test('正式 execute：人工回复保持原文，先写消费检查点，确认站点后才 ACK',async()=>{
  const s=await scenario({human:true,action:{challengeKind:'code'}});
  assert.equal(s.value,'0012Ab');assert.equal(s.fills,1);assert.equal(s.finishes[0].status,'succeeded');
  assert.ok(s.checkpoints.some(c=>c.state==='human-delivery'&&c.payload.writePending));
  assert.ok(s.calls.some(c=>c.path.endsWith('/ack')));
  assert.doesNotMatch(JSON.stringify(s.calls.filter(c=>c.path.endsWith('/events'))),/0012Ab/);
});
test('正式 execute：消费后停止或凭据请求晚到均禁止继续填写',async()=>{
  const s=await scenario({human:true,cancelAt:'human-delivery'});assert.equal(s.fills,0);assert.equal(s.finishes[0].status,'unknown');
  assert.equal(s.calls.some(c=>c.path.endsWith('/ack')),false);
  const c=await scenario({action:{kind:'credential',target:'#password',value:'password',effect:'read'},cancelAt:'credentials'});
  assert.equal(c.fills,0);assert.equal(c.finishes[0].status,'unknown');
});
test('正式 execute：协助后规划包含已填写目标，不含回复原文',async()=>{
  const s=await scenario({human:true,continueAfterHuman:true,action:{challengeKind:'information'}});
  const plans=s.calls.filter(c=>c.path.endsWith('/plan'));
  assert.equal(plans.length,2);assert.equal(s.fills,1);
  const history=plans[1].body.history.join('\n');
  assert.match(history,/#submit/);assert.match(history,/读回一致/);
  assert.doesNotMatch(history,/0012Ab/);
  assert.equal(s.finishes.at(-1).status,'unknown'); // Filled is not business success.
});
test('正式 execute：缺少目标或目标不存在时，不创建协助、不消费回复、不标记写入',async()=>{
  for(const options of [{human:true,action:{target:null}},{human:true,fault:'missing-target'}]){
    const s=await scenario(options);
    assert.equal(s.fills,0);assert.equal(s.finishes[0].status,'failed');
    assert.equal(s.calls.some(c=>c.path.endsWith('/challenges')||c.path.endsWith('/consume')),false);
    assert.equal(s.checkpoints.some(c=>c.state==='human-delivery'),false);
  }
});
