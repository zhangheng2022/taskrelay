import React from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "../../../packages/ui/src/auth-gate";
import { App } from "../../../packages/ui/src/app";
import type { Transport } from "../../../packages/contracts/src/index";
const transport: Transport = {
  subscribe(fn){
    let stopped=false,socket:WebSocket|undefined,timer:ReturnType<typeof setTimeout>|undefined,failures=0;
    const connect=()=>{
      if(stopped||document.hidden)return;
      socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/api/user/events`);
      socket.onopen=()=>{failures=0;fn();};
      socket.onmessage=()=>fn();
      socket.onclose=()=>{if(!stopped)timer=setTimeout(connect,Math.min(60000,3000*2**Math.min(failures++,5)));};
      socket.onerror=()=>socket?.close();
    };
    const visibility=()=>{if(document.hidden){clearTimeout(timer);socket?.close();}else{clearTimeout(timer);connect();fn();}};
    document.addEventListener('visibilitychange',visibility);connect();
    return()=>{stopped=true;clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);socket?.close();};
  },
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(180000),
      });
    } catch {
      throw new Error("OFFLINE");
    }
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw new Error("云端暂时返回了异常响应，请稍后刷新。已有请求不会自动重复提交。");
    const data = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(data.error ?? `HTTP_${response.status}`);
    return data;
  },
};
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGate transport={transport}><App transport={transport} /></AuthGate>
  </React.StrictMode>,
);
