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
  page_wait: "等待页面变化",
  action_blocked: "调整执行计划",
  snapshot: "页面快照",
  snapshot_unavailable: "快照未保存",
};
const summaries: Record<TaskRun["status"], string> = {
  queued: "等待可用的执行设备和执行额度。已暂停的设备不会领取任务。",
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
        {run.result?.summary ?? (run.status === 'queued' && run.queueReason ? run.queueReason : summaries[run.status])}
      </p>
      <Trace aria-label="执行过程">
        {run.result?.batch&&<>
          <TraceLine><TraceTitle>页面证据与 AI 核验</TraceTitle><TraceDescription>{run.result.batch.coverage==='complete'?'范围已核对完整':'范围尚未核对完整'} · 已发现 {run.result.batch.items.length} / {run.result.batch.expected??'未知'} 项</TraceDescription></TraceLine>
          <p className="text-sm text-muted-foreground">{run.result.batch.reason}</p>
          {run.result.batch.items.map(item=><TraceCollapsible key={item.id}>
            <TraceCollapsibleTrigger><TraceLine><TraceTitle>{item.label}</TraceTitle><TraceDescription>{{pending:'待处理',completed:'本次完成',already_done:'原已完成',excluded:'不在处理范围',unknown:'待核查'}[item.status]}</TraceDescription></TraceLine></TraceCollapsibleTrigger>
            <TraceCollapsibleContent>
              <p className="whitespace-pre-wrap break-words text-sm">{item.label}</p>
              {item.reason&&<p className="text-sm">{item.reason}</p>}
              <p className="whitespace-pre-wrap break-words text-sm">{item.evidence.quote||'尚无明确完成状态'}</p>
              <p className="text-xs text-muted-foreground">采集于 {formatDate(item.evidence.capturedAt)}</p>
            </TraceCollapsibleContent>
          </TraceCollapsible>)}
        </>}
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
                    {event.kind==='snapshot'?'已保存当前页面快照，可在下方核对。':event.message}
                  </CodeBlockContent>
                </CodeBlock>
                {event.kind==='snapshot' && <SnapshotEvidence message={event.message} />}
              </TraceCollapsibleContent>
            </TraceCollapsible>
          );
        })}
        {(!events.length || active) && (
          <TraceLine status={working ? "running" : active ? "pending" : undefined}>
            <TraceIcon>
              {working ? <Loader2 className="animate-spin" /> : <Activity />}
            </TraceIcon>
            <TraceTitle>
              {!active ? "本次运行没有步骤记录" : run.cancelRequested
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

function SnapshotEvidence({message}:{message:string}){
  let snapshot:{artifactId?:string;phase?:string;expiresAt?:string};
  try{snapshot=JSON.parse(message);}catch{return null;}
  if(!/^snapshot_[a-f0-9]{32}$/.test(snapshot.artifactId??''))return null;
  if(!snapshot.expiresAt||Date.parse(snapshot.expiresAt)<=Date.now())return <p className="text-sm text-muted-foreground">快照已到期清理；步骤摘要仍保留。</p>;
  const src='/api/user/artifacts/'+snapshot.artifactId;
  return <div className="flex flex-col gap-2"><p className="text-xs text-muted-foreground">敏感内容已遮蔽，快照最多保留 10 分钟。</p><img src={src} alt="执行页面快照（敏感内容已遮蔽）" loading="lazy" className="max-h-96 max-w-full object-contain" /><Button asChild variant="outline" size="sm"><a href={src} target="_blank" rel="noreferrer">打开快照</a></Button></div>;
}
