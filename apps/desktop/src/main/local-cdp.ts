import CDP from 'chrome-remote-interface';
import type { EventEmitter } from 'node:events';

type Event = { method?: string; params?: Record<string, unknown>; sessionId?: string };
/** Main 内部本机 CDP 边界。SDK 管理连接、请求编号与事件分发；本层只校验端点、
 * 固定错误和截止时间。超时关闭整条连接，迟到响应不再留存；浏览器进程仍归 OwnedBrowser。 */
export class LocalCdp {
  private closed = false;
  private closing?: Promise<void>;
  private constructor(private client: CDP.Client & Pick<EventEmitter, 'off'>) {
    client.on('disconnect', () => { this.closed = true; });
    client.on('error', () => { void this.close(); });
  }
  static async connect(cdpUrl: string) {
    let origin: URL;
    try { origin = new URL(cdpUrl); } catch { throw Error('CDP_ENDPOINT_INVALID'); }
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port ||
        origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
      throw Error('CDP_ENDPOINT_INVALID');
    let endpoint: URL;
    try {
      const response = await fetch(new URL('/json/version', origin), { redirect: 'error', signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw Error();
      const info = await response.json() as { webSocketDebuggerUrl?: unknown };
      if (typeof info.webSocketDebuggerUrl !== 'string') throw Error();
      endpoint = new URL(info.webSocketDebuggerUrl);
    } catch { throw Error('CDP_DISCOVERY_FAILED'); }
    if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || endpoint.port !== origin.port ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^\/devtools\/browser\/[\w-]+$/.test(endpoint.pathname))
      throw Error('CDP_ENDPOINT_INVALID');
    // local:true 使用 SDK 内置协议，不再抓取远端协议或列举其他 Target。
    // scripts/cdp-policy.mjs 给 SDK 握手设置硬超时并禁止重定向。
    try { return new LocalCdp(await CDP({ target: endpoint.href, local: true }) as CDP.Client & Pick<EventEmitter, 'off'>); }
    catch { throw Error('CDP_CONNECT_FAILED'); }
  }
  async send(method: Parameters<CDP.Client['send']>[0], params: Record<string, unknown> = {}, sessionId?: string, timeout = 10000): Promise<Record<string, unknown>> {
    if (this.closed) throw Error('CDP_DISCONNECTED');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.client.send(method, params as Parameters<CDP.Client['send']>[1], sessionId).then(value => (value ?? {}) as Record<string, unknown>).catch(() => { throw Error(this.closed ? 'CDP_DISCONNECTED' : 'CDP_COMMAND_FAILED'); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { void this.close(); reject(Error('CDP_TIMEOUT')); }, timeout); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  on(listener: (message: Event) => void) {
    this.client.on('event', listener);
    return () => { this.client.off('event', listener); };
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= this.client.close().catch(() => {});
  }
}
