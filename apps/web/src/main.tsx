import React from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "../../../packages/ui/src/auth-gate";
import { App } from "../../../packages/ui/src/app";
import type { Transport } from "../../../packages/contracts/src/index";
import { requestJson } from "../../../packages/ui/src/request";
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
    const network=()=>fn();
    window.addEventListener('online',network);window.addEventListener('offline',network);
    document.addEventListener('visibilitychange',visibility);connect();
    return()=>{stopped=true;clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('online',network);window.removeEventListener('offline',network);socket?.close();};
  },
  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return requestJson<T>(path, {method, body});
  },
};
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGate transport={transport}><App transport={transport} /></AuthGate>
  </React.StrictMode>,
);
