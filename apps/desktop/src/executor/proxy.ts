import http from "node:http";
import net from "node:net";
import { isPublicIp, publicUrl } from "../../../../packages/contracts/src/security";
/** Resolve the origin through authenticated HTTPS DNS, not a local TUN's fake-IP
 * mapping. Every answer is checked and the selected public IP is pinned below. */
export async function resolvePublicHost(hostname:string) {
  publicUrl(`https://${hostname.includes(':')?'['+hostname+']':hostname}`);
  if(net.isIP(hostname))return [{address:hostname,family:net.isIP(hostname)}];
  const answers=await Promise.all(['A','AAAA'].map(async type=>{
    const response=await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,{
      headers:{accept:'application/dns-json'},redirect:'error',signal:AbortSignal.timeout(10000),
    });
    if(!response.ok)throw new Error('DNS_LOOKUP_FAILED');
    const data=await response.json() as {Status:number;Answer?:{type:number;data:string}[]};
    if(data.Status!==0)throw new Error('DNS_LOOKUP_FAILED');
    return (data.Answer??[]).filter(a=>a.type===1||a.type===28).map(a=>({address:a.data,family:net.isIP(a.data)}));
  }));
  const addresses=answers.flat();
  if(!addresses.length||addresses.some(a=>!a.family||!isPublicIp(a.address)))throw new Error('PRIVATE_NETWORK_BLOCKED');
  return addresses;
}
// DNS is checked and the returned address is pinned to the outgoing socket.
// HTTPS credentials stay inside the browser's CONNECT tunnel.
export async function startProxy() {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_req, res) => {
    res.writeHead(403);
    res.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (req, client, head) => {
    void (async () => {
      const url = new URL(`https://${req.url}`);
      if (url.username || url.password || (url.port && url.port !== "443"))
        throw new Error("PORT_BLOCKED");
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = await resolvePublicHost(hostname);
      if (!addresses.length || addresses.some((a) => !isPublicIp(a.address)))
        throw new Error("PRIVATE_NETWORK_BLOCKED");
      const target = net.connect({
        host: addresses[0].address,
        port: 443,
        family: addresses[0].family,
      });
      sockets.add(target);
      target.on("close", () => sockets.delete(target));
      target.on("error", () => client.destroy());
      client.on("error", () => target.destroy());
      client.on("close", () => target.destroy());
      target.setTimeout(60000, () => target.destroy());
      target.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) target.write(head);
        client.pipe(target);
        target.pipe(client);
      });
    })().catch(() => {
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
    port: (server.address() as net.AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
