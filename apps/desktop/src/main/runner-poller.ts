import { PROTOCOL_VERSION } from "../../../../packages/contracts/src/index";
import type { Cloud } from "./cloud";
import type { ExecutorHost } from "./executor-host";
import type { Journal } from "./journal";
import type { TaskRun } from "../../../../packages/contracts/src/index";

// Owns in-flight claims, including a response lost after the cloud granted a lease.
export class RunnerPoller {
  private polling = false;
  private claiming: Promise<void> | null = null;
  private claimRequest: string | null;
  constructor(
    private cloud: Pick<Cloud, "paired" | "connect" | "request">,
    private host: Pick<ExecutorHost, "active" | "start" | "flush" | "abandonClaim"> &
      Partial<Pick<ExecutorHost, "idleForUpdate">>,
    private journal: Pick<Journal, "get" | "set">,
    private controls: {
      quitting: () => boolean;
      blocksClaims: () => boolean;
      installing: () => boolean;
      result: (online: boolean, error: string | null) => void;
      settled: () => void;
    },
  ) {
    this.claimRequest = journal.get<string>("claimRequest");
  }
  get unsettled() {
    return this.polling || !!this.claimRequest;
  }
  async waitForClaim() {
    // 失败仍保留送出前写入的请求 ID，退出不必依赖网络成功。
    await this.claiming?.catch(() => {});
  }
  async poll() {
    if (
      this.polling ||
      this.controls.quitting() ||
      !this.cloud.paired ||
      this.controls.installing()
    )
      return;
    this.polling = true;
    try {
      const connection = await this.cloud.connect(!this.host.active);
      if (connection.maintenance) {
        this.controls.result(true, "云端维护中，暂不领取任务");
        return;
      }
      await this.host.flush();
      await this.cloud.request("POST", "/api/device/readiness", {
        ready:
          !this.controls.quitting() &&
          !this.host.active &&
          this.host.idleForUpdate !== false &&
          !this.journal.get<boolean>("paused") &&
          !this.controls.blocksClaims(),
      });
      // Recheck after awaits. An existing claim must be resolved even when paused/draining.
      if (
        !this.controls.quitting() &&
        !this.host.active &&
        this.host.idleForUpdate !== false &&
        (this.claimRequest ||
          (!this.journal.get<boolean>("paused") && !this.controls.blocksClaims()))
      ) {
        this.claiming = this.claim();
        await this.claiming;
      }
      this.controls.result(true, null);
    } catch (e) {
      this.controls.result(false, (e as Error).message);
    } finally {
      this.claiming = null;
      this.polling = false;
      this.controls.settled();
    }
  }
  private async claim() {
    this.claimRequest ??= crypto.randomUUID();
    this.journal.set("claimRequest", this.claimRequest);
    const { run } = await this.cloud.request<{ run: TaskRun | null }>("POST", "/api/runner/claim", {
      requestId: this.claimRequest,
      protocolVersion: PROTOCOL_VERSION,
      supportsScheduling: true,
    });
    if (run && ["running", "waiting_user", "verifying"].includes(run.status)) {
      if (this.controls.quitting()) this.host.abandonClaim(run);
      else await this.host.start(run);
    }
    this.journal.set("claimRequest", null);
    this.claimRequest = null;
  }
}
