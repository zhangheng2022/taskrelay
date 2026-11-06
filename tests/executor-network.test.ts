import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvePublicHost,startProxy} from '../apps/desktop/src/executor/proxy';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';

test('浏览器在 DNS 等待期间重置 CONNECT 不触发未捕获异常，也不连接目标',{timeout:5000},async t=>{
 let release!:()=>void,started!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),dnsStarted=new Promise<void>(resolve=>{started=resolve;});
 t.mock.method(globalThis,'fetch',async()=>{started();await gate;return Response.json({Status:0,Answer:[{type:1,data:'1.1.1.1'}]});});
 const original=net.connect;let targets=0;
 t.mock.method(net,'connect',(options:net.NetConnectOpts)=>{
  if('port' in options&&options.port===443)targets++;
  return original(options);
 });
 const proxy=await startProxy(),client=net.connect({host:'127.0.0.1',port:proxy.port});
 t.after(async()=>{release();client.destroy();await proxy.close();});
 await once(client,'connect');
 client.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
 await dnsStarted;
 client.resetAndDestroy();
 await once(client,'close');
 // Allow the real server socket to receive RST before resolving DNS. node:test
 // fails on any uncaught exception; no process-level handler hides the regression.
 await new Promise(resolve=>setTimeout(resolve,100));
 release();await new Promise(resolve=>setTimeout(resolve,30));
 assert.equal(targets,0);
});

// Real TCP on both sides; only DNS and the pinned destination are replaced.
async function tunnelFixture(t:import('node:test').TestContext){
  const received:string[]=[],targets:net.Socket[]=[],origins:net.Socket[]=[],clients:net.Socket[]=[];
  const origin=net.createServer(socket=>{
    origins.push(socket);
    socket.on('error',()=>{});
    socket.on('data',data=>{received.push(data.toString());socket.write('ack');});
  });
  await new Promise<void>(resolve=>origin.listen(0,'127.0.0.1',resolve));
  const connect=net.connect;
  t.mock.method(globalThis,'fetch',async(input:unknown)=>Response.json({Status:0,Answer:
    new URL(String(input)).searchParams.get('type')==='A'?[{type:1,data:'1.1.1.1'}]:[]}));
  t.mock.method(net,'connect',(options:any,...args:any[])=>{
    if(options?.port!==443)return (connect as any).call(net,options,...args);
    const socket=connect({host:'127.0.0.1',port:(origin.address() as net.AddressInfo).port});
    targets.push(socket);return socket;
  });
  const proxy=await startProxy();
  t.after(async()=>{
    for(const socket of [...clients,...origins])socket.destroy();
    await proxy.close();
    await new Promise<void>(resolve=>origin.close(()=>resolve()));
  });
  const open=()=>new Promise<net.Socket>((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:proxy.port,method:'CONNECT',path:'login.example.com:443'});
    req.on('connect',(res,socket)=>{
      clients.push(socket);socket.on('error',()=>{});
      if(res.statusCode!==200){reject(Error('CONNECT_FAILED'));return;}
      resolve(socket);
    });req.on('error',reject);req.end();
  });
  const send=async(socket:net.Socket,text:string)=>{
    const response=once(socket,'data');socket.write(text);
    assert.equal(String((await response)[0]),'ack');
  };
  return {proxy,open,send,received,targets,origins};
}

test('空闲隧道超时关闭浏览器连接并记录原因；新连接可用且不重放请求',{timeout:5000},async t=>{
  const f=await tunnelFixture(t),client=await f.open();
  await f.send(client,'initial-request');
  const closed=once(client,'close');client.resume();
  // Shorten the real timer, retaining the production timeout callback.
  f.targets[0].setTimeout(40);
  await closed;
  assert.equal(f.targets[0].destroyed,true);
  assert.deepEqual(f.proxy.diagnostics!().map(({host,code})=>({host,code})),[
    {host:'login.example.com',code:'TUNNEL_IDLE_TIMEOUT'},
  ]);
  assert.deepEqual(f.received,['initial-request']);
  const next=await f.open();await f.send(next,'next-request');
  assert.deepEqual(f.received,['initial-request','next-request']);
});

test('上游非正常关闭或连接错误立即关闭浏览器端且不泄露错误正文',{timeout:5000},async t=>{
  const f=await tunnelFixture(t);
  for(const failure of [undefined,Error('sensitive upstream detail')]){
    const client=await f.open();await f.send(client,'request');
    const closed=once(client,'close');client.resume();
    f.targets.at(-1)!.destroy(failure);await closed;
  }
  assert.deepEqual(f.proxy.diagnostics!().map(e=>e.code),['TUNNEL_CLOSED','TUNNEL_CONNECTION_FAILED']);
  assert.doesNotMatch(JSON.stringify(f.proxy.diagnostics!()),/sensitive/);
});

test('上游正常结束完整交付缓冲响应，浏览器断开清理上游',{timeout:5000},async t=>{
  const f=await tunnelFixture(t),client=await f.open();
  await f.send(client,'read-request');
  const payload=Buffer.alloc(256*1024,'x'),chunks:Buffer[]=[];
  client.on('data',chunk=>chunks.push(typeof chunk==='string'?Buffer.from(chunk):chunk));
  const ended=once(client,'end');f.origins[0].end(payload);await ended;
  assert.deepEqual(Buffer.concat(chunks),payload);
  const second=await f.open();await f.send(second,'another-request');
  const closed=once(f.targets[1],'close');second.destroy();await closed;
  assert.equal(f.targets[1].destroyed,true);
  assert.deepEqual(f.proxy.diagnostics!(),[]);
});

test('执行器使用固定 HTTPS DNS 并拒绝所有非公网答案，不信任代理虚拟 IP',async t=>{
  let addresses=['104.20.23.154'];
  const calls:string[]=[];
  t.mock.method(globalThis,'fetch',async(input:any,init:any)=>{
    const url=new URL(String(input));calls.push(url.href);
    assert.equal(url.origin,'https://cloudflare-dns.com');
    assert.equal(url.searchParams.get('name'),'example.com');
    assert.equal(init.redirect,'error');
    return Response.json({Status:0,Answer:url.searchParams.get('type')==='A'?addresses.map(data=>({type:1,data})):[]});
  });
  assert.deepEqual(await resolvePublicHost('example.com'),[{address:'104.20.23.154',family:4}]);
  assert.equal(calls.length,2);
  for(const address of ['198.18.1.19','127.0.0.1','192.168.1.1','169.254.169.254','::1','fd00::1','not-an-ip']){
    addresses=['104.20.23.154',address];
    await assert.rejects(resolvePublicHost('example.com'),/PRIVATE_NETWORK_BLOCKED/);
  }
  await assert.rejects(resolvePublicHost('localhost'),/PRIVATE_ADDRESS_BLOCKED/);
  await assert.rejects(resolvePublicHost('127.0.0.1'),/PRIVATE_ADDRESS_BLOCKED/);
  assert.deepEqual(await resolvePublicHost('1.1.1.1'),[{address:'1.1.1.1',family:4}]);
});

test('代理连接失败返回有限诊断，只保留主机及公开错误分类',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw Error('private upstream response');});
  const proxy=await startProxy();
  try{
    for(let i=0;i<10;i++)await new Promise<void>((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port:proxy.port,method:'CONNECT',path:`fixture${i}.example.com:443`});
      req.on('connect',(res,socket)=>{socket.destroy();assert.equal(res.statusCode,403);resolve();});req.on('error',reject);req.end();
    });
    const diagnostics=proxy.diagnostics!();assert.equal(diagnostics.length,8);
    assert.equal(diagnostics[0].host,'fixture2.example.com');assert.equal(diagnostics[7].code,'TUNNEL_SETUP_FAILED');
    assert.doesNotMatch(JSON.stringify(diagnostics),/private upstream response/);
  }finally{await proxy.close();}
});


test('DNS 仅重试一次传输重置；成功答案仍全量校验，拒绝项不重试',async t=>{
 const counts=new Map<string,number>();let mode='reset';
 t.mock.method(globalThis,'fetch',async(input:unknown)=>{
  const type=new URL(String(input)).searchParams.get('type')!;
  const n=(counts.get(type)??0)+1;counts.set(type,n);
  if(type==='A'&&(mode==='always'||mode==='reset'&&n===1))throw new TypeError('fetch failed',{cause:{code:'ECONNRESET'}});
  if(mode==='rejected')return new Response('',{status:403});
  return Response.json({Status:0,Answer:type==='A'?[{type:1,data:mode==='private'?'127.0.0.1':'1.1.1.1'}]:[]});
 });
 assert.equal((await resolvePublicHost('example.com'))[0].address,'1.1.1.1');assert.equal(counts.get('A'),2);
 counts.clear();mode='always';await assert.rejects(resolvePublicHost('example.com'),/DNS_TRANSPORT_FAILED/);assert.equal(counts.get('A'),2);
 counts.clear();mode='private';await assert.rejects(resolvePublicHost('example.com'),/PRIVATE_NETWORK_BLOCKED/);assert.equal(counts.get('A'),1);
 counts.clear();mode='rejected';await assert.rejects(resolvePublicHost('example.com'),/DNS_LOOKUP_FAILED/);assert.equal(counts.get('A'),1);
});
