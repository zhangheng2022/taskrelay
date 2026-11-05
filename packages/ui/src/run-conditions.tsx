import { useRef, useState } from 'react';
import type { Snapshot, TaskDefinition, Transport } from '../../contracts/src/index';
import type { ThreadPage } from './use-thread';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './components/ui/card';
import { Button } from './components/ui/button';
import { NativeSelect } from './components/ui/native-select';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';
import { FieldGroup } from './components/ui/field';
import { Field } from './task-editor';
import { ModelSelector } from './model-selector';
import { ErrorText } from './feedback';

export function RunConditions({card,task,snapshot,transport,refresh,disabled,onMessage}: {
  card:NonNullable<ThreadPage['conditions']>;task:TaskDefinition;snapshot:Snapshot;transport:Transport;
  refresh:()=>Promise<void>;disabled:boolean;onMessage:(text:string)=>void;
}) {
  const [conditions,setConditions]=useState(()=>JSON.parse(card.confirmed_content??card.content) as {goal:string;scope:string;prerequisites:string[];completion:string;assistance:string[]});
  const [modelId,setModelId]=useState(task.modelId),[accountId,setAccountId]=useState(task.accountId??'');
  const [frequency,setFrequency]=useState<string>(task.schedule.kind==='cron'?'custom':task.schedule.kind);
  const [time,setTime]=useState('09:00'),[date,setDate]=useState(''),[expression,setExpression]=useState(task.schedule.kind==='cron'?task.schedule.expression:'0 9 * * *');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const request=useRef<Record<string,unknown>|null>(null);
  const approved=!!task.confirmedCondition&&task.confirmedCondition===card.run_id&&card.approved_version===task.version;
  const stale=card.task_version!==task.version&&card.approved_version!==task.version;
  async function confirm(){
    if(busy)return;setBusy(true);setError('');
    try{
      const [hour,minute]=time.split(':');
      const schedule=frequency==='manual'?{kind:'manual'}:frequency==='once'?{kind:'once',at:new Date(date+':00+08:00').toISOString()}:
        {kind:'cron',expression:frequency==='daily'?`${Number(minute)} ${Number(hour)} * * *`:frequency==='weekly'?`${Number(minute)} ${Number(hour)} * * 1`:expression,timezone:'Asia/Shanghai'};
      request.current??={requestId:crypto.randomUUID(),runId:card.run_id,expectedVersion:task.version,conditions,schedule,modelId,accountId:accountId||null};
      await transport.request('POST',`/api/user/tasks/${task.id}/conditions`,request.current);
      request.current=null;await refresh();
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const locked=disabled||busy||!!request.current;
  return <Card>
    <CardHeader><CardTitle>运行条件卡{approved?'':'草稿'}</CardTitle><CardDescription>{stale?'要求已修改，需要按新要求成功运行后重新总结。':approved?'已确认，可再次运行或修改执行安排。':'本次执行已成功。请核对条件，选择执行频率、模型和账号后确认。'}</CardDescription></CardHeader>
    <CardContent><FieldGroup>
      <Field label="任务目标"><Textarea disabled={locked||stale} value={conditions.goal} onChange={e=>setConditions({...conditions,goal:e.target.value})}/></Field>
      <Field label="处理范围"><Textarea disabled={locked||stale} value={conditions.scope} onChange={e=>setConditions({...conditions,scope:e.target.value})}/></Field>
      <Field label="运行前提"><Textarea disabled={locked||stale} value={conditions.prerequisites.join('\n')} onChange={e=>setConditions({...conditions,prerequisites:e.target.value.split('\n')})}/></Field>
      <Field label="完成含义"><Textarea disabled={locked||stale} value={conditions.completion} onChange={e=>setConditions({...conditions,completion:e.target.value})}/></Field>
      <Field label="需要我协助时"><Textarea disabled={locked||stale} value={conditions.assistance.join('\n')} onChange={e=>setConditions({...conditions,assistance:e.target.value.split('\n')})}/></Field>
      <Field label="执行频率"><NativeSelect disabled={locked||stale} value={frequency} onChange={e=>setFrequency(e.target.value as typeof frequency)}><option value="manual">仅手动执行</option><option value="once">指定时间执行一次</option><option value="daily">每天</option><option value="weekly">每周一</option><option value="custom">自定义周期</option></NativeSelect></Field>
      {['daily','weekly'].includes(frequency)&&<Field label="执行时间（北京时间）"><Input type="time" disabled={locked} value={time} onChange={e=>setTime(e.target.value)}/></Field>}
      {frequency==='once'&&<Field label="执行日期时间（北京时间）"><Input type="datetime-local" disabled={locked} value={date} onChange={e=>setDate(e.target.value)}/></Field>}
      {frequency==='custom'&&<Field label="自定义周期" hint="也可以在对话里描述执行时间。"><Input disabled={locked} value={expression} onChange={e=>setExpression(e.target.value)}/></Field>}
      <Field label="执行模型"><ModelSelector models={snapshot.models} value={modelId} onChange={setModelId} disabled={locked||stale}/></Field>
      <Field label="站点账号"><NativeSelect value={accountId} onChange={e=>setAccountId(e.target.value)} disabled={locked||stale}><option value="">使用本任务独立登录环境</option>{snapshot.accounts.filter(a=>a.origin===new URL(task.entryUrl).origin).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</NativeSelect></Field>
      <p className="text-xs text-muted-foreground">网站：{task.entryUrl} · 来源运行：{card.run_id}{task.nextRunAt?` · 下次执行：${new Date(task.nextRunAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`:''}</p>
      {error&&<ErrorText error={error}/>}
    </FieldGroup></CardContent>
    <CardFooter className="flex flex-wrap gap-2"><Button disabled={disabled||busy||stale} onClick={()=>void confirm()}>{request.current?'重试确认':approved?'保存执行安排':'确认运行条件'}</Button><Button variant="outline" disabled={disabled||busy} onClick={()=>onMessage('按当前要求再运行一次')}>再次运行</Button></CardFooter>
  </Card>;
}
