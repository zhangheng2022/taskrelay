import type { AppEnv } from './env';
const limits={model:100,turn:50,evidence:100};
export async function platformBudget(env: AppEnv) {
  const day=new Date().toISOString().slice(0,10);
  const rows=await env.DB.prepare('SELECT kind,n FROM platform_budget WHERE day=?').bind(day).all<{kind:keyof typeof limits;n:number}>();
  return {limits,used:Object.assign({model:0,turn:0,evidence:0},Object.fromEntries(rows.results.map(r=>[r.kind,r.n]))),resetAt:new Date(Date.parse(day)+86400000).toISOString()};
}
/** Conservative project admission budgets, not a replica of account billing. */
export async function admit(env:AppEnv,kind:keyof typeof limits) {
  const day=new Date().toISOString().slice(0,10);
  const r=await env.DB.prepare('INSERT INTO platform_budget(day,kind,n) VALUES(?,?,1) ON CONFLICT(day,kind) DO UPDATE SET n=n+1 WHERE n<?').bind(day,kind,limits[kind]).run();
  if(!r.meta.changes)throw new Error('PLATFORM_DAILY_LIMIT');
}
