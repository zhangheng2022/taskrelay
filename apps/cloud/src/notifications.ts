import type { AppEnv } from './env';
export async function notifyUser(env:AppEnv,id:string){if(env.NOTIFICATIONS)await env.NOTIFICATIONS.getByName('user:'+id).publish().catch(()=>{});}
export async function notifyDevices(env:AppEnv){
  if(!env.NOTIFICATIONS)return;
  const devices=await env.DB.prepare('SELECT id FROM devices WHERE revoked=0 LIMIT 20').all<{id:string}>();
  await Promise.all(devices.results.map(d=>env.NOTIFICATIONS.getByName('device:'+d.id).publish().catch(()=>{})));
}
