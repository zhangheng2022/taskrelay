import {
  Activity,
  Check,
  CircleAlert,
  ExternalLink,
  Loader2,
  Square,
} from "lucide-react";
import type { RunEvent, TaskRun } from "../../contracts/src/index";
import { Button } from "./components/ui/button";
import {
  Trace,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
} from "./components/ui/trace";
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockActions,
  CodeBlockCopyButton,
} from "./components/ui/code-block";
import { Marker, MarkerContent } from "./components/ui/marker";
import { formatDate, Status } from "./feedback";

export type Usage = {
  input: number | null;
  output: number | null;
  cost: number | null;
};
const eventNames: Record<string, string> = {
  started: "加载账号环境",
  observed: "读取页面",
  action: "执行动作",
  verification: "核验结果",
  challenge: "等待协助",
  error: "执行错误",
  failed: "执行失败",
};
const summaries: Record<TaskRun["status"], string> = {
  queued: "等待执行设备上线并领取任务。",
  running: "执行器正在处理任务。",
  waiting_user: "执行已暂停，需要你完成下面的协助。",
  verifying: "正在核验页面实际结果。",
  succeeded: "运行已完成。",
  failed: "执行失败，请查看步骤。",
  cancelled: "本次运行已取消。",
  expired: "已错过允许执行的时间。",
  unknown: "结果尚未确认，账号保持锁定，先进行只读核查。",
};
export function RunReport({
  run,
  events,
  usage,
  disabled,
  onCancel,
  onReconcile,
}: {
  run: TaskRun;
  events: RunEvent[];
  usage: Usage[];
  disabled: boolean;
  onCancel: () => void;
  onReconcile: () => void;
}) {
  const active = ["queued", "running", "waiting_user", "verifying"].includes(
    run.status,
  );
  const working =
    ["running", "verifying"].includes(run.status) && !run.cancelRequested;
  const output =
    run.result?.data === undefined
      ? null
      : typeof run.result.data === "string"
        ? run.result.data
        : JSON.stringify(run.result.data, null, 2);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Marker variant="separator">
        <MarkerContent>
          <time>{formatDate(run.createdAt)}</time> · 本次运行
        </MarkerContent>
      </Marker>
      <div className="flex flex-wrap items-center gap-2">
        <Status value={run.status} />
        {run.cancelRequested && active && (
          <span role="status" className="text-sm text-muted-foreground">
            已请求取消，等待执行器停止
          </span>
        )}
      </div>
      <p className="whitespace-pre-wrap text-sm leading-7">
        {run.result?.summary ?? summaries[run.status]}
      </p>
      <Trace aria-label="执行过程">
        {events.map((event) => {
          const failed = ["error", "failed"].includes(event.kind);
          return (
            <TraceCollapsible key={event.id} defaultOpen={failed}>
              <TraceCollapsibleTrigger>
                <TraceLine status={failed ? "error" : undefined}>
                  <TraceIcon>
                    {failed ? <CircleAlert /> : <Activity />}
                  </TraceIcon>
                  <TraceTitle>
                    {eventNames[event.kind] ?? event.kind}
                  </TraceTitle>
                  <TraceDescription>#{event.sequence}</TraceDescription>
                </TraceLine>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent>
                <CodeBlock
                  size="sm"
                  variant={failed ? "destructive" : "default"}
                >
                  <CodeBlockHeader>
                    <CodeBlockTitle>
                      {formatDate(event.at)} · {event.kind}
                    </CodeBlockTitle>
                  </CodeBlockHeader>
                  <CodeBlockContent wrap className="max-h-60">
                    {event.message}
                  </CodeBlockContent>
                </CodeBlock>
              </TraceCollapsibleContent>
            </TraceCollapsible>
          );
        })}
        {(!events.length || active) && (
          <TraceLine status={working ? "running" : "pending"}>
            <TraceIcon>
              {working ? <Loader2 className="animate-spin" /> : <Activity />}
            </TraceIcon>
            <TraceTitle>
              {run.cancelRequested
                ? "等待取消确认"
                : events.length
                  ? summaries[run.status]
                  : "等待步骤回传"}
            </TraceTitle>
          </TraceLine>
        )}
        {run.result?.evidence.map((e, index) => (
          <TraceCollapsible key={`${e.url}:${index}`}>
            <TraceCollapsibleTrigger>
              <TraceLine>
                <TraceIcon>
                  <Check />
                </TraceIcon>
                <TraceTitle>证据 {index + 1}</TraceTitle>
              </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent>
              <p className="whitespace-pre-wrap text-sm">{e.quote}</p>
              {/^https?:\/\//i.test(e.url) ? (
                <Button variant="link" size="sm" asChild className="max-w-full">
                  <a href={e.url} target="_blank" rel="noreferrer">
                    <span className="truncate">{e.url}</span>
                    <ExternalLink />
                  </a>
                </Button>
              ) : (
                <p className="break-all text-xs">{e.url}</p>
              )}
              <p className="text-xs">采集于 {formatDate(e.capturedAt)}</p>
            </TraceCollapsibleContent>
          </TraceCollapsible>
        ))}
        <TraceCollapsible>
          <TraceCollapsibleTrigger>
            <TraceLine>
              <TraceTitle>模型用量</TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <p className="text-xs">
              实际用量：
              {usage.length &&
              usage.every((x) => x.input !== null && x.output !== null)
                ? usage.reduce((n, x) => n + x.input! + x.output!, 0) +
                  " tokens"
                : "未知"}{" "}
              · 费用：
              {usage.length && usage.every((x) => x.cost !== null)
                ? usage.reduce((n, x) => n + x.cost!, 0).toFixed(6)
                : "未知"}
            </p>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </Trace>
      {run.status === "unknown" && run.result?.summary && (
        <Marker>
          <MarkerContent>
            以上是已回传的信息，最终结果仍待确认。账号保持锁定，请先进行只读核查。
          </MarkerContent>
        </Marker>
      )}
      {output !== null && (
        <CodeBlock>
          <CodeBlockHeader>
            <CodeBlockTitle>执行结果</CodeBlockTitle>
            <CodeBlockActions>
              <CodeBlockCopyButton value={output} aria-label="复制执行结果" />
            </CodeBlockActions>
          </CodeBlockHeader>
          <CodeBlockContent wrap className="max-h-80">
            {output}
          </CodeBlockContent>
        </CodeBlock>
      )}
      {run.result?.errorCode && (
        <CodeBlock size="sm" variant="destructive">
          <CodeBlockContent wrap>{run.result.errorCode}</CodeBlockContent>
        </CodeBlock>
      )}
      <div className="flex flex-wrap gap-2">
        {run.status === "unknown" && (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={onReconcile}
          >
            只读核查结果
          </Button>
        )}
        {active && (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || run.cancelRequested}
            onClick={onCancel}
          >
            <Square />
            {run.cancelRequested ? "已请求取消" : "取消本次运行"}
          </Button>
        )}
      </div>
    </div>
  );
}
