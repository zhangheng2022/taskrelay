import { useCallback, useEffect, useRef, useState } from "react";
import type { Transport } from "../../contracts/src/index";
// 管理新任务和既有任务共用的聊天生命周期：查找/创建、通知刷新、发送、历史分页与清空。
// generation 隔离会话切换，revision 隔离读写交错；attempt 保存待确认发送的原文和幂等标识。
// sending 仅作内存中的即时回显，不冒充服务端记录；被读写占用期间的通知合并后补读。
import type {ThreadPage} from '../../contracts/src/conversation';
export type {ThreadPage} from '../../contracts/src/conversation';
import {createApi,rpcData} from './api';
function mergeReplies(a:ThreadPage['replies'],b:ThreadPage['replies']){
  return [...(a??[]).filter(m=>!b?.some(n=>n.id===m.id)),...(b??[])].sort((a,b)=>a.cursor-b.cursor);
}
function mergeLatest(previous: ThreadPage, next: ThreadPage): ThreadPage {
  // 最新页只更新尾部内容；历史游标属于已加载的历史范围，null 也表示已读到底。
  // 若两次读取之间新增超过一页，仍从新窗口回补缺口；旧协助 cursor 非连续编号，
  // 没有重叠时保守回补，避免把此前的 null 当作新消息也已全部加载。
  const messageGap = next.nextCursor !== null &&
    (next.messages[0]?.seq ?? 0) > (previous.messages.at(-1)?.seq ?? 0) + 1;
  const replyGap = next.nextReplyCursor !== undefined && next.nextReplyCursor !== null &&
    (next.replies?.[0]?.cursor ?? 0) > (previous.replies?.at(-1)?.cursor ?? 0);
  return {
    ...next,
    nextCursor: previous.messages.length && !messageGap ? previous.nextCursor : next.nextCursor,
    nextReplyCursor: previous.replies?.length && !replyGap ? previous.nextReplyCursor : next.nextReplyCursor,
    replies: mergeReplies(previous.replies, next.replies),
    messages: [
      ...previous.messages.filter((m) => !next.messages.some((n) => n.id === m.id)),
      ...next.messages,
    ].sort((a, b) => a.seq - b.seq),
  };
}
export function useThread(
  transport: Transport,
  kind: "compose" | "chat",
  modelId: string,
  taskId?: string,
) {
  const [page, setPage] = useState<ThreadPage | null>(null),
    [sending, setSending] = useState<{id:string;content:string}|null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(!!modelId),
    [retryIndex, setRetryIndex] = useState(0);
  const scope = `${kind}:${modelId}:${taskId ?? ""}`,
    generation = useRef(0),
    current = useRef<ThreadPage | null>(null),
    attempt = useRef<{
      content: string;
      requestId: string;
    } | null>(null);
  const revision = useRef(0),
    reading = useRef(0),
    refreshing = useRef<number|null>(null),
    refreshQueued = useRef(false),
    loadingOlder = useRef<symbol | null>(null),
    writing = useRef(false);
  const accept = useCallback((p: ThreadPage) => {
    current.current = p;
    setPage(p);
  }, []);
  useEffect(() => {
    const g = ++generation.current;
    revision.current++;
    writing.current = false;
    refreshing.current = null;
    refreshQueued.current = false;
    setSending(null);
    loadingOlder.current = null;
    current.current = null;
    setPage(null);
    attempt.current = null;
    setError('');
    setLoading(!!modelId);
    if (!modelId) return;
    (async () => {
      const list = await rpcData(createApi(transport).api.user.threads.$get());
      if(generation.current!==g)return;
      const found = list.find(
        (t) =>
          t.model_id === modelId &&
          (t.task_id ?? undefined) === taskId,
      );
      const p = found
        ? await rpcData(createApi(transport).api.user.threads[':id'].$get({param:{id:found.id},query:{}}))
        : await rpcData(createApi(transport).api.user.threads.$post({json:{modelId,...(taskId?{taskId}:{})}}));
      if (generation.current === g) {
        accept(p);
        setError("");
      }
    })().catch((e) => {
      if (generation.current === g) setError(e.message);
    }).finally(() => {
      if (generation.current === g) setLoading(false);
    });
    return () => {
      generation.current++;
    };
  }, [transport, scope, accept, retryIndex]);
  const refresh = useCallback(async ():Promise<void> => {
    const p = current.current;
    if (!p) return;
    if (writing.current || refreshing.current !== null) {refreshQueued.current=true;return;}
    const g = generation.current,
      r = revision.current,
      ticket = ++reading.current;
    refreshing.current=g;refreshQueued.current=false;
    try {
    const next = await rpcData(createApi(transport).api.user.threads[':id'].$get({param:{id:p.id},query:{}}));
    if (
      g === generation.current &&
      r === revision.current &&
      !writing.current &&
      ticket === reading.current &&
      next.version >= (current.current?.version ?? 0)
    ) {
      setError("");
      // An idle turn does not acknowledge a particular POST. Keep its requestId
      // across refreshes until an explicit retry receives the write response.
      accept(mergeLatest(current.current!, next));
    }
    } catch(error) {
      if(g===generation.current)throw error;
    } finally {
      if(refreshing.current===g){
        refreshing.current=null;
        if(g===generation.current&&refreshQueued.current&&!writing.current)
          void refresh().catch(e=>{if(g===generation.current)setError(e.message);});
      }
    }
  }, [transport, accept]);
  useEffect(() => {
    if (!page?.id) return;
    const unsubscribe=transport.subscribe?.(()=>void refresh().catch((e)=>setError(e.message)));
    const timer = setInterval(
      () => void refresh().catch((e) => setError(e.message)),
      transport.subscribe ? 15000 : 3000,
    );
    return () => {clearInterval(timer);unsubscribe?.();};
  }, [page?.id, refresh,transport]);
  async function send(content: string) {
    const p = current.current;
    if (!p) throw new Error("会话尚未加载");
    if (writing.current) throw new Error("消息正在发送");
    if (
      attempt.current &&
      (attempt.current.content !== content)
    )
      throw new Error("请先重试上一条消息以确认结果");
    attempt.current ??= {
      content,
      requestId: crypto.randomUUID(),
    };
    const g = generation.current;
    revision.current++;
    writing.current = true;
    setSending({id:`pending_${attempt.current.requestId}`,content});
    try {
      const result = await rpcData(createApi(transport).api.user.threads[':id'].messages.$post({param:{id:p.id},json:attempt.current}));
      if (g !== generation.current) return result;
      accept(mergeLatest(current.current!, result));
      attempt.current = null;
      if (
        ('status' in result?result.status:undefined) === "failed" ||
        ('status' in result?result.status:undefined) === "unknown" ||
        ('status' in result?result.status:undefined) === "cancelled"
      )
        throw new Error(('error' in result&&typeof result.error==='string'?result.error:undefined) ?? "本轮未完成");
      return result;
    } finally {
      if (g === generation.current) {
        writing.current = false;
        revision.current++;
        setSending(null);
        // POST 返回的是某一时刻的快照；随后完成的推理或写入通知可能已到达，立即补读。
        void refresh().catch(e=>{if(g===generation.current)setError(e.message);});
      }
    }
  }
  async function older() {
    const p = current.current;
    if (!p || loadingOlder.current || (!p.nextCursor&&!p.nextReplyCursor)) return;
    const g = generation.current;
    const ticket = Symbol();
    loadingOlder.current = ticket;
    try {
    const old = await rpcData(createApi(transport).api.user.threads[':id'].$get({param:{id:p.id},query:{before:p.nextCursor??1,beforeReply:p.nextReplyCursor??1}}));
    if (g === generation.current && current.current)
      accept({
        ...current.current,
        // 新快照可能在请求途中发现更近的缺口；旧分页只推进自己请求的边界。
        nextCursor: current.current.nextCursor === p.nextCursor ? old.nextCursor : current.current.nextCursor,
        nextReplyCursor: current.current.nextReplyCursor === p.nextReplyCursor ? old.nextReplyCursor : current.current.nextReplyCursor,
        replies:mergeReplies(old.replies,current.current.replies),
        messages: [...current.current.messages, ...old.messages].filter(
          (m, i, a) => a.findIndex((n) => n.id === m.id) === i,
        ).sort((a, b) => a.seq - b.seq),
      });
    } catch(e){if(g===generation.current)setError((e as Error).message);}
    finally {if(loadingOlder.current===ticket)loadingOlder.current=null;}
  }
  function retry() {
    if(loading)return;
    if(!current.current){setRetryIndex(x=>x+1);return;}
    const g=generation.current;
    setLoading(true);
    void refresh().catch(e=>{if(g===generation.current)setError(e.message);})
      .finally(()=>{if(g===generation.current)setLoading(false);});
  }
  return { page, error, loading, sending, retry, send, refresh, older };
}
