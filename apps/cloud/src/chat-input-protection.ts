/** 修复旧版在协助发布前收到的明文运行补充：终态后分批加密正文并清理助手回显。
 * 只处理同属用户与会话的运行消息，不撤回上下文、不删除历史、不触碰 MASTER_KEY。
 * 每条消息事务更新，全部完成后持久化标记；活动运行先等待收尾，避免执行器缓存与数据交错。
 */
import type {AppEnv} from './env';
import {seal} from './crypto';

const marker='chatInputProtectionBackfillV1';
function redactParts(parts:string,original:string){
 const variants=[original,JSON.stringify(original).slice(1,-1)].filter(Boolean).sort((a,b)=>b.length-a.length);
 const visit=(value:unknown):unknown=>{
  if(typeof value==='string')return variants.reduce((text,secret)=>text.split(secret).join('[已隐藏]'),value);
  if(Array.isArray(value))return value.map(visit);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visit(item)]));
  return value;
 };
 return JSON.stringify(visit(JSON.parse(parts)));
}

export async function protectLegacyRunInputs(env:AppEnv){
 if(await env.DB.prepare('SELECT key FROM settings WHERE key=?').bind(marker).first())return;
 const candidates=await env.DB.prepare(`SELECT m.id,m.thread_id,m.seq,m.content FROM ai_messages m
  JOIN runs r ON r.id=m.run_id JOIN ai_threads t ON t.id=m.thread_id AND t.user_id=r.user_id
  WHERE m.role='user' AND m.private_content IS NULL AND r.thread_id=m.thread_id
  AND r.status NOT IN ('queued','running','waiting_user','verifying') ORDER BY m.seq LIMIT 5`)
  .all<{id:string;thread_id:string;seq:number;content:string}>();
 for(const source of candidates.results){
  const encoded=await seal(source.content,env.MASTER_KEY,`message:${source.thread_id}:${source.id}`);
  const derived=await env.DB.prepare("SELECT id,content,private_content,parts FROM ai_messages WHERE thread_id=? AND role='assistant' AND seq>?")
   .bind(source.thread_id,source.seq)
   .all<{id:string;content:string;private_content:string|null;parts:string}>();
  const fence="EXISTS(SELECT 1 FROM ai_messages WHERE id=? AND private_content IS NULL AND content=?)";
  const writes=[];
  for(const message of derived.results){
   const parts=redactParts(message.parts,source.content);
   if(parts===message.parts&&(message.private_content||!message.content.includes(source.content)))continue;
   const secret=message.private_content??(message.content.includes(source.content)
    ?await seal(message.content,env.MASTER_KEY,`message:${source.thread_id}:${message.id}`):null);
   writes.push(env.DB.prepare(`UPDATE ai_messages SET content=?,private_content=?,parts=? WHERE id=? AND thread_id=? AND ${fence}`)
    .bind(secret?'[用户已提供私密信息]':message.content,secret,parts,message.id,source.thread_id,source.id,source.content));
  }
  writes.push(env.DB.prepare('UPDATE ai_messages SET content=?,private_content=? WHERE id=? AND thread_id=? AND private_content IS NULL AND content=?')
   .bind('[用户已提供私密信息]',encoded,source.id,source.thread_id,source.content));
  await env.DB.batch(writes);
 }
 // 包括仍在运行的旧消息，避免活动任务尚未结束就提前宣告迁移完成。
 await env.DB.prepare(`INSERT OR IGNORE INTO settings(key,value) SELECT ?,'done' WHERE NOT EXISTS(
  SELECT 1 FROM ai_messages m JOIN runs r ON r.id=m.run_id JOIN ai_threads t ON t.id=m.thread_id AND t.user_id=r.user_id
  WHERE m.role='user' AND m.private_content IS NULL AND r.thread_id=m.thread_id)`)
  .bind(marker).run();
}
