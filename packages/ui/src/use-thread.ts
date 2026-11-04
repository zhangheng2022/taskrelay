import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskInput, Transport } from "../../contracts/src/index";
export type ThreadPage = {
  id: string;
  version: number;
  modelId: string;
  draft: TaskInput | null;
  partial: { facts?: string; missing?: string[] };
  activeTurn: string | null;
  latestTurn?: { status: string; error?: string };
  messages: {
    id: string;
    seq: number;
    role: string;
    content: string;
    at: string;
  }[];
  nextCursor: number | null;
};
export function useThread(
  transport: Transport,
  kind: "compose" | "chat",
  modelId: string,
  taskId?: string,
) {
  const [page, setPage] = useState<ThreadPage | null>(null),
    [error, setError] = useState("");
  const scope = `${kind}:${modelId}:${taskId ?? ""}`,
    generation = useRef(0),
    current = useRef<ThreadPage | null>(null),
    attempt = useRef<{
      content: string;
      requestId: string;
      expectedVersion: number;
      mode: "chat" | "report";
      runId?: string;
    } | null>(null);
  const revision = useRef(0),
    reading = useRef(0),
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
    if (!modelId) return;
    (async () => {
      const list = await transport.request<
        { id: string; kind: string; model_id: string; task_id: string | null }[]
      >("GET", "/api/user/threads");
      if(generation.current!==g)return;
      const found = list.find(
        (t) =>
          t.kind === kind &&
          t.model_id === modelId &&
          (t.task_id ?? undefined) === taskId,
      );
      const p = found
        ? await transport.request<ThreadPage>(
            "GET",
            `/api/user/threads/${found.id}`,
          )
        : await transport.request<ThreadPage>("POST", "/api/user/threads", {
            kind,
            modelId,
            ...(taskId ? { taskId } : {}),
          });
      if (generation.current === g) {
        accept(p);
        setError("");
      }
    })().catch((e) => {
      if (generation.current === g) setError(e.message);
    });
    return () => {
      generation.current++;
    };
  }, [transport, scope, accept]);
  const refresh = useCallback(async () => {
    const p = current.current;
    if (!p) return;
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
        messages: [
          ...(current.current?.messages ?? []).filter(
            (m) => !next.messages.some((n) => n.id === m.id),
          ),
          ...next.messages,
        ].sort((a, b) => a.seq - b.seq),
      });
    }
  }, [transport, accept]);
  useEffect(() => {
    if (!page?.activeTurn) return;
    const unsubscribe=transport.subscribe?.(()=>void refresh().catch((e)=>setError(e.message)));
    const timer = setInterval(
      () => void refresh().catch((e) => setError(e.message)),
      transport.subscribe ? 15000 : 3000,
    );
    return () => {clearInterval(timer);unsubscribe?.();};
  }, [page?.activeTurn, refresh,transport]);
  async function send(content: string, mode: "chat" | "report" = "chat", runId?: string) {
    const p = current.current;
    if (!p) throw new Error("会话尚未加载");
    if (writing.current) throw new Error("消息正在发送");
    if (
      attempt.current &&
      (attempt.current.content !== content || attempt.current.mode !== mode || attempt.current.runId !== runId)
    )
      throw new Error("请先重试上一条消息以确认结果");
    attempt.current ??= {
      content,
      mode,
      ...(runId ? {runId} : {}),
      requestId: crypto.randomUUID(),
      expectedVersion: p.version,
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
        messages: [
          ...(current.current?.messages ?? []).filter(
            (m) => !result.messages.some((n) => n.id === m.id),
          ),
          ...result.messages,
        ],
      });
      if (result.status !== "running") attempt.current = null;
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
  async function saveDraft(draft: TaskInput) {
    const p = current.current;
    if (!p) throw new Error("会话尚未加载");
    const g = generation.current;
    revision.current++;
    writing.current = true;
    try {
      const result = await transport.request<ThreadPage>(
        "PUT",
        `/api/user/threads/${p.id}/draft`,
        { expectedVersion: p.version, draft },
      );
      if (g === generation.current) accept(result);
      else throw new Error("会话已切换");
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
    if (!p?.nextCursor) return;
    const g = generation.current;
    try {
    const old = await transport.request<ThreadPage>(
      "GET",
      `/api/user/threads/${p.id}?before=${p.nextCursor}`,
    );
    if (g === generation.current && current.current)
      accept({
        ...current.current,
        nextCursor: old.nextCursor,
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
      { kind, modelId, ...(taskId ? { taskId } : {}) },
    );
    if(nextGeneration===generation.current)accept(next);
  }
  return { page, error, send, saveDraft, refresh, older, clear };
}
