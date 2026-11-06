import {createApi,rpcData} from './api';
import {useEffect,useState} from 'react';
import type {ChatPart} from '../../contracts/src/execution';
import type {Transport} from '../../contracts/src/index';
import {Dialog,DialogContent,DialogTitle,DialogTrigger} from './components/ui/dialog';
import {Button} from './components/ui/button';
import {Attachment,AttachmentMedia} from './components/ui/attachment';
import {AccountCard} from './account-card';

function ChatImage({transport,id,alt}:{transport:Transport;id:string;alt:string}){
  const [image,setImage]=useState(''),[error,setError]=useState('');
  useEffect(()=>{let alive=true;setImage('');setError('');void rpcData(createApi(transport).api.user.artifacts[':id'].$get({param:{id},query:{format:'data'}})).then(r=>{if(!r||typeof r!=='object'||!('dataUrl' in r)||typeof r.dataUrl!=='string')throw Error('ARTIFACT_EXPIRED');if(alive)setImage(r.dataUrl);}).catch(()=>{if(alive)setError('这张历史图片已不可用。');});return()=>{alive=false;};},[transport,id]);
  return <Attachment orientation="vertical" state={error?'error':image?'done':'processing'} className="max-w-full">
    {error?<p>{error}</p>:!image?<p>正在加载图片…</p>:<Dialog>
      <DialogTrigger asChild><Button variant="ghost" className="h-auto max-w-full p-0" aria-label="查看完整截图"><AttachmentMedia variant="image"><img src={image} alt={alt} loading="lazy" className="max-h-72 max-w-full object-contain"/></AttachmentMedia></Button></DialogTrigger>
      <DialogContent className="max-w-[95vw]"><DialogTitle>{alt}</DialogTitle><img src={image} alt={alt} className="max-h-[80vh] w-full object-contain"/></DialogContent>
    </Dialog>}
  </Attachment>;
}
export function ChatAttachments({parts,transport,offline,onAccountSaved}:{parts:ChatPart[];transport:Transport;offline?:boolean;onAccountSaved?:()=>Promise<void>}){
  return <div className="flex flex-col gap-2">{parts.map((p,i)=>p.type==='image'?<ChatImage key={p.artifactId} transport={transport} id={p.artifactId} alt={p.alt}/>:p.type==='account-card'?<AccountCard key={p.cardId} id={p.cardId} transport={transport} offline={offline} onSaved={onAccountSaved}/>:<details key={i} className="text-xs text-muted-foreground"><summary>操作反馈</summary><p className="whitespace-pre-wrap break-words">{p.result}</p></details>)}</div>;
}
