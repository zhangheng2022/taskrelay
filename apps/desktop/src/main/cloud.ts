import { PROTOCOL_VERSION, HISTORY_EPOCH } from "../../../../packages/contracts/src/index";
import { safeStorage } from "electron";
import { Journal } from "./journal";
import WebSocket from 'ws';
export class Cloud {
  online = false;
  private readyUntil=0;
  private stopEvents:(()=>void)|null=null;
  constructor(readonly journal: Journal) {}
  get url() {
    return (
      this.journal.get<string>("cloudUrl") ??
      "https://tr.zhangheng.eu.org"
    );
  }
  get paired() {
    return !!this.journal.get<string>("token");
  }
  storeToken(token: string) {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("OS_ENCRYPTION_UNAVAILABLE");
    this.journal.set(
      "token",
      safeStorage.encryptString(token).toString("base64"),
    );
  }
  private token() {
    const encrypted = this.journal.get<string>("token");
    if (!encrypted) throw new Error("DEVICE_UNAUTHORIZED");
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  }
  async connect(executorIdle:boolean) {
    type Status={maintenance:boolean;historyEpoch:number};
    let status:Status;
    try {status=await this.request<Status>('GET','/api/device/status');}
    catch(error) {
      if((error as Error).message!=='DEVICE_UPGRADE_REQUIRED')throw error;
      if(!executorIdle||this.journal.pending().length||this.journal.incomplete().length)throw new Error('LOCAL_HISTORY_UNRESOLVED');
      await this.request('POST','/api/device/upgrade',{protocolVersion:PROTOCOL_VERSION,localReady:true});
      status=await this.request<Status>('GET','/api/device/status');
    }
    if(!status.maintenance)this.readyUntil=0;
    if(status.maintenance&&Date.now()>this.readyUntil&&executorIdle&&!this.journal.pending().length&&!this.journal.incomplete().length){
      await this.request('POST','/api/device/upgrade',{protocolVersion:PROTOCOL_VERSION,localReady:true});
      this.readyUntil=Date.now()+180000;
    }
    if(status.historyEpoch===HISTORY_EPOCH&&this.journal.get('historyEpoch')!==HISTORY_EPOCH){if(!executorIdle)throw new Error('EXECUTOR_BUSY');this.journal.clearHistory();}
    return status;
  }
  watch(fn:()=>void){
    this.stopEvents?.();
    let stopped=false,socket:WebSocket|undefined,timer:ReturnType<typeof setTimeout>|undefined,failures=0;
    const start=()=>{
      if(stopped)return;
      if(!this.paired){timer=setTimeout(start,30000);return;}
      const url=new URL('/api/device/events',this.url);url.protocol=url.protocol==='https:'?'wss:':'ws:';
      try{
        socket=new WebSocket(url,{headers:{Authorization:`Bearer ${this.token()}`,'x-taskrelay-protocol':String(PROTOCOL_VERSION)},handshakeTimeout:12000,followRedirects:false});
        socket.on('open',()=>{failures=0;fn();});
        socket.on('message',()=>fn());
        socket.on('error',()=>socket?.close());
        socket.on('close',()=>{if(!stopped)timer=setTimeout(start,Math.min(60000,3000*2**Math.min(failures++,5)));});
      }catch{if(!stopped)timer=setTimeout(start,30000);}
    };
    start();this.stopEvents=()=>{stopped=true;clearTimeout(timer);socket?.close();};
  }
  close(){this.stopEvents?.();this.stopEvents=null;}
  async request<T>(
    method: string,
    p: string,
    body?: unknown,
    publicCall = false,
    binary?: Uint8Array,
  ): Promise<T> {
    const response = await fetch(`${this.url}${p}`, {
      method,
      headers: {
        "x-taskrelay-protocol":String(PROTOCOL_VERSION),
        ...(publicCall ? {} : { Authorization: `Bearer ${this.token()}` }),
        ...(binary
          ? {
              "Content-Type": "image/png",
              "x-lease-epoch": String((body as { epoch: number }).epoch),
            }
          : body
            ? { "Content-Type": "application/json" }
            : {}),
      },
      body: binary
        ? Buffer.from(binary)
        : body
          ? JSON.stringify(body)
          : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(
        p.includes("/heartbeat") || p.endsWith("/claim") || method === "GET"
          ? 12000
          : 180000,
      ),
    }).catch(() => {
      this.online = false;
      throw new Error("OFFLINE");
    });
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw new Error("CLOUD_RESPONSE_INVALID");
    this.online = true;
    const data = (await response.json()) as T & { error?: string };
    if (!response.ok)
      throw Object.assign(new Error(data.error ?? `HTTP_${response.status}`), {
        data,
      });
    return data;
  }
}
