import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvePublicHost} from '../apps/desktop/src/executor/proxy';

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
