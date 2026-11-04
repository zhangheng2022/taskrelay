import { useEffect,useState,useCallback } from 'react';
import type { DesktopStatus,Transport } from '../../contracts/src/index';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Switch } from './components/ui/switch';
import { Card,CardHeader,CardTitle,CardDescription,CardContent,CardFooter } from './components/ui/card';
import { Field,FieldLabel,FieldDescription,FieldGroup,FieldContent } from './components/ui/field';
import { ErrorText } from './feedback';
import { BrandMark } from './brand-mark';
export function ExecutorApp({executor}:{executor:NonNullable<Transport['desktop']>}) {
 const [status,setStatus]=useState<DesktopStatus|null>(null),[url,setUrl]=useState(''),[pair,setPair]=useState<{code:string}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[note,setNote]=useState('');
 const refresh=useCallback(async()=>{const value=await executor.status();setStatus(value);setUrl(v=>v||value.cloudUrl);},[executor]);
 useEffect(()=>{let live=true;const load=()=>{if(live)void refresh().catch(e=>setError(e.message));};load();const off=executor.subscribe(load);const timer=setInterval(load,5000);return()=>{live=false;off();clearInterval(timer);};},[executor,refresh]);
 useEffect(()=>{if(!pair)return;let live=true;const timer=setInterval(()=>{void executor.pairPoll().then(done=>{if(live&&done){setPair(null);void refresh();}}).catch(e=>{if(live){setError(e.message);setPair(null);}});},3000);return()=>{live=false;clearInterval(timer);};},[pair,executor,refresh]);
 useEffect(()=>{const mq=window.matchMedia('(prefers-color-scheme: dark)');const apply=()=>document.documentElement.classList.toggle('dark',mq.matches);apply();mq.addEventListener('change',apply);return()=>mq.removeEventListener('change',apply);},[]);
 async function act(fn:()=>Promise<unknown>){setBusy(true);setError('');try{await fn();await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <main className="flex h-dvh flex-col gap-3 overflow-y-auto p-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
  <Card className="shrink-0 gap-4 py-5"><CardHeader><CardTitle className="flex items-center gap-3"><BrandMark />TaskRelay 执行器</CardTitle><CardDescription>接收云端任务，执行并回传结果。</CardDescription></CardHeader>
   <CardContent className="flex flex-col gap-4">
    <p role="status">{!status?'正在读取状态…':!status.paired?'尚未连接':status.activeRunId?'正在执行':!status.online?'连接中或离线':status.paused?'已暂停领取':'在线，等待任务'}</p>
    {status?.activeRunId&&<p className="break-all text-sm text-muted-foreground">运行编号：{status.activeRunId}</p>}
    {status?.error&&<ErrorText error={status.error}/>}
    <FieldGroup className="gap-4"><Field><FieldLabel htmlFor="executor-url">工作空间地址</FieldLabel><Input id="executor-url" type="url" value={url} onChange={e=>setUrl(e.target.value)} disabled={busy||!!status?.activeRunId}/><FieldDescription>由管理员在网站授权设备进入公共池。</FieldDescription></Field>
    <Button disabled={busy||!!status?.activeRunId||!!pair} onClick={()=>void act(async()=>setPair(await executor.configure(url)))}>在浏览器中授权设备</Button>
    {pair&&<p role="status">请在浏览器核对校验码：<strong>{pair.code}</strong></p>}
    <Field orientation="horizontal"><FieldContent><FieldLabel htmlFor="executor-paused">暂停领取新任务</FieldLabel><FieldDescription>已开始的任务继续执行。</FieldDescription></FieldContent><Switch id="executor-paused" checked={status?.paused??false} disabled={busy} onCheckedChange={v=>void act(()=>executor.pause(v))}/></Field>
    <Field orientation="horizontal"><FieldLabel htmlFor="executor-startup">登录 Windows 时启动</FieldLabel><Switch id="executor-startup" checked={status?.autoStart??false} disabled={busy} onCheckedChange={v=>void act(()=>executor.autoStart(v))}/></Field>
    </FieldGroup>
   </CardContent><CardFooter className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy||!status?.activeRunId} onClick={()=>void act(()=>executor.stop())}>停止当前执行</Button><Button variant="ghost" disabled={busy} onClick={()=>void act(async()=>setNote(await executor.diagnostics()))}>导出诊断</Button></CardFooter>
  </Card>
  {error&&<ErrorText error={error}/>}{note&&<p role="status" className="break-all text-sm">{note}</p>}
  <p className="text-sm text-muted-foreground">任务配置和人工协助请在网站完成。关闭窗口后继续在托盘运行；通过托盘菜单退出。</p>
  {status&&<p className="text-xs text-muted-foreground">版本 {status.version}</p>}
 </main>;
}
