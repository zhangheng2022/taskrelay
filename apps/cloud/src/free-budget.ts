import type { AppEnv } from './env';
const limits={model:100,turn:50,evidence:100};
/** Conservative project admission budgets, not a replica of account billing. */
export async function admit(env:AppEnv,kind:keyof typeof limits) {
  const day=new Date().toISOString().slice(0,10);
  const r=await env.DB.prepare('INSERT INTO platform_budget(day,kind,n) VALUES(?,?,1) ON CONFLICT(day,kind) DO UPDATE SET n=n+1 WHERE n<?').bind(day,kind,limits[kind]).run();
  if(!r.meta.changes)throw new Error('PLATFORM_DAILY_LIMIT');
}
