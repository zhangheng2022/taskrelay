import {useState,useRef} from 'react';
import type {TaskDefinition,TaskRun,Transport} from '../../contracts/src/index';
import {useThread} from './use-thread';
import {Thread,Composer,ChatMessage,PendingMessage,SendingMessage} from './chat-parts';
import {MessageScrollerItem} from './components/ui/message-scroller';
import {Button} from './components/ui/button';
import {ErrorText,LoadFeedback} from './feedback';
import {ChatAttachments} from './chat-attachments';
import {conversationRows,ExecutionProgress} from './execution-progress';

// 将用户消息、云端协助和执行器反馈合并到同一聊天；停止直接调用运行控制接口。
// run 由工作空间选择当前活动运行，历史记录入口不会把停止按钮绑定到旧运行。
export function Conversation({transport,task,run,offline,refresh}: {
  transport:Transport;task:TaskDefinition;run:TaskRun|null;
  refresh:()=>Promise<void>;offline:boolean;
}){
  const thread=useThread(transport,'chat',task.modelId,task.id);
  const [text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [confirmClear,setConfirmClear]=useState(false),[stopping,setStopping]=useState(false);
  const sending=useRef(false);
  const active=run&&['queued','running','waiting_user','verifying'].includes(run.status);
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
    <Thread>
      {(thread.loading||thread.error)&&<MessageScrollerItem messageId="loading"><LoadFeedback loading={thread.loading} error={thread.error} label="正在加载聊天…" onRetry={thread.retry}/></MessageScrollerItem>}
      {(thread.page?.nextCursor||thread.page?.nextReplyCursor)&&<MessageScrollerItem messageId="older"><Button variant="ghost" onClick={()=>void thread.older()}>加载更早消息</Button></MessageScrollerItem>}
      {conversationRows(messages).map(({id,message:m,events})=><MessageScrollerItem key={id} messageId={id} scrollAnchor={m.role==='user'}>
        {events?<ExecutionProgress events={events} transport={transport}/>:
        <ChatMessage role={m.role}>
          {'source' in m&&m.role!=='user'&&<div className="text-xs text-muted-foreground">{m.source==='executor'?'执行器':'云端助手'}</div>}
          {m.content}
          {'parts' in m&&<ChatAttachments transport={transport} parts={m.parts??[]}/>}
        </ChatMessage>}
      </MessageScrollerItem>)}
      {thread.page?.queued?.map(m=><MessageScrollerItem key={m.id} messageId={m.id}><ChatMessage role="user">{m.content}</ChatMessage></MessageScrollerItem>)}
      <SendingMessage message={thread.sending}/>
      {!thread.sending&&thread.page?.activeTurn&&<MessageScrollerItem messageId="thinking"><PendingMessage>云端助手正在处理…</PendingMessage></MessageScrollerItem>}
      {!thread.sending&&active&&<MessageScrollerItem messageId="activity"><PendingMessage>{thread.page?.waiting?'等待你的回复':run.status==='queued'?'等待执行设备':run.cancelRequested?'正在停止…':'执行器正在处理…'}</PendingMessage></MessageScrollerItem>}
      {(error||thread.page?.latestTurn?.error)&&<MessageScrollerItem messageId="error"><ErrorText error={error||thread.page?.latestTurn?.error||''}/></MessageScrollerItem>}
    </Thread>
    <Composer text={text} setText={setText} onSend={()=>void send()} busy={busy} disabled={offline||!thread.page} label="消息" placeholder={thread.page?.waiting?'在这里回复，执行器会继续…':'发送消息或补充要求…'}>
      {active&&<Button type="button" variant="outline" disabled={stopping||!!run.cancelRequested} onClick={()=>void stop()}>停止执行</Button>}
      <Button type="button" variant="ghost" onClick={()=>setConfirmClear(true)}>清空聊天</Button>
      {confirmClear&&<><Button type="button" variant="destructive" onClick={()=>void thread.clear().then(()=>setConfirmClear(false)).catch(e=>setError(e.message))}>确认清空</Button><Button type="button" variant="ghost" onClick={()=>setConfirmClear(false)}>取消</Button></>}
    </Composer>
  </div>;
}
