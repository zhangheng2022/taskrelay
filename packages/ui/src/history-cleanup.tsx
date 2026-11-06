import {createApi,rpcData} from './api';
/** 清理交互只发送范围与幂等请求 ID，目标集合和恢复进度归服务端所有。
 * 对话框失败时保留同一个请求 ID；重新打开网页仍读取后台未完成作业。
 */
import {useEffect,useRef,useState} from 'react';
import type {Transport} from '../../contracts/src/index';
import {Button} from './components/ui/button';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from './components/ui/dialog';
import {ErrorText} from './feedback';

export type CleanupSelection={scope:'all'|'task'|'clear';targetId?:string;title?:string;requestId:string};
type Job={id:string;status:string;total:number;completed:number;error:string|null};
export function HistoryCleanup({transport,selection,onClose,onAccepted}:{transport:Transport;selection:CleanupSelection|null;onClose:()=>void;onAccepted:(selection:CleanupSelection)=>Promise<void>}){
 const [preview,setPreview]=useState<{chats:number;active:number}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [previewAttempt,setPreviewAttempt]=useState(0);
 const revision=useRef(0);
 const [jobs,setJobs]=useState<Job[]>([]),[notice,setNotice]=useState('');
 const submitting=useRef(false),accepted=useRef<string|null>(null);
 async function sync(){
  const version=revision.current;
  const next=await rpcData(createApi(transport).api.user['history-cleanups'].$get());
  if(version===revision.current&&Array.isArray(next)){setJobs(next);return next;}
  return [];
 }
 useEffect(()=>{let alive=true;const version=revision.current;void rpcData(createApi(transport).api.user['history-cleanups'].$get()).then(next=>{if(alive&&version===revision.current&&Array.isArray(next))setJobs(next);}).catch(()=>{});return()=>{alive=false;};},[transport]);
 useEffect(()=>{
  if(!jobs.length)return;
  let alive=true;
  let reading=false;
  const timer=setInterval(()=>{if(reading)return;reading=true;const version=revision.current;void rpcData(createApi(transport).api.user['history-cleanups'].$get()).then(next=>{
   if(!alive||version!==revision.current||!Array.isArray(next))return;
   setJobs(next);if(!next.length)setNotice('聊天记录已清理完成');
  }).catch(()=>{if(alive)setNotice('暂时无法读取清理进度，恢复连接后会继续更新');}).finally(()=>{reading=false;});},3000);
  return()=>{alive=false;clearInterval(timer);};
 },[transport,jobs.length]);
 useEffect(()=>{
  setPreview(null);setError('');accepted.current=null;
  if(!selection)return;
  let alive=true;
  void rpcData(createApi(transport).api.user['history-cleanups-preview'].$get({query:{scope:selection.scope,...(selection.targetId?{targetId:selection.targetId}:{})}}))
   .then(value=>{if(alive)setPreview(value);}).catch(e=>{if(alive)setError(e.message);});
  return()=>{alive=false;};
 },[transport,selection,previewAttempt]);
 async function submit(){
  if(!selection||submitting.current)return;
  submitting.current=true;setBusy(true);setError('');
  try{
   if(accepted.current!==selection.requestId){
    const job=await rpcData(createApi(transport).api.user['history-cleanups'].$post({json:{scope:selection.scope,targetId:selection.targetId??null,requestId:selection.requestId}}));
    accepted.current=selection.requestId;
    revision.current++;
    setJobs(prev=>[...prev.filter(j=>j.id!==job.id),job]);
   }
   setNotice('清理已开始，关闭页面也会继续');
   await onAccepted(selection);onClose();void sync().catch(()=>{});
  }catch(e){setError((e as Error).message);}
  finally{submitting.current=false;setBusy(false);}
 }
 const label=selection?.scope==='clear'?'清空当前聊天':selection?.scope==='all'?'清理全部聊天':'删除聊天';
 return <>
  {(jobs.length>0||notice)&&<div className="border-b px-4 py-2 text-sm text-muted-foreground" role="status">
   {jobs.length?`正在清理聊天记录（${jobs.reduce((n,j)=>n+j.completed,0)}/${jobs.reduce((n,j)=>n+j.total,0)}），${jobs.some(j=>j.error)?'部分内容正在重试':'后台会继续处理'}`:notice}
  </div>}
  <Dialog open={!!selection} onOpenChange={open=>{if(!open&&!busy)onClose();}}>
   <DialogContent showCloseButton={!busy} onOpenAutoFocus={e=>{e.preventDefault();document.getElementById('cleanup-cancel')?.focus();}}>
    <DialogHeader><DialogTitle>{label}</DialogTitle><DialogDescription>
     {selection?.scope==='all'?`将清理你的全部聊天与任务入口${preview?`（当前 ${preview.chats} 项）`:''}。`:selection?.scope==='clear'?`将清空“${selection.title}”的聊天记录，保留暂停的任务入口，之后需要重新交办。`:`将删除“${selection?.title}”的聊天记录与任务入口。`}
     消息、图片与相关运行内容会永久清理，无法撤销。账号、模型配置和设备保留。
    </DialogDescription></DialogHeader>
    {preview?<p className="text-sm">{preview.active?`将停止 ${preview.active} 项正在排队、执行或等待协助的运行，并暂停相关调度。`:'相关任务调度会暂停。'}已经送到网站的操作无法撤销。</p>:!error&&<p role="status">正在确认清理范围…</p>}
    {error&&<ErrorText error={error}/>}
    {error&&!preview&&<Button variant="outline" onClick={()=>setPreviewAttempt(n=>n+1)}>重新获取范围</Button>}
    <DialogFooter><Button id="cleanup-cancel" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button variant="destructive" disabled={busy||!preview} onClick={()=>void submit()}>{busy?'正在提交…':error?'重试清理':`确认${label}`}</Button></DialogFooter>
   </DialogContent>
  </Dialog>
 </>;
}
