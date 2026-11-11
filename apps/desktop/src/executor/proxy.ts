import http from "node:http";
import net from "node:net";
import { networkReason, networkEventLimit, type NetworkEvent } from "../shared/network-log";
import { isPublicIp, publicUrl } from "../../../../packages/contracts/src/security";
type Sample = Omit<NetworkEvent, "at" | "connection">;
/** Resolve the origin through authenticated HTTPS DNS, not a local TUN's fake-IP
 * mapping. Every answer is checked and the selected public IP is pinned below. */
export async function resolvePublicHost(hostname: string, log?: (sample: Sample) => void) {
  publicUrl(`https://${hostname.includes(":") ? "[" + hostname + "]" : hostname}`);
  if (net.isIP(hostname)) return [{ address: hostname, family: net.isIP(hostname) }];
  const answers = await Promise.all(
    (["A", "AAAA"] as const).map(async (type) => {
      let data: { Status: number; Answer?: { type: number; data: string }[] } | undefined;
      // Only the credential-free, read-only DNS lookup may retry. No CONNECT
      // success or browser bytes are sent until all answers pass public-IP checks.
      for (let attempt = 0; attempt < 2; attempt++) {
        const started = performance.now();
        const attemptNumber = attempt === 0 ? 1 : 2;
        let httpStatus: number | undefined;
        try {
          const response = await fetch(
            `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
            {
              headers: { accept: "application/dns-json" },
              redirect: "error",
              signal: AbortSignal.timeout(10000),
            },
          );
          httpStatus = response.status;
          if (!response.ok) throw new Error("DNS_LOOKUP_FAILED");
          data = (await response.json()) as typeof data;
          log?.({
            phase: "dns",
            query: type,
            attempt: attemptNumber,
            httpStatus,
            dnsStatus: data?.Status,
            result: data?.Status === 0 ? "ok" : "error",
            answers: Array.isArray(data?.Answer)
              ? data.Answer.filter((a) => a?.type === 1 || a?.type === 28).length
              : 0,
            elapsedMs: Math.round(performance.now() - started),
          });
          break;
        } catch (error) {
          log?.({
            phase: "dns",
            query: type,
            attempt: attemptNumber,
            httpStatus,
            result: "error",
            reason: networkReason(error),
            elapsedMs: Math.round(performance.now() - started),
          });
          const e = error as Error & { cause?: { code?: string } };
          const transient =
            [
              "ECONNRESET",
              "ETIMEDOUT",
              "EAI_AGAIN",
              "UND_ERR_CONNECT_TIMEOUT",
              "UND_ERR_SOCKET",
            ].includes(e.cause?.code ?? "") || e.name === "TimeoutError";
          if (!transient) throw error;
          if (attempt === 1) throw new Error("DNS_TRANSPORT_FAILED");
        }
      }
      if (!data) throw new Error("DNS_LOOKUP_FAILED");
      if (data.Status !== 0) throw new Error("DNS_LOOKUP_FAILED");
      return (data.Answer ?? [])
        .filter((a) => a.type === 1 || a.type === 28)
        .map((a) => ({ address: a.data, family: net.isIP(a.data) }));
    }),
  );
  const addresses = answers.flat();
  if (!addresses.length || addresses.some((a) => !a.family || !isPublicIp(a.address)))
    throw new Error("PRIVATE_NETWORK_BLOCKED");
  return addresses;
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
