import WebSocket from 'ws';
import { browserStateSchema,type BrowserState } from '../../../../packages/contracts/src/accounts';

/** Main 自有 Chromium 的状态适配器。只实现固定的 Cookie/DOMStorage 操作，
 * 不暴露脚本执行给模型。临时文档由 Fetch 截获后在目标 origin 初始化，网站脚本不会先读到未恢复的值。 */
class Cdp {
  private sequence=0;
  private pending=new Map<number,{resolve:(value:Record<string,unknown>)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private listeners=new Set<(message:{method?:string;params?:Record<string,unknown>;sessionId?:string})=>void>();
  private constructor(private socket:WebSocket){
    socket.on('message',data=>{
      const message=JSON.parse(data.toString());
      if(message.id){const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);clearTimeout(pending.timer);if(message.error)pending.reject(Error('BROWSER_STATE_CDP_FAILED'));else pending.resolve(message.result??{});}
      else for(const listener of this.listeners)listener(message);
    });
    socket.on('close',()=>{for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(Error('BROWSER_STATE_DISCONNECTED'));}this.pending.clear();});
    socket.on('error',()=>{});
  }
  static async connect(cdpUrl:string){
    const url=new URL(cdpUrl);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw Error('BROWSER_STATE_CDP_INVALID');
    const response=await fetch(new URL('/json/version',url),{signal:AbortSignal.timeout(10_000)});
    const info=await response.json() as {webSocketDebuggerUrl:string};
    const endpoint=new URL(info.webSocketDebuggerUrl);
    if(endpoint.protocol!=='ws:'||endpoint.hostname!=='127.0.0.1'||endpoint.port!==url.port)throw Error('BROWSER_STATE_CDP_INVALID');
    const socket=new WebSocket(endpoint,{handshakeTimeout:10_000});
    await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',()=>reject(Error('BROWSER_STATE_CONNECT_FAILED')));});
    return new Cdp(socket);
  }
  send(method:string,params:Record<string,unknown>={},sessionId?:string):Promise<Record<string,unknown>>{
    return new Promise((resolve,reject)=>{
      const id=++this.sequence,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('BROWSER_STATE_TIMEOUT'));},10_000);
      this.pending.set(id,{resolve,reject,timer});
      this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
    });
  }
  on(listener:(message:{method?:string;params?:Record<string,unknown>;sessionId?:string})=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  close(){this.socket.close();}
}
export class BrowserStateAdapter {
  private constructor(private cdp:Cdp){}
  static async connect(cdpUrl:string){return new BrowserStateAdapter(await Cdp.connect(cdpUrl));}
  async restoreMissingCookies(state:BrowserState){
    const current=browserStateSchema.shape.cookies.parse((await this.cdp.send('Storage.getCookies')).cookies);
    const identity=(cookie:BrowserState['cookies'][number])=>JSON.stringify([cookie.name,cookie.domain,cookie.path,cookie.partitionKey]);
    const existing=new Set(current.map(identity));
    // 正常关闭也可能未刷盘。干净且同版本的云端快照可补所有缺失 Cookie，
    // 已有值不覆盖；dirty 本地环境由调用方禁止此恢复，以免复活已退出的状态。
    const cookies=state.cookies.filter(cookie=>(cookie.expires===undefined||cookie.expires<=0||cookie.expires>Date.now()/1000)&&!existing.has(identity(cookie))).map(cookie=>{const value={...cookie};if(value.expires!==undefined&&value.expires<0)delete value.expires;return value;});
    if(cookies.length)await this.cdp.send('Storage.setCookies',{cookies});
  }
  async restore(input:BrowserState){
    const state=browserStateSchema.parse(input);
    await this.cdp.send('Storage.clearCookies');
    const cookies=state.cookies.filter(cookie=>cookie.expires===undefined||cookie.expires<=0||cookie.expires>Date.now()/1000).map(cookie=>{
      const value={...cookie};if(value.expires!==undefined&&value.expires<0)delete value.expires;return value;
    });
    if(cookies.length)await this.cdp.send('Storage.setCookies',{cookies});
    for(const entry of state.origins)await this.withOrigin(entry.origin,async sessionId=>{
      const storageId={securityOrigin:entry.origin,isLocalStorage:true};
      await this.cdp.send('DOMStorage.clear',{storageId},sessionId);
      for(const [key,value] of entry.localStorage)await this.cdp.send('DOMStorage.setDOMStorageItem',{storageId,key,value},sessionId);
    });
  }
  async capture(origins:string[]):Promise<BrowserState>{
    const raw=await this.cdp.send('Storage.getCookies'),hosts=origins.map(origin=>new URL(origin).hostname);
    const cookies=browserStateSchema.shape.cookies.parse(raw.cookies).filter(cookie=>hosts.some(host=>cookie.domain.startsWith('.')?(host===cookie.domain.slice(1)||host.endsWith(cookie.domain)):host===cookie.domain));
    const storage:BrowserState['origins']=[];
    for(const origin of [...new Set(origins)])await this.withOrigin(origin,async sessionId=>{
      const data=await this.cdp.send('DOMStorage.getDOMStorageItems',{storageId:{securityOrigin:origin,isLocalStorage:true}},sessionId);
      storage.push({origin,localStorage:browserStateSchema.shape.origins.element.shape.localStorage.parse(data.entries)});
    });
    return {version:1,cookies,origins:storage};
  }
  private async withOrigin(origin:string,action:(sessionId:string)=>Promise<void>){
    const target=await this.cdp.send('Target.createTarget',{url:'about:blank'}),targetId=String(target.targetId);
    let remove=()=>{};
    try {
      const attached=await this.cdp.send('Target.attachToTarget',{targetId,flatten:true}),sessionId=String(attached.sessionId);
      await this.cdp.send('Page.enable',{},sessionId);
      await this.cdp.send('Network.setBypassServiceWorker',{bypass:true},sessionId);
      await this.cdp.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]},sessionId);
      let loadResolve:()=>void=()=>{},loadReject:(error:Error)=>void=()=>{};
      const loaded=new Promise<void>((resolve,reject)=>{loadResolve=resolve;loadReject=reject;});
      // 捕获拒绝，避免导航先失败时加载 promise 留下未处理 rejection。
      void loaded.catch(()=>{});
      const timer=setTimeout(()=>loadReject(Error('BROWSER_STATE_ORIGIN_TIMEOUT')),10_000);
      remove=this.cdp.on(message=>{
        if(message.sessionId!==sessionId)return;
        if(message.method==='Page.loadEventFired')loadResolve();
        if(message.method==='Fetch.requestPaused')void this.cdp.send('Fetch.fulfillRequest',{requestId:message.params?.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html'},{name:'Cache-Control',value:'no-store'}],body:Buffer.from('<!doctype html><title>TaskRelay state</title>').toString('base64')},sessionId).catch(()=>loadReject(Error('BROWSER_STATE_ORIGIN_FAILED')));
      });
      try{await this.cdp.send('Page.navigate',{url:`${origin}/`},sessionId);await loaded;await action(sessionId);}finally{clearTimeout(timer);}
    } finally {remove();await this.cdp.send('Target.closeTarget',{targetId}).catch(()=>{});}
  }
  close(){this.cdp.close();}
}
