/**
 * 非敏感服务端读取交给 TanStack Query；缓存只存在当前用户/执行器组件树中。
 * 无持久化、隐式重试或离线写入队列。聊天游标、发送幂等和敏感卡片草稿仍由原协议管理。
 */
import { useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import {
  QueryClient,
  QueryClientContext,
  QueryClientProvider,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { Transport } from "../../contracts/src/index";

export function QueryBoundary({ owner, children }: { owner: unknown; children: ReactNode }) {
  const inherited = useContext(QueryClientContext);
  const client = useMemo(
    () =>
      inherited ??
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
            networkMode: "always",
            gcTime: Infinity,
          },
          mutations: { retry: false, networkMode: "always", gcTime: 0 },
        },
      }),
    [inherited, owner],
  );
  useEffect(
    () => () => {
      if (!inherited) {
        void client.cancelQueries();
        client.clear();
      }
    },
    [client, inherited],
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function useTransportQuery<T>(
  transport: Pick<Transport, "subscribe">,
  key: QueryKey,
  read: (signal: AbortSignal) => Promise<T>,
  interval: number,
  enabled = true,
) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => read(signal),
    enabled,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  const encoded = JSON.stringify(key);
  useEffect(() => {
    if (!enabled) return;
    const queryKey = JSON.parse(encoded) as QueryKey;
    // 首次读取尚无缓存时，invalidate 默认会合并到旧请求；先取消才能读到通知后的状态。
    return transport.subscribe?.(() => {
      void client
        .cancelQueries({ queryKey, exact: true })
        .then(() => client.invalidateQueries({ queryKey, exact: true }));
    });
  }, [transport, client, encoded, enabled]);
  const refresh = useCallback(async () => {
    await client.cancelQueries({ queryKey: JSON.parse(encoded), exact: true });
    await query.refetch({ throwOnError: true });
  }, [client, encoded, query.refetch]);
  return { ...query, refresh };
}
