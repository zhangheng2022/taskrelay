import {useState,useRef} from 'react';
import type {TaskDefinition,TaskRun,Transport} from '../../contracts/src/index';
import {useThread} from './use-thread';
import {Thread,Composer,ChatMessage,ThreadActivity,SendingMessage} from './chat-parts';
import {MessageScrollerItem} from './components/ui/message-scroller';
import {Button} from './components/ui/button';
import {ErrorText,LoadFeedback} from './feedback';
import {ChatAttachments} from './chat-attachments';
import {conversationRows,ExecutionProgress} from './execution-progress';

// 将用户消息、云端协助和执行器反馈合并到同一聊天；停止直接调用运行控制接口。
// run 由工作空间选择当前活动运行，历史记录入口不会把停止按钮绑定到旧运行。
export function Conversation({transport,task,run,runs=[],offline,refresh}: {
  transport:Transport;task:TaskDefinition;run:TaskRun|null;
  runs?:TaskRun[];
  refresh:()=>Promise<void>;offline:boolean;
}){
  const thread=useThread(transport,'chat',task.modelId,task.id);
  const [text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [stopping,setStopping]=useState(false);
  const sending=useRef(false);
  const active=run&&(['queued','running','waiting_user','verifying'].includes(run.status)||run.cleanupPending||run.dispatchGroupActive);
  const runLabels=new Map(runs.map(item=>[item.id,item.accountName]));
  if(run?.accountName)runLabels.set(run.id,run.accountName);
  let activity:string|null=null;
  if(thread.sending)activity='正在发送…';
  else if(thread.page?.activeTurn)activity='云端助手正在处理…';
  else if(active){
    if(run.status==='unknown')activity='本次操作结果待核查，后续账号已暂停';
    else if(run.cleanupPending&&!['running','waiting_user','verifying'].includes(run.status))activity='正在结束本次执行…';
    else if(thread.page?.waiting||run.status==='waiting_user')activity='等待你的回复';
    else if(run.status==='queued')activity='等待执行设备';
    else if(run.cancelRequested)activity='正在停止…';
    else activity='执行器正在处理…';
  }
  const messages=[...(thread.page?.messages??[]),...(thread.page?.replies??[]).map(m=>({...m,seq:m.cursor}))].sort((a,b)=>(a.at??'').localeCompare(b.at??'')||a.seq-b.seq);
  async function send(){
    if(sending.current||!text.trim()||offline)return;
    sending.current=true;setBusy(true);setError('');const value=text;setText('');
    try{await thread.send(value);}catch(e){setText(value);setError((e as Error).message);}finally{sending.current=false;setBusy(false);}
  }
  async function stop(){
    if(!run)return;setStopping(true);setError('');
    try{await transport.request('POST',`/api/user/runs/${run.id}/cancel`,{});await refresh();}catch(e){setError((e as Error).message);}finally{setStopping(false);}
  }
  return <div className="flex min-h-0 flex-1 flex-col">
    <Thread followRequest={thread.sending?.id}>
      {(thread.loading||thread.error)&&<MessageScrollerItem messageId="loading"><LoadFeedback loading={thread.loading} error={thread.error} label="正在加载聊天…" onRetry={thread.retry}/></MessageScrollerItem>}
      {(thread.page?.nextCursor||thread.page?.nextReplyCursor)&&<MessageScrollerItem messageId="older"><Button variant="ghost" onClick={()=>void thread.older()}>加载更早消息</Button></MessageScrollerItem>}
      {conversationRows(messages).map(({id,message:m,events})=><MessageScrollerItem key={id} messageId={id}>
        {events?<ExecutionProgress events={events} transport={transport} accountLabel={m.run_id?runLabels.get(m.run_id):undefined}/>:
        <ChatMessage role={m.role}>
          {'source' in m&&m.role!=='user'&&<div className="text-xs text-muted-foreground">{m.source==='executor'?'执行器':'云端助手'}{'run_id' in m&&m.run_id&&runLabels.get(m.run_id)?` · ${runLabels.get(m.run_id)}`:''}</div>}
          {m.content}
          {'parts' in m&&<ChatAttachments transport={transport} parts={m.parts??[]} offline={offline} onAccountSaved={async()=>{await Promise.all([refresh(),thread.refresh()]);}}/>}
        </ChatMessage>}
      </MessageScrollerItem>)}
      {thread.page?.queued?.map(m=><MessageScrollerItem key={m.id} messageId={m.id}><ChatMessage role="user">{m.content}</ChatMessage></MessageScrollerItem>)}
      <SendingMessage message={thread.sending}/>
      <ThreadActivity offline={offline} error={thread.error} paused={run?.status==='unknown'}>{activity}</ThreadActivity>
      {(error||thread.page?.latestTurn?.error)&&<MessageScrollerItem messageId="error"><ErrorText error={error||thread.page?.latestTurn?.error||''}/></MessageScrollerItem>}
    </Thread>
    <Composer text={text} setText={setText} onSend={()=>void send()} busy={busy} disabled={offline||!thread.page} label="消息" placeholder={thread.page?.waiting?'在这里回复，执行器会继续…':'发送消息或补充要求…'}>
      {active&&run.accountName&&<span className="text-xs text-muted-foreground">{run.accountName}{run.dispatchTotal?` · ${(run.dispatchIndex??0)+1}/${run.dispatchTotal}`:''}</span>}
      {active&&<Button type="button" variant="outline" disabled={stopping||!!run.cancelRequested} onClick={()=>void stop()}>停止执行</Button>}
    </Composer>
  </div>;
}
