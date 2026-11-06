import { app } from '../apps/cloud/src/index';
import { hash } from '../packages/contracts/src/security';
import type { AppEnv } from '../apps/cloud/src/env';
import { PROTOCOL_VERSION,type TaskRun,type RunResult } from '../packages/contracts/src/index';

async function runnerRequest(db:D1Database,run:TaskRun,path:string,body:unknown,deviceId:string) {
  const token=await hash('runner-test:'+deviceId);
  await db.prepare('INSERT INTO devices(id,name,token_hash,protocol_version) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash,protocol_version=excluded.protocol_version')
    .bind(deviceId,deviceId,await hash(token),PROTOCOL_VERSION).run();
  return app.request(`http://localhost/api/runner/runs/${run.id}/${path}`,{method:'POST',headers:{'Content-Type':'application/json','x-taskrelay-protocol':String(PROTOCOL_VERSION),Authorization:'Bearer '+token},body:JSON.stringify(body)},{DB:db,DEV_MODE:'1'} as AppEnv);
}

/** Exercise the authenticated production route, never a second finish implementation. */
export async function finishRequest(db:D1Database,run:TaskRun,status:'succeeded'|'failed'|'unknown'|'cancelled',result:RunResult,epoch=run.leaseEpoch,deviceId=run.deviceId!) {
  return runnerRequest(db,run,'finish',{epoch,status,result},deviceId);
}

/** 浏览器退出是独立事实，测试需要显式调用，不能让 finish helper 隐藏清理窗口。 */
export async function browserClosedRequest(db:D1Database,run:TaskRun,epoch=run.leaseEpoch,deviceId=run.deviceId!) {
  return runnerRequest(db,run,'browser-closed',{epoch},deviceId);
}
