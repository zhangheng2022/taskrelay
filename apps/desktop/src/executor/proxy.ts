import http from "node:http";
import net from "node:net";
import { isPublicIp, publicUrl } from "../../../../packages/contracts/src/security";
/** Resolve the origin through authenticated HTTPS DNS, not a local TUN's fake-IP
 * mapping. Every answer is checked and the selected public IP is pinned below. */
export async function resolvePublicHost(hostname:string) {
  publicUrl(`https://${hostname.includes(':')?'['+hostname+']':hostname}`);
  if(net.isIP(hostname))return [{address:hostname,family:net.isIP(hostname)}];
  const answers=await Promise.all(['A','AAAA'].map(async type=>{
    let data:{Status:number;Answer?:{type:number;data:string}[]}|undefined;
    // Only the credential-free, read-only DNS lookup may retry. No CONNECT
    // success or browser bytes are sent until all answers pass public-IP checks.
    for(let attempt=0;attempt<2;attempt++){
      try{
        const response=await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,{
          headers:{accept:'application/dns-json'},redirect:'error',signal:AbortSignal.timeout(10000),
        });
        if(!response.ok)throw new Error('DNS_LOOKUP_FAILED');
        data=await response.json() as typeof data;
        break;
      }catch(error){
        const e=error as Error & {cause?:{code?:string}};
        const transient=['ECONNRESET','ETIMEDOUT','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(e.cause?.code??'')||e.name==='TimeoutError';
        if(!transient)throw error;
        if(attempt===1)throw new Error('DNS_TRANSPORT_FAILED');
      }
    }
    if(!data)throw new Error('DNS_LOOKUP_FAILED');
    if(data.Status!==0)throw new Error('DNS_LOOKUP_FAILED');
    return (data.Answer??[]).filter(a=>a.type===1||a.type===28).map(a=>({address:a.data,family:net.isIP(a.data)}));
  }));
  const addresses=answers.flat();
  if(!addresses.length||addresses.some(a=>!a.family||!isPublicIp(a.address)))throw new Error('PRIVATE_NETWORK_BLOCKED');
  return addresses;
}
// DNS is checked and the returned address is pinned to the outgoing socket.
// HTTPS credentials stay inside the browser's CONNECT tunnel.
export async function startProxy():Promise<{port:number;close:()=>Promise<void>;diagnostics?:()=>Array<{host:string;code:string;at:string}>}> {
  const failures:Array<{host:string;code:string;at:string}>=[];
  const record=(host:string,code:string)=>{failures.push({host:host.slice(0,100),code,at:new Date().toISOString()});if(failures.length>8)failures.shift();};
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
      if (client.destroyed) return;
      const target = net.connect({
        host: addresses[0].address,
        port: 443,
        family: addresses[0].family,
      });
      sockets.add(target);
      const abortTunnel = (code:string) => {
        record(hostname,code);
        client.destroy();
        target.destroy();
      };
      target.on("close", () => {
        sockets.delete(target);
        // pipe forwards a normal FIN and drains buffered bytes. A destroyed
        // upstream does not emit end: explicitly retire the browser's tunnel.
        if (!target.readableEnded && !client.destroyed) abortTunnel('TUNNEL_CLOSED');
      });
      target.on("error", () => abortTunnel('TUNNEL_CONNECTION_FAILED'));
      client.on("error", () => target.destroy());
      client.on("close", () => target.destroy());
      target.setTimeout(60000, () => abortTunnel('TUNNEL_IDLE_TIMEOUT'));
      target.once("connect", () => {
        if (client.destroyed) { target.destroy(); return; }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) target.write(head);
        client.pipe(target);
        target.pipe(client);
      });
    })().catch((error) => {
      const code=error instanceof Error&&['DNS_TRANSPORT_FAILED','DNS_LOOKUP_FAILED','PRIVATE_NETWORK_BLOCKED'].includes(error.message)?error.message:'TUNNEL_SETUP_FAILED';
      try{record(new URL(`https://${req.url}`).hostname,code);}catch{/* Invalid target has no safe host. */}
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
    diagnostics:()=>failures.slice(),
    port: (server.address() as net.AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
