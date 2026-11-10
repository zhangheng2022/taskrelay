import type { utilityProcess, UtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { limits, type TaskRun } from "../../../../packages/contracts/src/index";
import type { Cloud } from "./cloud";
import { Journal } from "./journal";
import { OwnedBrowser } from "./browser";
import { BrowserStateAdapter } from "./browser-state";
import type { ProtectedStateFiles } from "./protected-state";
import {
  BROWSER_STATE_MAX_BYTES,
  type BrowserStateAccess,
} from "../../../../packages/contracts/src/accounts";
/** 管理单个执行子进程及其 generation，将串行 RPC、租约心跳和本地恢复记录接到 Main。
 * 子进程退出后先收回自有浏览器，再根据 journal/outbox 收尾；不恢复浏览器操作。
 */
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
  private stateAdapter: BrowserStateAdapter | null = null;
  private stateAccess: BrowserStateAccess | null = null;
  constructor(
    private cloud: Pick<Cloud, "request">,
    private journal: Journal,
    private browser: Pick<OwnedBrowser, "launch" | "close" | "recover">,
    private executorPath: string,
    private extensionPath: string,
    private notify: () => void,
    private fork: typeof utilityProcess.fork,
    private protectedStates?: ProtectedStateFiles,
  ) {}
  get active() {
    return this.current?.id ?? null;
  }
  get idleForUpdate() {
    return (
      !this.child && !this.current && !this.stopping && !this.stopPromise && this.rpcPending === 0
    );
  }
  async recover() {
    await this.browser.recover();
    await this.protectedStates?.recover();
    for (const row of this.journal.incomplete()) {
      const payload = JSON.parse(row.payload);
      const uncertain =
        !!payload.writePending ||
        !!payload.mayHaveWritten ||
        row.state === "intent" ||
        row.state === "human-delivery" ||
        payload.status === "unknown";
      this.journal.queue(`finish_${row.run_id}`, `/api/runner/runs/${row.run_id}/finish`, {
        epoch: row.epoch,
        status: uncertain ? "unknown" : "failed",
        result: {
          summary: "执行器重启，已停止自动重放并等待核查。",
          outcome: uncertain ? "unconfirmed" : "error",
          evidence: [],
          errorCode: "EXECUTOR_RESTARTED",
        },
      });
      this.journal.checkpoint(row.run_id, row.generation, row.epoch, "abandoned", {
        uncertain,
        timing: payload.timing,
      });
      if (payload.run?.cleanupPending)
        this.queueCleanup(row.run_id, row.epoch, payload.run.profileId);
    }
    const cleanup = this.journal.get<{ runId: string; epoch: number; profileId: string }>(
      "browserCleanup",
    );
    if (cleanup) {
      this.queueCleanup(cleanup.runId, cleanup.epoch, cleanup.profileId);
      this.journal.set("browserCleanup", null);
    }
  }
  async flush() {
    for (const row of this.journal.pending()) {
      try {
        const queued = JSON.parse(row.body);
        if (row.path.endsWith("/execution-record") && !this.protectedStates)
          throw Error("OS_ENCRYPTION_UNAVAILABLE");
        const body = row.path.endsWith("/execution-record")
          ? (this.protectedStates!.decrypt(queued.encryptedRecord) as Record<string, unknown>)
          : queued;
        const result = await this.cloud.request<{ synced?: boolean; revision?: number }>(
          "POST",
          row.path,
          body,
        );
        if (row.path.endsWith("/browser-closed") && result?.synced) {
          const marker = this.journal.get<Record<string, unknown>>(
            `profileState:${body.profileId}`,
          );
          if (marker && marker.runId === body.runId)
            this.journal.set(`profileState:${body.profileId}`, {
              ...marker,
              revision: result.revision,
              dirty: false,
            });
        }
        this.journal.remove(row.id);
      } catch (e) {
        if (
          [
            "LEASE_EXPIRED",
            "CANCEL_REQUESTED",
            "RUN_NOT_FOUND",
            "INSTRUCTIONS_PENDING",
            "INSTRUCTIONS_CHANGED",
          ].includes((e as Error).message)
        )
          this.journal.remove(row.id);
        else throw e;
      }
    }
  }
  async start(run: TaskRun) {
    if (this.child || this.current || this.stopping) throw new Error("EXECUTOR_BUSY");
    this.current = run;
    this.generation = randomUUID();
    const gen = this.generation;
    this.alive = Date.now();
    this.lastLease = new Date(run.leaseExpiresAt!).getTime();
    this.journal.checkpoint(run.id, gen, run.leaseEpoch, "claimed", { run });
    if (run.cleanupPending)
      this.journal.set("browserCleanup", {
        runId: run.id,
        epoch: run.leaseEpoch,
        profileId: run.profileId,
      });
    let child: UtilityProcess;
    try {
      child = this.fork(this.executorPath, [], {
        serviceName: "TaskRelay Executor",
        stdio: "ignore",
      });
    } catch (error) {
      // fork 尚未返回也已持有云端租约；沿同一收尾路径保存失败事实，
      // 清理或持久化失败时保留 current，允许 stop 再次完成收尾。
      await this.stop(false);
      throw error;
    }
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
        void this.stop(false, message.type === "done").catch(() => {
          // 关闭失败继续持有账号与浏览器所有权，界面保留停止入口供重试。
          this.notify();
        });
        return;
      }
      if (message.type !== "rpc") return;
      this.rpcPending++;
      this.rpcChain = this.rpcChain
        .then(async () => {
          if (this.child !== child || this.generation !== gen || this.stopping) return;
          try {
            const data = await this.handle(run, gen, message.path, message.body, message.binary);
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
        .finally(() => {
          this.rpcPending--;
        });
    });
    child.postMessage({
      type: "start",
      generation: gen,
      run,
      extensionPath: this.extensionPath,
    });
    const heartbeat = setInterval(() => {
      void this.refreshControl().catch(() => {});
    }, limits.heartbeatMs);
    void exit
      .then(async () => {
        clearInterval(heartbeat);
        if (this.child === child && !this.stopping) {
          this.stopping = true;
          try {
            await this.browser.close();
            await this.stateAdapter?.close();
            this.stateAdapter = null;
            this.retire(run, gen, false);
            this.closed(run);
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
    const child = this.child,
      run = this.current,
      gen = this.generation;
    if (!child || !run || this.stopping) return;
    if (Date.now() - this.alive > 25000 || Date.now() > this.lastLease - 5000) {
      await this.stop(true);
      return;
    }
    try {
      const result = await this.cloud.request<{ leaseExpiresAt: string; cancelRequested: boolean }>(
        "POST",
        `/api/runner/runs/${run.id}/heartbeat`,
        { epoch: run.leaseEpoch },
      );
      if (this.child !== child || this.generation !== gen || this.stopping) return;
      this.lastLease = new Date(result.leaseExpiresAt).getTime();
      if (result.cancelRequested) await this.stop(false);
    } catch (error) {
      if (this.child !== child || this.generation !== gen || this.stopping) return;
      if (["LEASE_EXPIRED", "DEVICE_UNAUTHORIZED"].includes((error as Error).message))
        await this.stop(true);
    }
  }
  private async handle(run: TaskRun, gen: string, p: string, body: any, binary?: Uint8Array) {
    if (p === "local:browser") {
      const current = () => {
        if (this.current?.id !== run.id || this.generation !== gen || this.stopping)
          throw Error("CANCEL_REQUESTED");
      };
      const b = z.object({ accountId: z.string(), proxyPort: z.number().int() }).parse(body);
      if (b.accountId !== run.profileId) throw new Error("PROFILE_MISMATCH");
      if (!run.cleanupPending) return this.browser.launch(b.accountId, b.proxyPort);
      const access = await this.cloud.request<BrowserStateAccess>(
        "POST",
        `/api/runner/runs/${run.id}/browser-state`,
        { epoch: run.leaseEpoch },
      );
      current();
      const marker = this.journal.get<{
        profile: string;
        credentialVersion: number;
        stateEpoch: number;
        revision: number;
        dirty: boolean;
      }>(`profileState:${run.profileId}`);
      const reuse =
        !!marker &&
        marker.credentialVersion === access.credentialVersion &&
        marker.stateEpoch === access.stateEpoch &&
        marker.revision === access.revision;
      const profile = reuse
        ? marker.profile
        : !marker &&
            access.stateEpoch === 1 &&
            access.credentialVersion === 1 &&
            access.revision === 0
          ? run.profileId
          : `profile_${randomUUID()}`;
      let launch = await this.browser.launch(profile, b.proxyPort),
        restored = false;
      current();
      try {
        this.stateAdapter = await BrowserStateAdapter.connect(launch.cdpUrl);
        current();
        if (access.state) {
          if (reuse) {
            if (!marker.dirty) await this.stateAdapter.restoreMissingCookies(access.state);
          } else await this.stateAdapter.restore(access.state);
          restored = true;
        }
        current();
      } catch {
        current();
        // 导入部分失败后隔离整份环境，不能把半恢复状态当成登录成功。
        await this.stateAdapter?.close();
        this.stateAdapter = null;
        await this.browser.close();
        current();
        const freshProfile = `profile_${randomUUID()}`;
        launch = await this.browser.launch(freshProfile, b.proxyPort);
        current();
        this.stateAdapter = await BrowserStateAdapter.connect(launch.cdpUrl).catch(() => null);
        current();
        this.journal.set(`profileState:${run.profileId}`, {
          profile: freshProfile,
          credentialVersion: access.credentialVersion,
          stateEpoch: access.stateEpoch,
          revision: access.revision,
          dirty: true,
          runId: run.id,
        });
        this.stateAccess = access;
        return {
          ...launch,
          state: { ...access, state: undefined, restored: false, restoreFailed: true },
        };
      }
      this.stateAccess = access;
      this.journal.set(`profileState:${run.profileId}`, {
        profile,
        credentialVersion: access.credentialVersion,
        stateEpoch: access.stateEpoch,
        revision: access.revision,
        dirty: true,
        runId: run.id,
      });
      return { ...launch, state: { ...access, state: undefined, restored } };
    }
    if (p === "local:state-capture") {
      if (!this.stateAdapter || !this.protectedStates) return { key: null };
      let reference: string | undefined;
      try {
        const access = await this.cloud.request<BrowserStateAccess>(
          "POST",
          `/api/runner/runs/${run.id}/browser-state`,
          { epoch: run.leaseEpoch, metadataOnly: true },
        );
        if (this.current?.id !== run.id || this.generation !== gen || this.stopping)
          throw Error("CANCEL_REQUESTED");
        if (
          this.stateAccess?.accountId !== access.accountId ||
          this.stateAccess?.credentialVersion !== access.credentialVersion ||
          this.stateAccess?.stateEpoch !== access.stateEpoch
        ) {
          this.stateAccess = access;
          const marker = this.journal.get<Record<string, unknown>>(`profileState:${run.profileId}`);
          if (marker && marker.runId === run.id)
            this.journal.set(`profileState:${run.profileId}`, {
              ...marker,
              credentialVersion: access.credentialVersion,
              stateEpoch: access.stateEpoch,
              revision: access.revision,
              dirty: true,
            });
        }
        const state = await this.stateAdapter.capture(access.origins);
        if (Buffer.byteLength(JSON.stringify(state), "utf8") > BROWSER_STATE_MAX_BYTES)
          throw Error("BROWSER_STATE_TOO_LARGE");
        reference = await this.protectedStates.put({
          state,
          baseRevision: this.stateAccess?.revision ?? access.revision,
        });
        const payload = (await this.protectedStates.read(reference)) as Record<string, unknown>;
        return await this.cloud.request("POST", `/api/runner/runs/${run.id}/browser-state/upload`, {
          ...payload,
          epoch: run.leaseEpoch,
        });
      } catch (error) {
        let reason = "SYNC_FAILED";
        if (error instanceof Error && error.message === "BROWSER_STATE_TOO_LARGE")
          reason = "TOO_LARGE";
        if (
          error instanceof z.ZodError &&
          error.issues.some((issue) => issue.message === "BROWSER_STATE_UNSUPPORTED_COOKIE")
        )
          reason = "UNSUPPORTED_COOKIE";
        await this.cloud
          .request("POST", `/api/runner/runs/${run.id}/browser-state/sync-failed`, {
            epoch: run.leaseEpoch,
            reason,
          })
          .catch(() => {});
        return { key: null };
      } finally {
        if (reference) await this.protectedStates.remove(reference);
      }
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
      p.endsWith("/browser-closed") ||
      p.includes("..") ||
      body?.epoch !== run.leaseEpoch
    )
      throw new Error("RUN_SCOPE_MISMATCH");
    if (p.endsWith("/execution-record")) {
      if (!this.protectedStates) throw Error("OS_ENCRYPTION_UNAVAILABLE");
      const key = `record_${run.id}_${body.callId}`;
      this.journal.queue(key, p, { encryptedRecord: this.protectedStates.encrypt(body) });
      const result = await this.cloud.request("POST", p, body);
      this.journal.remove(key);
      return result;
    }
    if (/\/(events|finish)$/.test(p)) {
      const key = p.endsWith("/finish") ? `finish_${run.id}` : `events_${body.events?.[0]?.id}`;
      this.journal.queue(key, p, body);
      try {
        const result = await this.cloud.request("POST", p, body);
        this.journal.remove(key);
        return result;
      } catch (error) {
        // A definitive control-fence rejection is not an uncertain network result.
        if (["INSTRUCTIONS_PENDING", "INSTRUCTIONS_CHANGED"].includes((error as Error).message))
          this.journal.remove(key);
        throw error;
      }
    }
    return this.cloud.request("POST", p, body, false, binary);
  }
  private retire(run: TaskRun, gen: string, cancelled: boolean) {
    const row = this.journal.incomplete().find((x) => x.run_id === run.id && x.generation === gen);
    if (!row) return;
    const payload = JSON.parse(row.payload),
      uncertain =
        !!payload.writePending ||
        !!payload.mayHaveWritten ||
        row.state === "intent" ||
        row.state === "human-delivery" ||
        payload.status === "unknown";
    const stoppedSummary = this.child ? "执行进程已停止。" : "执行进程未能启动。";
    const stoppedCode = this.child ? "EXECUTOR_EXITED" : "EXECUTOR_START_FAILED";
    // Preserve a previously queued terminal fact. Never replace it with a fabricated success.
    this.journal.queue(`finish_${run.id}`, `/api/runner/runs/${run.id}/finish`, {
      epoch: run.leaseEpoch,
      status: uncertain ? "unknown" : cancelled ? "cancelled" : "failed",
      result: {
        summary: uncertain ? "本机已停止，操作结果需要只读核查。" : stoppedSummary,
        outcome: uncertain ? "unconfirmed" : cancelled ? "stopped" : "error",
        evidence: [],
        errorCode: cancelled ? "CANCEL_REQUESTED" : stoppedCode,
      },
    });
    this.journal.checkpoint(run.id, gen, run.leaseEpoch, "abandoned", {
      uncertain,
      timing: payload.timing,
    });
  }
  private queueCleanup(runId: string, epoch: number, profileId: string) {
    this.journal.queue(`closed_${runId}`, `/api/runner/runs/${runId}/browser-closed`, {
      epoch,
      runId,
      profileId,
    });
  }
  private closed(run: TaskRun) {
    if (!run.cleanupPending) return;
    this.queueCleanup(run.id, run.leaseEpoch, run.profileId);
    this.journal.set("browserCleanup", null);
    this.stateAccess = null;
  }
  stop(requestCancel = true, graceful = false): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.current) return Promise.resolve();
    this.stopping = true;
    const child = this.child,
      run = this.current!,
      gen = this.generation;
    this.stopPromise = (async () => {
      child?.postMessage({ type: "cancel", generation: gen });
      // Offline stopping must not wait for a network request. Stop effects before reporting.
      await this.browser.close(graceful);
      await this.stateAdapter?.close();
      this.stateAdapter = null;
      if (child && !this.exited.has(child)) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const exited = new Promise<void>((resolve, reject) => {
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          timer = setTimeout(() => reject(new Error("EXECUTOR_EXIT_TIMEOUT")), 10000);
        });
        if (!child.kill() && !this.exited.has(child)) {
          clearTimeout(timer);
          throw new Error("EXECUTOR_KILL_FAILED");
        }
        if (this.exited.has(child)) clearTimeout(timer);
        else await exited;
      }
      this.retire(run, gen, child ? requestCancel : false);
      this.closed(run);
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
