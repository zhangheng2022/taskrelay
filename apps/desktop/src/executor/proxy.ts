import http from "node:http";
import net from "node:net";
import { networkReason, networkEventLimit, type NetworkEvent } from "../shared/network-log";
import { isPublicIp, publicUrl } from "../../../../packages/contracts/src/security";
type Sample = Omit<NetworkEvent, "at" | "connection">;
const resolvers = [
  {
    name: "cloudflare",
    endpoint: "https://cloudflare-dns.com/dns-query",
    timeoutMs: 3000,
    attempt: 1,
  },
  { name: "alidns", endpoint: "https://dns.alidns.com/resolve", timeoutMs: 5000, attempt: 2 },
] as const;

const transientDnsErrors = new Set([
  "TimeoutError",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** 每次只查询一个地址族。null 表示传输失败，可换解析器；有效空答案表示该族没有地址。 */
async function queryAddresses(
  hostname: string,
  query: "A" | "AAAA",
  resolver: (typeof resolvers)[number],
  log?: (sample: Sample) => void,
) {
  const started = performance.now();
  const signal = AbortSignal.timeout(resolver.timeoutMs);
  const url = new URL(resolver.endpoint);
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", query);
  const sample = {
    phase: "dns",
    query,
    resolver: resolver.name,
    attempt: resolver.attempt,
  } as const;
  let httpStatus: number | undefined, dnsStatus: number | undefined;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/dns-json" },
      redirect: "error",
      signal,
    });
    httpStatus = response.status;
    if (!response.ok) throw Error("DNS_LOOKUP_FAILED");
    const data = (await response.json()) as {
      Status?: number;
      TC?: boolean;
      Answer?: { type: number; data: string }[];
    };
    dnsStatus = data?.Status;
    if (dnsStatus !== 0 || data.TC || (data.Answer !== undefined && !Array.isArray(data.Answer)))
      throw Error("DNS_LOOKUP_FAILED");
    const addresses = [];
    for (const record of data.Answer ?? []) {
      if (!Number.isInteger(record?.type)) throw Error("DNS_LOOKUP_FAILED");
      if (record.type !== 1 && record.type !== 28) continue;
      const family = record.type === 1 ? 4 : 6;
      if (
        typeof record.data !== "string" ||
        net.isIP(record.data) !== family ||
        !isPublicIp(record.data)
      )
        throw Error("PRIVATE_NETWORK_BLOCKED");
      if (record.type === (query === "A" ? 1 : 28))
        addresses.push({ address: record.data, family });
    }
    log?.({
      ...sample,
      httpStatus,
      dnsStatus,
      answers: addresses.length,
      result: "ok",
      elapsedMs: Math.round(performance.now() - started),
    });
    return addresses;
  } catch (error) {
    const reason = networkReason(
      signal.aborted && error instanceof Error && error.name === "AbortError"
        ? signal.reason
        : error,
    );
    log?.({
      ...sample,
      httpStatus,
      dnsStatus,
      result: "error",
      reason,
      elapsedMs: Math.round(performance.now() - started),
    });
    if (transientDnsErrors.has(reason)) return null;
    throw error;
  }
}

/** 先取 IPv4，必要时查询 IPv6。只容忍传输故障；明确拒绝、非法或非公网答案立即终止。
 * CONNECT 只使用本轮已验证的地址，避免连接时再次按域名解析。
 */
export async function resolvePublicHost(hostname: string, log?: (sample: Sample) => void) {
  publicUrl(`https://${hostname.includes(":") ? "[" + hostname + "]" : hostname}`);
  if (net.isIP(hostname)) return [{ address: hostname, family: net.isIP(hostname) }];
  let transportFailed = false;
  for (const type of ["A", "AAAA"] as const) {
    for (const resolver of resolvers) {
      const addresses = await queryAddresses(hostname, type, resolver, log);
      if (addresses === null) {
        transportFailed = true;
        continue;
      }
      if (addresses.length) return addresses;
      break;
    }
  }
  throw Error(transportFailed ? "DNS_TRANSPORT_FAILED" : "DNS_LOOKUP_FAILED");
}
// DNS is checked and the returned address is pinned to the outgoing socket.
// HTTPS credentials stay inside the browser's CONNECT tunnel.
export async function startProxy(options?: {
  entryHost: string;
  event: (e: NetworkEvent) => void;
}): Promise<{
  port: number;
  close: () => Promise<void>;
  diagnostics?: () => Array<{ host: string; code: string; at: string }>;
}> {
  const failures: Array<{ host: string; code: string; at: string }> = [];
  const record = (host: string, code: string) => {
    failures.push({ host: host.slice(0, 100), code, at: new Date().toISOString() });
    if (failures.length > 8) failures.shift();
  };
  const sockets = new Set<net.Socket>();
  let sequence = 0,
    emitted = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(403);
    res.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (req, client, head) => {
    // CONNECT transfers socket ownership to us before DNS resolves. Install the
    // error handler immediately, including failed setup and browser cancellation.
    let target: net.Socket | undefined;
    const connection = ++sequence,
      started = performance.now();
    client.on("error", () => {
      client.destroy();
      target?.destroy();
    });
    client.on("close", () => target?.destroy());
    void (async () => {
      const url = new URL(`https://${req.url}`);
      if (url.username || url.password || (url.port && url.port !== "443"))
        throw new Error("PORT_BLOCKED");
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      // 只采集任务入口主机；最后多送一个样本以标记截断，限制 IPC 和磁盘写入。
      const emit = (sample: Sample) => {
        if (options && url.hostname === options.entryHost && emitted <= networkEventLimit) {
          emitted++;
          try {
            options.event({ ...sample, at: new Date().toISOString(), connection });
          } catch {
            /* Main 退出时诊断通道可能先关闭。 */
          }
        }
      };
      const addresses = await resolvePublicHost(hostname, emit).catch((error: unknown) => {
        if (
          error instanceof Error &&
          ["PRIVATE_ADDRESS_BLOCKED", "PRIVATE_NETWORK_BLOCKED"].includes(error.message)
        )
          emit({
            phase: "address",
            result: "blocked",
            elapsedMs: Math.round(performance.now() - started),
          });
        throw error;
      });
      if (!addresses.length || addresses.some((a) => !isPublicIp(a.address)))
        throw new Error("PRIVATE_NETWORK_BLOCKED");
      if (client.destroyed) return;
      const dialing = performance.now();
      const family = addresses[0].family === 6 ? 6 : 4;
      emit({ phase: "address", result: "ok", family, elapsedMs: Math.round(dialing - started) });
      const upstream = (target = net.connect({
        host: addresses[0].address,
        port: 443,
        family: addresses[0].family,
      }));
      sockets.add(upstream);
      let connected = false,
        loggedError = false;
      const abortTunnel = (code: string, error?: Error) => {
        if (!loggedError) {
          loggedError = true;
          emit({
            phase: connected ? "tunnel" : "connect",
            result:
              code === "TUNNEL_IDLE_TIMEOUT"
                ? "timeout"
                : code === "TUNNEL_CLOSED"
                  ? "closed"
                  : "error",
            family,
            reason: error ? networkReason(error) : undefined,
            elapsedMs: Math.round(performance.now() - dialing),
          });
        }
        record(hostname, code);
        client.destroy();
        upstream.destroy();
      };
      upstream.on("close", () => {
        sockets.delete(upstream);
        // pipe forwards a normal FIN and drains buffered bytes. A destroyed
        // upstream does not emit end: explicitly retire the browser's tunnel.
        if (!upstream.readableEnded && !client.destroyed) abortTunnel("TUNNEL_CLOSED");
      });
      upstream.on("error", (error) => abortTunnel("TUNNEL_CONNECTION_FAILED", error));
      upstream.setTimeout(60000, () => abortTunnel("TUNNEL_IDLE_TIMEOUT"));
      upstream.once("connect", () => {
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        connected = true;
        emit({
          phase: "connect",
          result: "ok",
          family,
          elapsedMs: Math.round(performance.now() - dialing),
        });
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    })().catch((error) => {
      const code =
        error instanceof Error &&
        ["DNS_TRANSPORT_FAILED", "DNS_LOOKUP_FAILED", "PRIVATE_NETWORK_BLOCKED"].includes(
          error.message,
        )
          ? error.message
          : "TUNNEL_SETUP_FAILED";
      try {
        record(new URL(`https://${req.url}`).hostname, code);
      } catch {
        /* Invalid target has no safe host. */
      }
      if (!client.destroyed) {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return {
    diagnostics: () => failures.slice(),
    port: (server.address() as net.AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
