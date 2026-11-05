import type { Transport } from "../../../packages/contracts/src/index";
import { requestJson } from "../../../packages/ui/src/request";

// 网站请求与通知的浏览器 adapter。所有订阅共享一条连接；最后退订释放连接、定时器和事件。
// 每个回调只操作自己仍持有的连接，防止旧 close/error 在切回页面后影响新连接。
export function createWebTransport(): Transport {
  const subscribers = new Set<() => void>();
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  const notify = () => {
    for (const listener of [...subscribers]) listener();
  };
  const clearRetry = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const disconnect = () => {
    const previous = socket;
    socket = undefined;
    if (!previous) return;
    previous.onopen = previous.onmessage = previous.onclose = previous.onerror = null;
    previous.close();
  };
  const canConnect = () => subscribers.size > 0 && !document.hidden && navigator.onLine !== false;
  const reconnect = () => {
    if (!canConnect() || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      connect();
    }, Math.min(60000, 3000 * 2 ** Math.min(failures++, 5)));
  };
  const connect = () => {
    if (!canConnect() || socket) return;
    let connection: WebSocket;
    try {
      connection = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/user/events`);
    } catch {
      reconnect();
      return;
    }
    socket = connection;
    connection.onopen = () => {
      if (socket !== connection) return;
      failures = 0;
      notify();
    };
    connection.onmessage = () => {
      if (socket === connection) notify();
    };
    connection.onclose = () => {
      if (socket !== connection) return;
      socket = undefined;
      reconnect();
    };
    connection.onerror = () => {
      if (socket === connection) connection.close();
    };
  };
  const visibility = () => {
    clearRetry();
    if (document.hidden) disconnect();
    else {
      connect();
      notify();
    }
  };
  const network = () => {
    clearRetry();
    if (navigator.onLine === false) disconnect();
    else connect();
    notify();
  };

  return {
    subscribe(listener) {
      // 同一个回调的两次订阅仍独立计数，避免其中一次退订提前释放共享资源。
      const subscription = () => listener();
      subscribers.add(subscription);
      if (subscribers.size === 1) {
        window.addEventListener("online", network);
        window.addEventListener("offline", network);
        document.addEventListener("visibilitychange", visibility);
        connect();
      }
      return () => {
        if (!subscribers.delete(subscription) || subscribers.size) return;
        clearRetry();
        disconnect();
        failures = 0;
        window.removeEventListener("online", network);
        window.removeEventListener("offline", network);
        document.removeEventListener("visibilitychange", visibility);
      };
    },
    request<T>(method: string, path: string, body?: unknown): Promise<T> {
      return requestJson<T>(path, { method, body });
    },
  };
}
