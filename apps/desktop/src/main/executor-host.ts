import type { utilityProcess, UtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { limits, type TaskRun } from "../../../../packages/contracts/src/index";
import type { Cloud } from "./cloud";
import { Journal } from "./journal";
import { OwnedBrowser } from "./browser";
export class ExecutorHost {
  private child: UtilityProcess | null = null;
  private generation = "";
  private alive = 0;
  private stopping = false;
  private rpcChain = Promise.resolve();
  private rpcPending = 0;
  private current: TaskRun | null = null;
  private lastLease = 0;
  private stopPromise: Promise<void> | null = null;
  private exited = new WeakSet<UtilityProcess>();
  constructor(
    private cloud: Pick<Cloud, "request">,
    private journal: Journal,
    private browser: Pick<OwnedBrowser, "launch" | "close" | "recover">,
    private executorPath: string,
    private extensionPath: string,
    private notify: () => void,
    private fork: typeof utilityProcess.fork,
  ) {}
  get active() {
    return this.current?.id ?? null;
  }
  get idleForUpdate() {
    return !this.child && !this.current && !this.stopping && !this.stopPromise && this.rpcPending === 0;
  }
  async recover() {
    await this.browser.recover();
    for (const row of this.journal.incomplete()) {
      const payload = JSON.parse(row.payload);
      const uncertain =
        !!payload.writePending ||
        !!payload.mayHaveWritten ||
        row.state === "intent" ||
        row.state === "human-delivery" ||
        payload.status === "unknown";
      this.journal.queue(
        `finish_${row.run_id}`,
        `/api/runner/runs/${row.run_id}/finish`,
        {
          epoch: row.epoch,
          status: uncertain ? "unknown" : "failed",
          result: {
            summary: "执行器重启，已停止自动重放并等待核查。",
            outcome: uncertain ? "unconfirmed" : "error",
            evidence: [],
            errorCode: "EXECUTOR_RESTARTED",
          },
        },
      );
      this.journal.checkpoint(
        row.run_id,
        row.generation,
        row.epoch,
        "abandoned",
        { uncertain },
      );
    }
  }
  async flush() {
    for (const row of this.journal.pending()) {
      try {
        await this.cloud.request("POST", row.path, JSON.parse(row.body));
        this.journal.remove(row.id);
      } catch (e) {
        if (
          ["LEASE_EXPIRED", "CANCEL_REQUESTED", "RUN_NOT_FOUND", "INSTRUCTIONS_PENDING", "INSTRUCTIONS_CHANGED"].includes(
            (e as Error).message,
          )
        )
          this.journal.remove(row.id);
        else throw e;
      }
    }
  }
  async start(run: TaskRun) {
    if (this.child || this.current || this.stopping)
      throw new Error("EXECUTOR_BUSY");
    this.current = run;
    this.generation = randomUUID();
    const gen = this.generation;
    this.alive = Date.now();
    this.lastLease = new Date(run.leaseExpiresAt!).getTime();
    this.journal.checkpoint(run.id, gen, run.leaseEpoch, "claimed", { run });
    const child = this.fork(this.executorPath, [], {
      serviceName: "TaskRelay Executor",
      stdio: "ignore",
    });
    this.child = child;
    const exit = new Promise<void>((resolve) =>
      child.once("exit", () => {
        this.exited.add(child);
        resolve();
      }),
    );
    child.on("message", (message) => {
      if (message?.generation !== gen || this.child !== child || this.stopping) return;
      if (message.type === "alive") {
        this.alive = Date.now();
        return;
      }
      if (message.type === "done" || message.type === "fatal") {
        void this.stop(false);
        return;
      }
      if (message.type !== "rpc") return;
      this.rpcPending++;
      this.rpcChain = this.rpcChain
        .then(async () => {
          if (this.child !== child || this.generation !== gen || this.stopping) return;
          try {
            const data = await this.handle(
              run,
              gen,
              message.path,
              message.body,
              message.binary,
            );
            if (this.child === child && this.generation === gen && !this.stopping)
              child.postMessage({
                generation: gen,
                type: "reply",
                id: message.id,
                data,
              });
          } catch (e) {
            if (this.child === child && this.generation === gen && !this.stopping)
              child.postMessage({
                generation: gen,
                type: "reply",
                id: message.id,
                error: (e as Error).message,
              });
          }
        })
        .catch(() => {})
        .finally(() => { this.rpcPending--; });
    });
    child.postMessage({
      type: "start",
      generation: gen,
      run,
      extensionPath: this.extensionPath,
    });
    const heartbeat = setInterval(() => {void this.refreshControl().catch(()=>{});}, limits.heartbeatMs);
    void exit
      .then(async () => {
        clearInterval(heartbeat);
        if (this.child === child && !this.stopping) {
          this.stopping = true;
          try {
            await this.browser.close();
            this.retire(run, gen, false);
            this.child = null;
            this.current = null;
            this.stopping = false;
            this.notify();
          } catch {
            // Keep ownership and block new work until cleanup can be retried.
            this.notify();
          }
        }
      })
      .catch(() => {
        this.stopping = true;
        this.notify();
      });
    this.notify();
  }
  async refreshControl() {
    const child=this.child,run=this.current,gen=this.generation;
    if(!child||!run||this.stopping)return;
    if(Date.now()-this.alive>25000||Date.now()>this.lastLease-5000){await this.stop(true);return;}
    try{
      const result=await this.cloud.request<{leaseExpiresAt:string;cancelRequested:boolean}>('POST',`/api/runner/runs/${run.id}/heartbeat`,{epoch:run.leaseEpoch});
      if(this.child!==child||this.generation!==gen||this.stopping)return;
      this.lastLease=new Date(result.leaseExpiresAt).getTime();
      if(result.cancelRequested)await this.stop(false);
    }catch(error){
      if(this.child!==child||this.generation!==gen||this.stopping)return;
      if(['LEASE_EXPIRED','DEVICE_UNAUTHORIZED'].includes((error as Error).message))await this.stop(true);
    }
  }
  private async handle(
    run: TaskRun,
    gen: string,
    p: string,
    body: any,
    binary?: Uint8Array,
  ) {
    if (p === "local:browser") {
      const b = z
        .object({ accountId: z.string(), proxyPort: z.number().int() })
        .parse(body);
      if (b.accountId !== run.profileId)
        throw new Error("PROFILE_MISMATCH");
      return this.browser.launch(b.accountId, b.proxyPort);
    }
    if (p === "local:close-browser") {
      await this.browser.close();
      return { ok: true };
    }
    if (p === "local:checkpoint") {
      const b = z
        .object({
          state: z.enum([
            "starting",
            "intent",
            "observed",
            "human-delivery",
            "finishing",
            "finished",
          ]),
          payload: z.unknown(),
        })
        .parse(body);
      this.journal.checkpoint(run.id, gen, run.leaseEpoch, b.state, b.payload);
      return { ok: true };
    }
    if (
      !p.startsWith(`/api/runner/runs/${run.id}/`) ||
      p.includes("..") ||
      body?.epoch !== run.leaseEpoch
    )
      throw new Error("RUN_SCOPE_MISMATCH");
    if (/\/(events|finish)$/.test(p)) {
      const key = p.endsWith("/finish")
        ? `finish_${run.id}`
        : `events_${body.events?.[0]?.id}`;
      this.journal.queue(key, p, body);
      try {
        const result = await this.cloud.request("POST", p, body);
        this.journal.remove(key);
        return result;
      } catch (error) {
        // A definitive control-fence rejection is not an uncertain network result.
        if (['INSTRUCTIONS_PENDING','INSTRUCTIONS_CHANGED'].includes((error as Error).message)) this.journal.remove(key);
        throw error;
      }
    }
    return this.cloud.request("POST", p, body, false, binary);
  }
  private retire(run: TaskRun, gen: string, cancelled: boolean) {
    const row = this.journal
      .incomplete()
      .find((x) => x.run_id === run.id && x.generation === gen);
    if (!row) return;
    const payload = JSON.parse(row.payload),
      uncertain =
        !!payload.writePending ||
        !!payload.mayHaveWritten ||
        row.state === "intent" ||
        row.state === "human-delivery" ||
        payload.status === "unknown";
    // Preserve a previously queued terminal fact. Never replace it with a fabricated success.
    this.journal.queue(
      `finish_${run.id}`,
      `/api/runner/runs/${run.id}/finish`,
      {
        epoch: run.leaseEpoch,
        status: uncertain ? "unknown" : cancelled ? "cancelled" : "failed",
        result: {
          summary: uncertain
            ? "本机已停止，操作结果需要只读核查。"
            : "执行进程已停止。",
          outcome: uncertain ? "unconfirmed" : cancelled ? "stopped" : "error",
          evidence: [],
          errorCode: cancelled ? "CANCEL_REQUESTED" : "EXECUTOR_EXITED",
        },
      },
    );
    this.journal.checkpoint(run.id, gen, run.leaseEpoch, "abandoned", {
      uncertain,
    });
  }
  stop(requestCancel = true): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.child) return Promise.resolve();
    this.stopping = true;
    const child = this.child,
      run = this.current!,
      gen = this.generation;
    this.stopPromise = (async () => {
      child.postMessage({ type: "cancel", generation: gen });
      // Offline stopping must not wait for a network request. Stop effects before reporting.
      await this.browser.close();
      if (!this.exited.has(child)) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const exited = new Promise<void>((resolve, reject) => {
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          timer = setTimeout(
            () => reject(new Error("EXECUTOR_EXIT_TIMEOUT")),
            10000,
          );
        });
        if (!child.kill() && !this.exited.has(child)) {
          clearTimeout(timer);
          throw new Error("EXECUTOR_KILL_FAILED");
        }
        if (this.exited.has(child)) clearTimeout(timer);
        else await exited;
      }
      this.retire(run, gen, requestCancel);
      this.child = null;
      this.current = null;
      this.stopping = false;
      this.notify();
    })().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }
}
