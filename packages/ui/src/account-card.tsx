import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Transport } from '../../contracts/src/index';
import type { AccountCardDetail } from '../../contracts/src/accounts';
import { AccountFields, accountFieldsBody, emptyAccountFields, type AccountFieldsValue } from './account-fields';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './components/ui/card';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { ErrorText, LoadFeedback } from './feedback';

// 普通聊天 parts 只有卡片引用；本人接口返回的秘密仅在当前组件存活期间使用。
// 通知刷新只更新卡片状态，不覆盖用户正在修改的内容；确认后立即清除本地表单。
function fields(detail: AccountCardDetail): AccountFieldsValue {
  return { name: detail.name, origin: detail.origin, businessDomains: detail.businessDomains.join('\n'), loginOrigins: detail.loginOrigins.join('\n'), username: detail.username ?? '', password: detail.password ?? '' };
}
function credentialIdentity(value: AccountFieldsValue) {
  const {name: _name, ...identity} = accountFieldsBody(value);
  return JSON.stringify(identity);
}
export function AccountCard({ id, transport, offline = false, onSaved }: { id: string; transport: Transport; offline?: boolean; onSaved?: () => Promise<void> }) {
  const [detail, setDetail] = useState<AccountCardDetail | null>(null), [value, setValue] = useState<AccountFieldsValue>({ ...emptyAccountFields });
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [retry, setRetry] = useState(0), [resumed, setResumed] = useState<boolean | null>(null);
  const generation = useRef(0), flight = useRef(false), baseline = useRef(''), localStatus = useRef<AccountCardDetail['status'] | null>(null);
  const online = useRef(!offline), wasOffline = useRef(offline); online.current = !offline;
  function fail(reason: string) {
    setError(reason);
    if (['ACCOUNT_CARD_NOT_FOUND', 'ACCOUNT_CARD_STALE', 'ACCOUNT_VERSION_CONFLICT'].includes(reason)) {
      localStatus.current = 'expired'; baseline.current = ''; setValue({ ...emptyAccountFields });
      setDetail(previous => previous ? { ...previous, status: 'expired', username: undefined, password: undefined } : null);
    }
  }
  useEffect(() => { if (wasOffline.current && !offline) setRetry(n => n + 1); wasOffline.current = offline; }, [offline]);
  useEffect(() => {
    const current = ++generation.current; let reading = false, initialized = false;
    setDetail(null); setValue({ ...emptyAccountFields }); setLoading(true); setError(''); setResumed(null); localStatus.current = null;
    const read = async () => {
      if (reading || flight.current || !online.current) return;
      reading = true;
      try {
        const next = await transport.request<AccountCardDetail>('GET', `/api/user/account-cards/${id}`);
        if (generation.current !== current || flight.current) return;
        // 迟到的 pending 读取不能覆盖本地已经确认的终态。
        if (localStatus.current && localStatus.current !== 'pending' && next.status === 'pending') return;
        localStatus.current = next.status; setDetail(next); setError('');
        if (next.status !== 'pending') { setValue({ ...emptyAccountFields }); baseline.current = ''; }
        else if (!initialized) { const initial = fields(next); setValue(initial); baseline.current = credentialIdentity(initial); }
        initialized = true;
      } catch (e) { if (generation.current === current) fail((e as Error).message); }
      finally { reading = false; if (generation.current === current) setLoading(false); }
    };
    if (!online.current) setLoading(false); else void read();
    const unsubscribe = transport.subscribe?.(() => void read());
    const timer = setInterval(() => { if (localStatus.current === 'pending') void read(); }, 15000);
    return () => { generation.current++; clearInterval(timer); unsubscribe?.(); };
  }, [id, transport, retry]);
  async function submit(dismiss: boolean) {
    if (flight.current || offline || !detail || detail.status !== 'pending') return;
    const current = generation.current;
    flight.current = true; setBusy(true); setError('');
    try {
      const response = await transport.request<{ accountId?: string; resumed?: boolean }>('POST', `/api/user/account-cards/${id}/${dismiss ? 'dismiss' : 'confirm'}`, dismiss ? {} : accountFieldsBody(value));
      if (generation.current !== current) return;
      const status = dismiss ? 'dismissed' : 'saved'; localStatus.current = status;
      setDetail({ ...detail, status, username: undefined, password: undefined });
      setValue({ ...emptyAccountFields }); baseline.current = ''; setResumed(response.resumed ?? false);
      if (!dismiss) await onSaved?.();
    } catch (e) { if (generation.current === current) fail((e as Error).message); }
    finally { flight.current = false; setBusy(false); if (generation.current !== current) setRetry(n => n + 1); }
  }
  const pending = detail?.status === 'pending';
  const changed = pending && baseline.current !== credentialIdentity(value);
  const verified = detail?.verified && !changed;
  const title = detail?.kind === 'update' ? '修改站点账号' : '保存站点账号';
  return <Card className="my-3 w-full min-w-0 whitespace-normal" aria-label={title}>
    <CardHeader><CardTitle>{title}</CardTitle><CardDescription>{detail?.kind === 'update' ? '更新登录信息后，可以继续当前仍在等待的任务。' : '确认保存后，后续任务可以直接关联这个账号。'}</CardDescription></CardHeader>
    {!detail ? <CardContent><LoadFeedback loading={loading} error={offline ? '连接已中断，恢复后可查看账号卡片。' : error} label="正在加载账号卡片…" onRetry={() => setRetry(n => n + 1)}/></CardContent> : pending ?
      <form className="flex flex-col gap-5" onSubmit={event => { event.preventDefault(); void submit(false); }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}>
        <CardContent className="flex flex-col gap-5">
          <Badge variant="secondary">{verified ? '本次凭据已验证' : '凭据待验证'}</Badge>
          {changed && detail.verified && <p className="text-sm text-muted-foreground">内容已修改，保存后需要重新验证，原登录状态不会直接沿用。</p>}
          <AccountFields value={value} onChange={setValue} disabled={busy || offline}/>
          {error && <ErrorText error={error}/>}
        </CardContent>
        <CardFooter className="flex-wrap justify-end gap-2"><Button type="button" variant="ghost" disabled={busy || offline} onClick={() => void submit(true)}>暂不保存</Button><Button type="submit" disabled={busy || offline}>{busy && <Loader2 data-icon="inline-start" className="animate-spin"/>}{detail.kind === 'update' && detail.canResume ? '保存并继续' : '保存账号'}</Button></CardFooter>
      </form> : <><CardContent><p role="status">{detail.status === 'saved' ? resumed ? '账号已保存，正在继续当前任务。' : '账号已保存，后续任务可使用。' : detail.status === 'dismissed' ? '本次未保存账号。' : '这张卡片已失效，请在聊天中重新提供需要保存的信息。'}</p>{error && <ErrorText error={error}/>}</CardContent><CardFooter><span className="text-sm text-muted-foreground">{detail.name}</span></CardFooter></>}
  </Card>;
}
