import {useState} from 'react';
import type {ChatPart} from '../../contracts/src/execution';
import type {Transport} from '../../contracts/src/index';
import {Dialog,DialogContent,DialogTitle,DialogTrigger} from './components/ui/dialog';
import {Button} from './components/ui/button';
import {Attachment,AttachmentMedia} from './components/ui/attachment';
import {AccountCard} from './account-card';

// 地址由宿主提供，浏览器负责鉴权请求、懒加载和图片解码；组件只维护显示状态。
// 图片地址变化时由父级 key 重置，避免旧图片的加载结果污染新附件。
function ChatImage({src,alt}:{src?:string;alt:string}){
  const [state,setState]=useState<'processing'|'done'|'error'>(src?'processing':'error');
  const [previewState,setPreviewState]=useState<'processing'|'done'|'error'>('processing');
  return <Attachment orientation="vertical" state={state} aria-busy={state==='processing'} className="max-w-full">
    {state==='error'?<p>图片加载失败或已不可用。</p>:<>
      {state==='processing'&&<p role="status">正在加载图片…</p>}
      <Dialog onOpenChange={()=>setPreviewState('processing')}>
        <DialogTrigger asChild><Button variant="ghost" disabled={state!=='done'} className="h-auto max-w-full p-0" aria-label="查看完整截图"><AttachmentMedia variant="image"><img src={src} alt={alt} loading="lazy" decoding="async" onLoad={()=>setState('done')} onError={()=>setState('error')} className="max-h-72 max-w-full object-contain"/></AttachmentMedia></Button></DialogTrigger>
        <DialogContent className="max-w-[95vw]"><DialogTitle>{alt}</DialogTitle>
          {previewState==='error'?<p>图片加载失败或已不可用。</p>:<>
            {previewState==='processing'&&<p role="status">正在加载图片…</p>}
            <img src={src} alt={alt} decoding="async" onLoad={()=>setPreviewState('done')} onError={()=>setPreviewState('error')} className="max-h-[80vh] w-full object-contain"/>
          </>}
        </DialogContent>
      </Dialog>
    </>}
  </Attachment>;
}
export function ChatAttachments({parts,transport,offline,onAccountSaved}:{parts:ChatPart[];transport:Transport;offline?:boolean;onAccountSaved?:()=>Promise<void>}){
  return <div className="flex flex-col gap-2">{parts.map((p,i)=>{
    if(p.type==='image'){
      const src=transport.artifactUrl?.(p.artifactId);
      return <ChatImage key={`${p.artifactId}:${src??''}`} src={src} alt={p.alt}/>;
    }
    return p.type==='account-card'?<AccountCard key={p.cardId} id={p.cardId} transport={transport} offline={offline} onSaved={onAccountSaved}/>:<details key={i} className="text-xs text-muted-foreground"><summary>操作反馈</summary><p className="whitespace-pre-wrap break-words">{p.result}</p></details>;
  })}</div>;
}
