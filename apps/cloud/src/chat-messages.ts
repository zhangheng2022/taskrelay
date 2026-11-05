import type {AppEnv} from './env';
import {now,type Row} from './store';
import {seal,unseal} from './crypto';
import type {ChatPart} from '../../../packages/contracts/src/execution';
import {notifyUser} from './notifications';

interface ContextRow {
  id:string;seq:number;role:string;content:string;source:string;parts:string;
  reply_to:string|null;run_id:string|null;private_content:string|null;
  origin:string|null;
}

export async function runThread(env:AppEnv,runId:string){
  const row=await env.DB.prepare('SELECT t.* FROM ai_threads t JOIN runs r ON r.thread_id=t.id WHERE r.id=? AND t.user_id=r.user_id AND t.closed=0').bind(runId).first<Row>();
  if(!row)throw Error('THREAD_NOT_FOUND');return row;
}
export async function appendMessage(env:AppEnv,threadId:string,message:{id:string;role?:'user'|'assistant';source:'user'|'cloud'|'executor';content:string;parts?:ChatPart[];runId?:string;replyTo?:string;private?:boolean;at?:string}){
  const secret=message.private?await seal(message.content,env.MASTER_KEY,`message:${threadId}:${message.id}`):null;
  const insert=env.DB.prepare(`INSERT OR IGNORE INTO ai_messages(id,thread_id,seq,role,content,turn_id,at,source,parts,run_id,reply_to,private_content)
    SELECT ?,id,(SELECT COALESCE(MAX(seq),0)+1 FROM ai_messages WHERE thread_id=?),?,?,?,?,?,?,?,?,? FROM ai_threads WHERE id=? AND closed=0`)
    .bind(message.id,threadId,message.role??'assistant',secret?'[用户已提供私密信息]':message.content,message.id,message.at??now(),message.source,JSON.stringify(message.parts??[]),message.runId??null,message.replyTo??null,secret,threadId);
  await env.DB.batch([insert,...(message.role==='user'&&message.replyTo?[env.DB.prepare('UPDATE execution_help SET reply_message_id=? WHERE id=? AND thread_id=? AND reply_message_id IS NULL AND EXISTS(SELECT 1 FROM ai_messages WHERE id=? AND thread_id=?)').bind(message.id,message.replyTo,threadId,message.id,threadId)]:[])]);
  const t=await env.DB.prepare('SELECT user_id FROM ai_threads WHERE id=?').bind(threadId).first<{user_id:string}>();
  if(t)await notifyUser(env,t.user_id).catch(()=>{});
}
export async function conversationContext(env:AppEnv,threadId:string,after=0,options?:{runId:string}){
  // Only an owning task may opt into the user's encrypted conversation context.
  // Other readers retain placeholders; the user's history is decrypted by threadPage.
  if(options&&!await env.DB.prepare('SELECT r.id FROM runs r JOIN ai_threads t ON t.id=r.thread_id AND t.user_id=r.user_id WHERE r.id=? AND t.id=? AND t.closed=0').bind(options.runId,threadId).first())throw Error('THREAD_NOT_FOUND');
  const rows=await env.DB.prepare(`SELECT m.id,m.seq,m.role,m.content,m.source,m.parts,m.reply_to,m.run_id,m.private_content,
    (SELECT json_extract(h.request,'$.origin') FROM execution_help h WHERE h.thread_id=m.thread_id AND (h.id=m.reply_to OR h.id||'_request'=m.reply_to) LIMIT 1) AS origin
    FROM ai_messages m WHERE m.thread_id=? AND m.seq>? ORDER BY m.seq`).bind(threadId,after).all<ContextRow>();
  return Promise.all(rows.results.map(async ({private_content,...r})=>({...r,private:!!private_content,content:private_content?(options?await unseal<string>(private_content,env.MASTER_KEY,`message:${threadId}:${r.id}`):'[私密回复已提供，请通过协助通道使用]'):r.content,parts:JSON.parse(r.parts)})));
}
export async function privateReply(env:AppEnv,threadId:string,id:string){
  const m=await env.DB.prepare('SELECT private_content FROM ai_messages WHERE id=? AND thread_id=?').bind(id,threadId).first<{private_content:string}>();
  if(!m?.private_content)throw Error('REPLY_NOT_FOUND');
  return unseal<string>(m.private_content,env.MASTER_KEY,`message:${threadId}:${id}`);
}
