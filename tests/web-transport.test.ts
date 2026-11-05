import './ui-dom';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createWebTransport } from '../apps/web/src/transport';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalls = 0;
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  // close 事件留给测试按浏览器的异步顺序派发。
  close() { this.closeCalls++; }
}

function browser(t: TestContext) {
  FakeWebSocket.instances = [];
  let hidden = false, online = true;
  const replace = (object: object, key: PropertyKey, descriptor: PropertyDescriptor) => {
    const original = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { configurable: true, ...descriptor });
    t.after(() => {
      if (original) Object.defineProperty(object, key, original);
      else Reflect.deleteProperty(object, key);
    });
  };
  replace(globalThis, 'WebSocket', { value: FakeWebSocket });
  replace(globalThis, 'location', { value: window.location });
  replace(document, 'hidden', { get: () => hidden });
  replace(navigator, 'onLine', { get: () => online });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return {
    sockets: FakeWebSocket.instances,
    visibility(value: boolean) {
      hidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    network(value: boolean) {
      online = value;
      window.dispatchEvent(new Event(value ? 'online' : 'offline'));
    },
  };
}

test('真实 Web Transport 的双订阅共用连接，最后退订才释放并允许重新订阅', t => {
  const env = browser(t), transport = createWebTransport();
  let workspace = 0, thread = 0;
  const offWorkspace = transport.subscribe!(() => { workspace++; });
  const offThread = transport.subscribe!(() => { thread++; });
  assert.equal(env.sockets.length, 1);
  assert.equal(env.sockets[0].url, 'ws://localhost/api/user/events');
  env.sockets[0].onopen!();
  assert.deepEqual([workspace, thread], [1, 1]);
  offWorkspace();
  assert.equal(env.sockets[0].closeCalls, 0);
  env.sockets[0].onmessage!();
  assert.deepEqual([workspace, thread], [1, 2]);
  const lateClose = env.sockets[0].onclose!;
  offThread();
  offThread();
  assert.equal(env.sockets[0].closeCalls, 1);
  env.visibility(false);
  env.network(true);
  assert.deepEqual([workspace, thread], [1, 2]);
  assert.equal(env.sockets.length, 1);
  const offAgain = transport.subscribe!(() => { thread++; });
  lateClose();
  t.mock.timers.tick(60000);
  assert.equal(env.sockets.length, 2);
  offAgain();
  assert.equal(env.sockets[1].closeCalls, 1);
});

test('快速隐显后旧 close/error/open/message 不影响新连接，也不遗留连接', t => {
  const env = browser(t), transport = createWebTransport();
  let notifications = 0;
  const off = transport.subscribe!(() => { notifications++; });
  const previous = env.sockets[0];
  const callbacks = [previous.onclose!, previous.onerror!, previous.onopen!, previous.onmessage!];
  env.visibility(true);
  assert.equal(previous.closeCalls, 1);
  assert.equal(previous.onclose, null);
  env.visibility(false);
  assert.equal(env.sockets.length, 2);
  const count = notifications;
  for (const callback of callbacks) callback();
  t.mock.timers.tick(60000);
  assert.equal(notifications, count);
  assert.equal(env.sockets.length, 2);
  assert.equal(env.sockets[1].closeCalls, 0);
  off();
  assert.deepEqual(env.sockets.map(socket => socket.closeCalls), [1, 1]);
});

test('断开重连计时器在隐藏、离线和最后退订时取消，恢复时只创建一条连接', t => {
  const env = browser(t), transport = createWebTransport();
  const off = transport.subscribe!(() => {});
  env.sockets[0].onclose!();
  t.mock.timers.tick(2999);
  assert.equal(env.sockets.length, 1);
  t.mock.timers.tick(1);
  assert.equal(env.sockets.length, 2);
  env.sockets[1].onclose!();
  env.visibility(true);
  t.mock.timers.tick(60000);
  assert.equal(env.sockets.length, 2);
  env.visibility(false);
  assert.equal(env.sockets.length, 3);
  env.network(false);
  assert.equal(env.sockets[2].closeCalls, 1);
  t.mock.timers.tick(60000);
  assert.equal(env.sockets.length, 3);
  env.network(true);
  env.network(true);
  assert.equal(env.sockets.length, 4);
  env.sockets[3].onclose!();
  off();
  t.mock.timers.tick(60000);
  env.visibility(false);
  assert.equal(env.sockets.length, 4);
});

test('同一回调的两次订阅独立退订', t => {
  const env = browser(t), transport = createWebTransport();
  let notifications = 0;
  const listener = () => { notifications++; };
  const first = transport.subscribe!(listener), second = transport.subscribe!(listener);
  env.sockets[0].onmessage!();
  assert.equal(notifications, 2);
  first();
  env.sockets[0].onmessage!();
  assert.equal(notifications, 3);
  second();
  assert.equal(env.sockets[0].closeCalls, 1);
});

test('Web Transport 的普通请求仍保留未确认写入语义，不自动重试', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('connection lost'); });
  await assert.rejects(createWebTransport().request('POST', '/api/user/tasks', { title: '任务' }), /REQUEST_UNCONFIRMED/);
  assert.equal(calls, 1);
});
