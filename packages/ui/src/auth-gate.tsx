import { useEffect,useRef,useState,type ReactNode } from 'react';
import type { Transport } from '../../contracts/src/index';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Card,CardHeader,CardTitle,CardDescription,CardContent,CardFooter } from './components/ui/card';
import { Field,FieldLabel,FieldGroup } from './components/ui/field';
import { ErrorText } from './feedback';
import { BrandMark } from './brand-mark';
type Turnstile={render:(el:HTMLElement,options:Record<string,unknown>)=>string;remove:(id:string)=>void};
declare global {interface Window{turnstile?:Turnstile}}
export function BotCheck({siteKey,onToken}:{siteKey:string;onToken:(token:string)=>void}) {
 const ref=useRef<HTMLDivElement>(null),callback=useRef(onToken);callback.current=onToken;
 useEffect(()=>{
  if(!siteKey)return;let widget:string|undefined,disposed=false;
  const mount=()=>{if(disposed||widget||!ref.current||!window.turnstile)return;widget=window.turnstile.render(ref.current,{sitekey:siteKey,action:'auth',callback:(token:string)=>callback.current(token),'expired-callback':()=>callback.current(''),'error-callback':()=>callback.current('')});};
  let script=document.querySelector<HTMLScriptElement>('script[data-taskrelay-turnstile]');
  if(!script){script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;script.dataset.taskrelayTurnstile='true';document.head.appendChild(script);}
  script.addEventListener('load',mount);mount();return()=>{disposed=true;script.removeEventListener('load',mount);if(widget)window.turnstile?.remove(widget);callback.current('');};
 },[siteKey]);
 return <div ref={ref} aria-label="人机验证"/>;
}
export async function authRequest(path:string,body:unknown,token?:string) {
 const r=await fetch('/api/auth/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{'x-turnstile-token':token}:{})},body:JSON.stringify(body)});
 const data=await r.json() as {error?:string;code?:string};
 if(!r.ok)throw new Error(typeof data.error==='string'?data.error:data.code??'AUTH_FAILED');
 return data;
}
export function AuthGate({transport,children}:{transport:Transport;children:ReactNode}) {
 const resetToken=new URLSearchParams(location.search).get('token');
 const [ready,setReady]=useState(false),[loading,setLoading]=useState(true),[mode,setMode]=useState<'login'|'register'|'forgot'|'reset'|'verify'>(resetToken?'reset':'login'),[config,setConfig]=useState({registrationOpen:false,siteKey:''}),[token,setToken]=useState(''),[epoch,setEpoch]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState(''),[note,setNote]=useState('');
 useEffect(()=>{let live=true;void Promise.allSettled([transport.request('GET','/api/user/me'),fetch('/api/auth/config').then(r=>r.json() as Promise<{registrationOpen:boolean;siteKey:string}>)]).then(([me,cfg])=>{if(!live)return;if(me.status==='fulfilled')setReady(true);else if(!['AUTH_REQUIRED','ACCESS_REQUIRED'].includes(me.reason.message))setError(me.reason.message);if(cfg.status==='fulfilled')setConfig(cfg.value);setLoading(false);});return()=>{live=false;};},[transport]);
 if(loading)return <p className="p-8" role="status">正在加载工作空间…</p>;
 if(ready&&mode!=='reset')return <>{children}</>;
 const needsBot=['register','forgot','verify'].includes(mode);
 const title={login:'登录 TaskRelay',register:'创建账号',forgot:'找回密码',reset:'设置新密码',verify:'重新发送验证邮件'}[mode];
 function change(next:typeof mode){setMode(next);setError('');setNote('');setToken('');setEpoch(x=>x+1);}
 return <main className="flex min-h-dvh items-center justify-center p-4"><Card className="w-full max-w-md">
 <CardHeader><div className="mb-3 flex items-center gap-3"><BrandMark className="w-10"/><span className="text-lg font-semibold tracking-tight">TaskRelay</span></div><CardTitle>{title}</CardTitle><CardDescription>在网站管理任务，由公共执行器完成操作。</CardDescription></CardHeader>
 <CardContent><form id="auth-form" onSubmit={async e=>{e.preventDefault();const f=new FormData(e.currentTarget);setBusy(true);setError('');setNote('');try{
  const email=String(f.get('email')??'');const password=String(f.get('password')??'');
  if(mode==='login'){await authRequest('sign-in/email',{email,password});setReady(true);}
  else if(mode==='register'){await authRequest('sign-up/email',{email,password,name:String(f.get('name')),callbackURL:location.origin+'/'},token);setNote('请检查邮箱，点击验证链接后登录。');}
  else if(mode==='forgot'){await authRequest('request-password-reset',{email,redirectTo:location.origin+'/'},token);setNote('如果邮箱已注册，将收到重置密码邮件。');}
  else if(mode==='verify'){await authRequest('send-verification-email',{email,callbackURL:location.origin+'/'},token);setNote('请检查验证邮件。');}
  else {await authRequest('reset-password',{newPassword:password,token:resetToken});history.replaceState(null,'',location.pathname);setMode('login');setReady(false);setNote('密码已更新，请重新登录。');}
 }catch(e){setError((e as Error).message);}finally{setBusy(false);setToken('');setEpoch(x=>x+1);}}}>
 <FieldGroup>{mode==='register'&&<Field><FieldLabel htmlFor="auth-name">昵称</FieldLabel><Input id="auth-name" name="name" required maxLength={80} autoComplete="nickname"/></Field>}
 {mode!=='reset'&&<Field><FieldLabel htmlFor="auth-email">邮箱</FieldLabel><Input id="auth-email" name="email" type="email" autoComplete="email" required/></Field>}
 {['login','register','reset'].includes(mode)&&<Field><FieldLabel htmlFor="auth-password">{mode==='reset'?'新密码':'密码'}</FieldLabel><Input id="auth-password" name="password" type="password" minLength={mode==='login'?1:12} maxLength={128} autoComplete={mode==='login'?'current-password':'new-password'} required/></Field>}
 {needsBot&&<BotCheck key={epoch} siteKey={config.siteKey} onToken={setToken}/>}
 {needsBot&&!config.siteKey&&<p role="status">注册与邮件服务尚未开放，请联系管理员。</p>}
 {error&&<ErrorText error={error}/ >}{note&&<p role="status">{note}</p>}
 <Button disabled={busy||(needsBot&&!token)}>{busy?'正在处理…':title}</Button>
 </FieldGroup></form></CardContent>
 <CardFooter className="flex flex-wrap gap-2">{mode!=='login'&&<Button variant="ghost" onClick={()=>change('login')}>返回登录</Button>}{mode==='login'&&<><Button variant="ghost" onClick={()=>change('register')}>{config.registrationOpen?'注册账号':'管理员首次注册'}</Button><Button variant="ghost" onClick={()=>change('forgot')}>忘记密码</Button><Button variant="ghost" onClick={()=>change('verify')}>验证邮箱</Button></>}</CardFooter>
 </Card></main>;
}
export function AccountSecurity() {
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 return <form onSubmit={async e=>{e.preventDefault();const f=new FormData(e.currentTarget);setBusy(true);setError('');try{await authRequest('change-password',{currentPassword:f.get('current'),newPassword:f.get('next'),revokeOtherSessions:true});location.reload();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}><FieldGroup>
 <Field><FieldLabel htmlFor="current-password">当前密码</FieldLabel><Input id="current-password" name="current" type="password" autoComplete="current-password" required/></Field>
 <Field><FieldLabel htmlFor="next-password">新密码（至少 12 位）</FieldLabel><Input id="next-password" name="next" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/></Field>
 {error&&<ErrorText error={error}/>}<Button disabled={busy}>修改密码并重新登录</Button><Button type="button" variant="outline" onClick={()=>void authRequest('sign-out',{}).then(()=>location.reload()).catch(e=>setError(e.message))}>退出登录</Button>
 </FieldGroup></form>;
}
