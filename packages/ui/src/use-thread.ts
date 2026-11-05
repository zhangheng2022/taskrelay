import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskInput, Transport } from "../../contracts/src/index";
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
    writing = useRef(false);
  const accept = useCallback((p: ThreadPage) => {
    current.current = p;
    setPage(p);
  }, []);
  useEffect(() => {
    const g = ++generation.current;
    revision.current++;
    writing.current = false;
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
      if (!next.activeTurn) attempt.current = null;
      accept({
        ...next,
        replies:mergeReplies(current.current?.replies,next.replies),
        messages: [
          ...(current.current?.messages ?? []).filter(
            (m) => !next.messages.some((n) => n.id === m.id),
          ),
          ...next.messages,
        ].sort((a, b) => a.seq - b.seq),
      });
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
      accept({
        ...result,
        replies:mergeReplies(current.current?.replies,result.replies),
        messages: [
          ...(current.current?.messages ?? []).filter(
            (m) => !result.messages.some((n) => n.id === m.id),
          ),
          ...result.messages,
        ],
      });
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
    if (!p || (!p.nextCursor&&!p.nextReplyCursor)) return;
    const g = generation.current;
    try {
    const old = await transport.request<ThreadPage>(
      "GET",
      `/api/user/threads/${p.id}?before=${p.nextCursor??1}&beforeReply=${p.nextReplyCursor??1}`,
    );
    if (g === generation.current && current.current)
      accept({
        ...current.current,
        nextCursor: old.nextCursor,
        nextReplyCursor:old.nextReplyCursor,
        replies:mergeReplies(old.replies,current.current.replies),
        messages: [...old.messages, ...current.current.messages].filter(
          (m, i, a) => a.findIndex((n) => n.id === m.id) === i,
        ),
      });
    } catch(e){if(g===generation.current)setError((e as Error).message);}
  }
  async function clear() {
    const p = current.current;
    if (!p) return;
    const g=generation.current;
    await transport.request("DELETE", `/api/user/threads/${p.id}`);
    if(g!==generation.current)return;
    const nextGeneration=++generation.current;
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
