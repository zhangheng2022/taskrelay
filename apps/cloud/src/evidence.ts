import type { AppEnv } from './env';

export async function putEvidence(env:AppEnv,key:string,bytes:ArrayBuffer,expires:string|null){
  if(!env.EVIDENCE_STORE)throw new Error('EVIDENCE_NOT_CONFIGURED');
  await env.EVIDENCE_STORE.getByName(key).put(key,bytes,expires===null?null:Date.parse(expires));
}
export async function getEvidence(env:AppEnv,key:string){
  if(env.EVIDENCE_STORE)return env.EVIDENCE_STORE.getByName(key).get(key);
  // Only isolated legacy tests use an injected storage adapter.
  if(env.DEV_MODE==='1'&&env.EVIDENCE){const r=await env.EVIDENCE.get(key);return r?r.arrayBuffer?r.arrayBuffer():new Response(r.body).arrayBuffer():null;}
  return null;
}
export async function deleteEvidence(env:AppEnv,key:string){
  if(env.EVIDENCE_STORE)await env.EVIDENCE_STORE.getByName(key).remove();
  else if(env.DEV_MODE==='1'&&env.EVIDENCE)await env.EVIDENCE.delete(key);
  else throw new Error('EVIDENCE_NOT_CONFIGURED');
}
