import type { Cloud } from './cloud';
import type { ExecutorHost } from './executor-host';
import type { Journal } from './journal';
import type { TaskRun } from '../../../../packages/contracts/src/index';

// Owns in-flight claims, including a response lost after the cloud granted a lease.
export class RunnerPoller {
  private polling=false;
  private claimRequest:string|null;
  constructor(private cloud:Pick<Cloud,'paired'|'connect'|'request'>,
    private host:Pick<ExecutorHost,'active'|'start'|'flush'>,
    private journal:Pick<Journal,'get'|'set'>,
    private controls:{quitting:()=>boolean;blocksClaims:()=>boolean;installing:()=>boolean;
      result:(online:boolean,error:string|null)=>void;settled:()=>void}) {
    this.claimRequest=journal.get<string>('claimRequest');
  }
  get unsettled() {return this.polling || !!this.claimRequest;}
  async poll() {
    if(this.polling || this.controls.quitting() || !this.cloud.paired || this.controls.installing())return;
    this.polling=true;
    try {
      const connection=await this.cloud.connect(!this.host.active);
      if(connection.maintenance){this.controls.result(true,'云端维护中，暂不领取任务');return;}
      await this.host.flush();
      // Recheck after awaits. An existing claim must be resolved even when paused/draining.
      if(!this.controls.quitting() && !this.host.active &&
        (this.claimRequest || (!this.journal.get<boolean>('paused') && !this.controls.blocksClaims()))) {
        this.claimRequest ??= crypto.randomUUID();
        this.journal.set('claimRequest',this.claimRequest);
        const {run}=await this.cloud.request<{run:TaskRun|null}>('POST','/api/runner/claim',{
          requestId:this.claimRequest,protocolVersion:14,
        });
        if(run && ['running','waiting_user','verifying'].includes(run.status))await this.host.start(run);
        this.claimRequest=null;this.journal.set('claimRequest',null);
      }
      this.controls.result(true,null);
    } catch(e) {this.controls.result(false,(e as Error).message);}
    finally {this.polling=false;this.controls.settled();}
  }
}
