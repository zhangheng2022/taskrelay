/** API 身份入口：公开认证/配对、设备令牌和用户会话分别校验；路由分片不授予权限。 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv,Variables } from './env';
import { hash } from '../../../packages/contracts/src/security';
import { PROTOCOL_VERSION } from '../../../packages/contracts/src/index';
import { ensureMember,identity } from './identity';
import { legacyOwner,member } from './tenancy';
export const auth:MiddlewareHandler<{Bindings:AppEnv;Variables:Variables}>=async(c,next)=>{
 const path=c.req.path;
 if(path==='/api/health'||path.startsWith('/api/auth/')||path.startsWith('/api/pair/')) return next();
 if(path.startsWith('/api/device/user')) return c.json({error:'DEVICE_SCOPE_REJECTED'},403);
 if(path.startsWith('/api/runner/')||path.startsWith('/api/device/')) {
   const token=c.req.header('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
   if(!token) return c.json({error:'DEVICE_UNAUTHORIZED'},401);
   const d=await c.env.DB.prepare('SELECT id,protocol_version FROM devices WHERE token_hash=? AND revoked=0').bind(await hash(token)).first<{id:string;protocol_version:number}>();
   if(!d) return c.json({error:'DEVICE_UNAUTHORIZED'},401);
   if(c.req.header('x-taskrelay-protocol')!==String(PROTOCOL_VERSION))return c.json({error:'CLIENT_UPGRADE_REQUIRED'},409);
   if(d.protocol_version!==PROTOCOL_VERSION&&c.req.path!=='/api/device/upgrade')return c.json({error:'DEVICE_UPGRADE_REQUIRED'},409);
   c.set('deviceId',d.id);c.set('actor','device');
   await c.env.DB.prepare('UPDATE devices SET last_seen=? WHERE id=? AND (last_seen IS NULL OR last_seen<?)').bind(new Date().toISOString(),d.id,new Date(Date.now()-60000).toISOString()).run();
   return next();
 }
 if(c.req.header('authorization')) return c.json({error:'DEVICE_SCOPE_REJECTED'},403);
 let m;
 if(c.env.DEV_MODE==='1'&&['localhost','127.0.0.1'].includes(new URL(c.req.url).hostname)) m=await member(c.env.DB,legacyOwner);
 else {
   if(!c.req.header('cookie')) return c.json({error:'AUTH_REQUIRED'},401);
   const s=await identity(c.env).api.getSession({headers:c.req.raw.headers});
   if(!s) return c.json({error:'AUTH_REQUIRED'},401);
   c.set('sessionId',s.session.id);
   m=await ensureMember(c.env,s.user);
 }
 c.set('member',m);c.set('userId',m.id);c.set('actor',m.role==='admin'?'owner':'user');
 c.env={...c.env,requestUserId:m.id};
 if(path.startsWith('/api/admin/')&&m.role!=='admin') return c.json({error:'ADMIN_REQUIRED'},403);
 return next();
};
