import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskInput, Transport } from "../../contracts/src/index";
// 管理新任务和既有任务共用的聊天生命周期：查找/创建、通知刷新、发送、历史分页与清空。
// generation 隔离会话切换，revision 隔离读写交错；attempt 保存待确认发送的原文和幂等标识。
export type ThreadPage = {
  id: string;
  version: number;
  modelId: string;
  taskId?:string|null;
  queued?:{id:string;content:string;at:string}[];
  conditions?:{run_id:string;task_version:number;instruction_version:number;content:string;confirmed_content:string|null;confirmed_at:string|null;approved_version:number|null;current_version:number}|null;
  draft: TaskInput | null;
  partial: { facts?: string; missing?: string[] };
  activeTurn: string | null;
  latestTurn?: { status: string; error?: string };
  waiting?:{id:string;request:string}|null;
  messages: {
    id: string;
    seq: number;
    role: string;
    content: string;
    at: string;
    private?:boolean;
    source?:string;
    parts?:import("../../contracts/src/execution").ChatPart[];
  }[];
  nextCursor: number | null;
  replies?:{id:string;cursor:number;role:string;content:string;at:string;status:string}[];
  nextReplyCursor?:number|null;
};
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
    refreshing = useRef(false),
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
    loadingOlder.current = null;
    current.current = null;
    setPage(null);
    attempt.current = null;
    setError('');
    setLoading(!!modelId);
    if (!modelId) return;
    (async () => {
      const list = await transport.request<
        { id: string; kind: string; model_id: string; task_id: string | null }[]
      >("GET", "/api/user/threads");
      if(generation.current!==g)return;
      const found = list.find(
        (t) =>
          t.model_id === modelId &&
          (t.task_id ?? undefined) === taskId,
      );
      const p = found
        ? await transport.request<ThreadPage>(
            "GET",
            `/api/user/threads/${found.id}`,
          )
        : await transport.request<ThreadPage>("POST", "/api/user/threads", {
            modelId,
            ...(taskId ? { taskId } : {}),
          });
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
  const refresh = useCallback(async () => {
    const p = current.current;
    if (!p || refreshing.current) return;
    refreshing.current=true;
    try {
    const g = generation.current,
      r = revision.current,
      ticket = ++reading.current;
    const next = await transport.request<ThreadPage>(
      "GET",
      `/api/user/threads/${p.id}`,
    );
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
    } finally {refreshing.current=false;}
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
    try {
      const result = await transport.request<
        ThreadPage & { status: string; error?: string }
      >("POST", `/api/user/threads/${p.id}/messages`, attempt.current);
      if (g !== generation.current) return result;
      accept(mergeLatest(current.current!, result));
      attempt.current = null;
      if (
        result.status === "failed" ||
        result.status === "unknown" ||
        result.status === "cancelled"
      )
        throw new Error(result.error ?? "本轮未完成");
      return result;
    } finally {
      if (g === generation.current) {
        writing.current = false;
        revision.current++;
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
    const old = await transport.request<ThreadPage>(
      "GET",
      `/api/user/threads/${p.id}?before=${p.nextCursor??1}&beforeReply=${p.nextReplyCursor??1}`,
    );
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
  async function clear() {
    const p = current.current;
    if (!p) return;
    const g=generation.current;
    await transport.request("DELETE", `/api/user/threads/${p.id}`);
    if(g!==generation.current)return;
    const nextGeneration=++generation.current;
    writing.current=false;
    loadingOlder.current=null;
    current.current=null;setPage(null);
    revision.current++;
    attempt.current = null;
    const next = await transport.request<ThreadPage>(
      "POST",
      "/api/user/threads",
      { modelId, ...(taskId ? { taskId } : {}) },
    );
    if(nextGeneration===generation.current)accept(next);
  }
  function retry() {
    if(loading)return;
    if(!current.current){setRetryIndex(x=>x+1);return;}
    const g=generation.current;
    setLoading(true);
    void refresh().catch(e=>{if(g===generation.current)setError(e.message);})
      .finally(()=>{if(g===generation.current)setLoading(false);});
  }
  return { page, error, loading, retry, send, refresh, older, clear };
}
