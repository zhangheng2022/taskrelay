import { useEffect,useState } from 'react';
import type { Transport } from '../../contracts/src/index';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { NativeSelect } from './components/ui/native-select';
import { Field,FieldLabel,FieldGroup } from './components/ui/field';
import { Card,CardHeader,CardTitle,CardDescription,CardContent } from './components/ui/card';
import { ErrorText,Status,formatDate } from './feedback';
type User={id:string;email:string;role:string;disabled:number;daily_runs:number;scheduled_tasks:number;queued_runs:number;daily_chat:number;daily_models:number};
type Operations={users:User[];devices:{id:string;name:string;revoked:number;protocol_version:number;last_seen:string|null}[];runs:{id:string;user_id:string;device_id:string|null;status:string;error_code:string|null;created_at:string}[];accounts:{id:string;user_id:string;assigned_device_id:string|null;login_reset:number}[];settings:{claimsEnabled:string}};
const fields=[['daily_runs','每日启动'],['scheduled_tasks','周期任务'],['queued_runs','排队上限'],['daily_chat','每日对话'],['daily_models','每日模型调用']] as const;
export function AdminPanel({transport}:{transport:Transport}) {
 const [data,setData]=useState<Operations|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[note,setNote]=useState('');
 async function load(){setData(await transport.request('GET','/api/admin/operations'));}
 useEffect(()=>{let live=true;void transport.request<Operations>('GET','/api/admin/operations').then(d=>{if(live)setData(d);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[transport]);
 async function action(fn:()=>Promise<unknown>){setBusy(true);setError('');setNote('');try{await fn();await load();setNote('已保存');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <div className="flex flex-col gap-5">{error&&<ErrorText error={error}/ >}{note&&<p role="status">{note}</p>}
 <Button variant="outline" disabled={busy} onClick={()=>void action(load)}>刷新运行状态</Button>
 {data&&<><Card><CardHeader><CardTitle>公共执行池</CardTitle><CardDescription>暂停领取不会停止已经开始的任务。</CardDescription></CardHeader><CardContent>
 <form key={JSON.stringify(data.settings)} onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void action(()=>transport.request('PUT','/api/admin/pool',{claimsEnabled:f.get('claims')==='1'}));}}><FieldGroup>
 <Field><FieldLabel htmlFor="pool-claims">领取任务</FieldLabel><NativeSelect id="pool-claims" name="claims" defaultValue={data.settings.claimsEnabled}><option value="1">允许</option><option value="0">暂停</option></NativeSelect></Field>
 <Button disabled={busy}>保存公共池设置</Button>
 </FieldGroup></form></CardContent></Card>
 {data.users.map(u=><Card key={u.id}><CardHeader><CardTitle>{u.email||'原管理员'}</CardTitle><CardDescription>{u.role==='admin'?'管理员':'用户'} · {u.disabled?'已停用':'正常'}</CardDescription></CardHeader><CardContent>
 <form key={JSON.stringify(u)} onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void action(()=>transport.request('PUT','/api/admin/users/'+u.id,{disabled:f.get('disabled')==='1',...Object.fromEntries(fields.map(([k])=>[k,Number(f.get(k))]))}));}}><FieldGroup>
 {fields.map(([k,label])=><Field key={k}><FieldLabel htmlFor={u.id+k}>{label}</FieldLabel><Input id={u.id+k} name={k} type="number" min={0} max={100000} required defaultValue={u[k]}/></Field>)}
 <Field><FieldLabel htmlFor={u.id+'status'}>用户状态</FieldLabel><NativeSelect id={u.id+'status'} name="disabled" defaultValue={String(u.disabled)}><option value="0">正常</option><option value="1">停用并停止任务</option></NativeSelect></Field>
 <Button disabled={busy}>保存用户设置</Button></FieldGroup></form></CardContent></Card>)}
 <Card><CardHeader><CardTitle>账号执行设备迁移</CardTitle><CardDescription>迁移后需要重新登录网站。先确认旧设备已经停止执行；待核查的账号不能迁移。</CardDescription></CardHeader><CardContent className="flex flex-col gap-5">
 {data.accounts.map(a=><form key={a.id+String(a.assigned_device_id)} onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void action(()=>transport.request('POST',`/api/admin/accounts/${a.id}/migrate`,{deviceId:f.get('device'),oldExecutionStopped:f.get('stopped')==='on'}));}}><FieldGroup>
 <p className="break-all text-sm">账号 {a.id} · 用户 {data.users.find(u=>u.id===a.user_id)?.email||a.user_id} · 当前设备 {data.devices.find(d=>d.id===a.assigned_device_id)?.name||'未分配'}</p>
 <Field><FieldLabel htmlFor={a.id+'device'}>目标设备</FieldLabel><NativeSelect id={a.id+'device'} name="device" required defaultValue=""><option value="" disabled>选择设备</option>{data.devices.filter(d=>!d.revoked&&d.protocol_version===14).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</NativeSelect></Field>
 <Field orientation="horizontal"><Input className="size-4" id={a.id+'stopped'} name="stopped" type="checkbox" required/><FieldLabel htmlFor={a.id+'stopped'}>已确认旧设备停止该账号的执行</FieldLabel></Field><Button variant="outline" disabled={busy}>迁移并重新登录</Button>
 </FieldGroup></form>)}{!data.accounts.length&&<p>暂无账号。</p>}</CardContent></Card>
 <Card><CardHeader><CardTitle>运行状态</CardTitle><CardDescription>仅展示运维信息，不展示用户任务内容。</CardDescription></CardHeader><CardContent className="flex flex-col gap-3">{data.runs.map(r=><div className="flex flex-wrap items-center gap-2 border-b pb-3" key={r.id}><Status value={r.status}/><span className="break-all text-xs">{r.id} · {formatDate(r.created_at)} · {r.error_code||'—'}</span></div>)}</CardContent></Card>
 </> }</div>;
}
