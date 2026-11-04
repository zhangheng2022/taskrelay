import { DurableObject } from 'cloudflare:workers';
import type { AppEnv } from '../env';
import { executeTurn } from './conversations';
import { member } from '../tenancy';
import {notifyUser} from '../notifications';

export class AiTurn extends DurableObject<AppEnv> {
  async enqueue(id:string) {
    const prior=await this.ctx.storage.get<string>('id');
    if(prior&&prior!==id)throw new Error('TURN_CONFLICT');
    if(await this.ctx.storage.get<boolean>('started'))return;
    await this.ctx.storage.put('id',id);
    await this.ctx.storage.setAlarm(Date.now()+1);
  }
  async alarm() {
    const id=await this.ctx.storage.get<string>('id');
    if(!id)return;
    // Claim in D1 before any inference. Alarm retries cannot replay an uncertain call.
    const row=await this.env.DB.prepare("UPDATE ai_dispatch SET started=1 WHERE turn_id=? AND started=0 RETURNING thread_id,owner,mode").bind(id).first<{thread_id:string;owner:string;mode:'chat'|'report'}>();
    if(!row){await this.ctx.storage.deleteAll();return;}
    await this.ctx.storage.put('started',true);
    try{
      await member(this.env.DB,row.owner);
      await executeTurn({...this.env,requestUserId:row.owner},row.thread_id,id,row.mode);
    }catch{
      await this.env.DB.batch([
        this.env.DB.prepare("UPDATE ai_turns SET status='unknown',error='TURN_OUTCOME_UNKNOWN' WHERE id=? AND status='running'").bind(id),
        this.env.DB.prepare("UPDATE ai_threads SET active_turn=NULL WHERE id=? AND active_turn=?").bind(row.thread_id,id),
      ]);
    }
    await this.env.DB.prepare('DELETE FROM ai_dispatch WHERE turn_id=?').bind(id).run();
    await notifyUser(this.env,row.owner);
    await this.ctx.storage.deleteAll();
  }
}

export async function wakeTurns(env:AppEnv) {
  if(!env.AI_TURNS)return;
  const rows=await env.DB.prepare("SELECT d.turn_id FROM ai_dispatch d JOIN ai_turns t ON t.id=d.turn_id WHERE d.started=0 AND t.status='running' ORDER BY t.created_at LIMIT 10").all<{turn_id:string}>();
  for(const row of rows.results)await env.AI_TURNS.getByName(row.turn_id).enqueue(row.turn_id);
  await env.DB.prepare("DELETE FROM ai_dispatch WHERE turn_id IN(SELECT id FROM ai_turns WHERE status<>'running')").run();
}
