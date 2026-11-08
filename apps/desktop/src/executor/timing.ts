import { AsyncLocalStorage } from "node:async_hooks";
import {
  contextSizeLimit,
  contextSizeReportSchema,
  type ContextSizeReport,
} from "../../../../packages/contracts/src/context-diagnostics";
import {
  recentSpanLimit,
  type ExecutionTiming,
  type TimingPhase,
} from "../shared/execution-timing";

/** 每个 execute 独占一份单调时钟。父阶段含子调用时间，最近明细有界，全程计数保留。 */
export class ExecutionClock {
  private readonly origin = performance.now();
  private readonly parent = new AsyncLocalStorage<number>();
  private readonly phases: ExecutionTiming["phases"] = {};
  private readonly recent: ExecutionTiming["recent"] = [];
  private readonly contextSizes: NonNullable<ExecutionTiming["contextSizes"]> = [];
  private sequence = 0;
  round = 0;
  emptyExtractions = 0;
  private firstNarrativeMs: number | null = null;

  narrativeDelivered() {
    this.firstNarrativeMs ??= this.elapsed();
  }

  close() {
    this.parent.disable();
  }

  /** 只接收严格白名单，不能把消息引用、任意字段或异常正文带入本机诊断。 */
  contextSize(report: ContextSizeReport) {
    const parsed = contextSizeReportSchema.safeParse(report);
    if (!parsed.success) return;
    if (this.contextSizes.length === contextSizeLimit) this.contextSizes.shift();
    this.contextSizes.push({ round: this.round, elapsedMs: this.elapsed(), report: parsed.data });
  }

  private elapsed() {
    return Math.round(performance.now() - this.origin);
  }

  async measure<T>(
    phase: TimingPhase,
    operation: () => Promise<T>,
    requestId?: string,
  ): Promise<T> {
    const span = {
      id: ++this.sequence,
      parent: this.parent.getStore() ?? null,
      round: this.round,
      phase,
      ...(requestId ? { requestId } : {}),
      startMs: this.elapsed(),
      durationMs: 0,
      failed: false,
    };
    try {
      return await this.parent.run(span.id, operation);
    } catch (error) {
      span.failed = true;
      throw error;
    } finally {
      span.durationMs = this.elapsed() - span.startMs;
      const stats = (this.phases[phase] ??= { calls: 0, failures: 0, totalMs: 0 });
      stats.calls++;
      stats.failures += Number(span.failed);
      stats.totalMs += span.durationMs;
      if (this.recent.length === recentSpanLimit) this.recent.shift();
      this.recent.push(span);
    }
  }

  report(): ExecutionTiming {
    return {
      version: 1,
      elapsedMs: this.elapsed(),
      rounds: this.round,
      spanCount: this.sequence,
      emptyExtractions: this.emptyExtractions,
      firstNarrativeMs: this.firstNarrativeMs,
      phases: structuredClone(this.phases),
      recent: [...this.recent],
      ...(this.contextSizes.length ? { contextSizes: structuredClone(this.contextSizes) } : {}),
    };
  }
}
