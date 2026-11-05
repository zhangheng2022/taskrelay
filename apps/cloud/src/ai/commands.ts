import { z } from 'zod';
import type { AppEnv } from '../env';
import { enqueue, now, taskFrom, type Row } from '../store';
import { getModelProfile } from '../models';
import { hash, publicUrl } from '../../../../packages/contracts/src/security';
import { nextOccurrence } from '../../../../packages/contracts/src/schedule';
import { taskInputSchema, type TaskDefinition } from '../../../../packages/contracts/src/index';

export const decisionSchema = z.object({
  reply: z.string().min(1).max(4000),
  operation: z.enum(['respond','start','revise','schedule','pause','resume','stop']),
  scope: z.enum(['current','future']),
  startWhen: z.enum(['now','scheduled']),
  task: taskInputSchema.omit({modelId:true}).nullable(),
});
export type Decision = z.infer<typeof decisionSchema>;
export const conditionsSchema = z.object({
  goal: z.string().min(1).max(2000), scope: z.string().min(1).max(2000),
  prerequisites: z.array(z.string().max(500)).max(10),
  completion: z.string().min(1).max(2000), assistance: z.array(z.string().max(500)).max(10),
});

/** A pending user message is a control fence, not a business verification rule. */
export async function instructionFence(env:AppEnv, runId:string, version?:number) {
  const row=await env.DB.prepare(`SELECT instruction_version,
    EXISTS(SELECT 1 FROM conversation_inbox i JOIN ai_threads t ON t.id=i.thread_id
      WHERE t.task_id=r.task_id AND t.closed=0 AND i.mode='chat' AND i.status IN ('pending','processing')) pending
    FROM runs r WHERE id=?`).bind(runId).first<{instruction_version:number;pending:number}>();
  if(!row)throw Error('RUN_NOT_FOUND');
  if(row.pending)throw Error('INSTRUCTIONS_PENDING');
  if(version!==undefined&&version!==row.instruction_version)throw Error('INSTRUCTIONS_CHANGED');
  return row.instruction_version;
}

/** Persist effects together; enqueue is an idempotent outbox drain after commit. */
export async function commitDecision(env:AppEnv,t:Row,turnId:string,d:Decision) {
  const prior=await env.DB.prepare('SELECT id FROM conversation_commands WHERE id=?').bind(turnId).first();
  if(prior){await drainCommands(env,turnId);return;}
  const existing=t.task_id?await env.DB.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').bind(t.task_id,t.user_id).first<Row>():null;
  const base=existing?taskFrom(existing):null;
  const active=base?await env.DB.prepare("SELECT * FROM runs WHERE task_id=? AND status IN ('queued','running','waiting_user','verifying','unknown') ORDER BY created_at DESC LIMIT 1").bind(base.id).first<Row>():null;
  if(d.operation==='start'&&active)throw Error('RUN_ALREADY_ACTIVE');
  if(d.operation!=='respond'&&d.operation!=='start'&&!base)throw Error('TASK_REQUIRED');
  let definition:TaskDefinition|null=null;
  const needsTask=['start','revise','schedule'].includes(d.operation);
  if(needsTask){
    if(!d.task)throw Error('TASK_REQUIRED');
    const input=taskInputSchema.parse({...d.task,modelId:t.model_id});
    publicUrl(input.entryUrl);
    nextOccurrence(input.schedule);
    const {profile}=await getModelProfile(env,t.model_id,t.model_version);
    if(!profile.capabilities.connection||!profile.capabilities.tools||profile.capabilities.structured==='none')throw Error('MODEL_CAPABILITIES_REQUIRED');
    if(input.accountId){
      const account=await env.DB.prepare('SELECT origin FROM accounts WHERE id=? AND user_id=?').bind(input.accountId,t.user_id).first<{origin:string}>();
      if(!account||account.origin!==publicUrl(input.entryUrl).origin)throw Error('ACCOUNT_ORIGIN_MISMATCH');
    }
    if(d.operation==='revise'&&d.scope==='current'&&active&&input.accountId!==JSON.parse(active.task_snapshot).accountId)throw Error('RUN_ACCOUNT_CHANGE_REQUIRES_NEW_RUN');
    definition={...input,id:base?.id??`task_${(await hash(turnId)).slice(0,40)}`,version:base?base.version+1:1,modelVersion:t.model_version,
      status:d.operation==='schedule'||d.startWhen==='scheduled'?'active':'pending_validation',createdAt:base?.createdAt??now(),nextRunAt:null};
    if(d.operation==='schedule'&&base){
      // Scheduling cannot silently replace the business objective.
      definition={...base,schedule:input.schedule,status:'needs_input',nextRunAt:null,confirmedCondition:null};
    }
    if(d.operation==='revise'&&d.scope==='future')definition.confirmedCondition=null;
    if(definition.status==='active')definition.nextRunAt=nextOccurrence(definition.schedule);
  }
  const id=definition?.id??base?.id??null;
  const start=d.operation==='start'&&d.startWhen==='now';
  const statements:D1PreparedStatement[]=[env.DB.prepare(`INSERT OR IGNORE INTO conversation_commands(id,thread_id,task_id,run_task,created_at)
    SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ai_threads WHERE id=? AND active_turn=? AND version=? AND closed=0)`)
    .bind(turnId,t.id,id,start?JSON.stringify(definition):null,now(),t.id,turnId,t.version)];
  const fence="EXISTS(SELECT 1 FROM conversation_commands WHERE id=? AND state='pending')";
  if(definition&&(!base||d.operation==='start'||d.operation==='schedule'||(d.operation==='revise'&&d.scope==='future'))){
    statements.push(env.DB.prepare(`INSERT INTO tasks(id,version,definition,status,next_run_at,created_at,updated_at,user_id)
      SELECT ?,?,?,?,?,?,?,? WHERE ${fence} ON CONFLICT(id) DO UPDATE SET version=excluded.version,definition=excluded.definition,status=excluded.status,next_run_at=excluded.next_run_at,confirmed_condition=NULL,updated_at=excluded.updated_at`)
      .bind(definition.id,definition.version,JSON.stringify(definition),definition.status,definition.nextRunAt,definition.createdAt,now(),t.user_id,turnId),
      env.DB.prepare(`INSERT OR IGNORE INTO task_versions(task_id,version,definition) SELECT ?,?,? WHERE ${fence}`).bind(definition.id,definition.version,JSON.stringify(definition),turnId),
      env.DB.prepare(`UPDATE ai_threads SET task_id=? WHERE id=? AND ${fence}`).bind(definition.id,t.id,turnId));
    if(d.operation==='start'&&base?.confirmedCondition)statements.push(env.DB.prepare(`UPDATE tasks SET confirmed_condition=? WHERE id=? AND ${fence}`).bind(base.confirmedCondition,base.id,turnId));
  }
  if(d.operation==='revise'&&d.scope==='current'){
    if(!active||active.status==='unknown')throw Error('NO_ACTIVE_RUN');
    const revised={...definition!,version:JSON.parse(active.task_snapshot).version,status:JSON.parse(active.task_snapshot).status};
    statements.push(env.DB.prepare(`UPDATE runs SET task_snapshot=?,instruction_version=instruction_version+1,updated_at=? WHERE id=? AND ${fence}`)
      .bind(JSON.stringify(revised),now(),active.id,turnId));
    statements.push(env.DB.prepare(`UPDATE challenges SET status='expired',secret=NULL WHERE run_id=? AND status IN ('pending','answered') AND ${fence}`).bind(active.id,turnId),
      env.DB.prepare(`UPDATE runs SET status='running' WHERE id=? AND status='waiting_user' AND NOT EXISTS(SELECT 1 FROM challenges WHERE run_id=? AND status='consuming') AND ${fence}`).bind(active.id,active.id,turnId));
  }
  if(d.operation==='resume'&&!base?.confirmedCondition)throw Error('CONDITIONS_CONFIRMATION_REQUIRED');
  if(['pause','resume'].includes(d.operation))statements.push(env.DB.prepare(`UPDATE tasks SET status=?,next_run_at=?,updated_at=? WHERE id=? AND ${fence}`)
    .bind(d.operation==='pause'?'paused':'active',d.operation==='pause'?null:nextOccurrence(base!.schedule),now(),id,turnId));
  if(d.operation==='stop'&&active)statements.push(env.DB.prepare(`UPDATE runs SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END WHERE id=? AND ${fence}`).bind(active.id,turnId));
  statements.push(env.DB.prepare("UPDATE conversation_commands SET state='committed' WHERE id=? AND state='pending'").bind(turnId));
  await env.DB.batch(statements);
  if(!await env.DB.prepare('SELECT id FROM conversation_commands WHERE id=?').bind(turnId).first())throw Error('TURN_STALE');
  await drainCommands(env,turnId);
}

export async function drainCommands(env:AppEnv,id?:string) {
  const rows=await env.DB.prepare("SELECT * FROM conversation_commands WHERE state='committed'"+(id?' AND id=?':'')+' LIMIT 20').bind(...(id?[id]:[])).all<Row>();
  for(const row of rows.results){
    if(row.run_task)await enqueue(env.DB,JSON.parse(row.run_task),`manual:conversation:${row.id}`);
    await env.DB.prepare("UPDATE conversation_commands SET state='done' WHERE id=? AND state='committed'").bind(row.id).run();
  }
}
