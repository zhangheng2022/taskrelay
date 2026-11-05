import { app } from '../apps/cloud/src/index';
import { hash } from '../packages/contracts/src/security';
import type { AppEnv } from '../apps/cloud/src/env';
import type { TaskRun, RunResult } from '../packages/contracts/src/index';

/** Exercise the authenticated production route, never a second finish implementation. */
export async function finishRequest(db:D1Database,run:TaskRun,status:'succeeded'|'failed'|'unknown'|'cancelled',result:RunResult,epoch=run.leaseEpoch,deviceId=run.deviceId!) {
  const token=await hash('runner-test:'+deviceId);
  await db.prepare('INSERT INTO devices(id,name,token_hash,protocol_version) VALUES(?,?,?,15) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash,protocol_version=15')
    .bind(deviceId,deviceId,await hash(token)).run();
  return app.request(`http://localhost/api/runner/runs/${run.id}/finish`,{method:'POST',headers:{'Content-Type':'application/json','x-taskrelay-protocol':'15',Authorization:'Bearer '+token},body:JSON.stringify({epoch,status,result})},{DB:db,DEV_MODE:'1'} as AppEnv);
}
