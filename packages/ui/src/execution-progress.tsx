import type { Transport } from "../../contracts/src/index";
import type { ThreadPage } from "./use-thread";
import { ChatAttachments } from "./chat-attachments";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
  TraceLine,
  TraceTitle,
  TraceDescription,
} from "./components/ui/trace";

type Message = ThreadPage["messages"][number];
type Row = { id: string; message: Message; events?: Message[] };
/** 按运行聚合过程，消息唯一标识只用于合并重传；真实重复调用全部保留。
 * 只整理已加载的历史，不改变服务器原始消息、执行顺序或用户/协助问题。
 */
export function conversationRows(messages: Message[]): Row[] {
  const rows: Row[] = [],
    groups = new Map<string, Row>(),
    seen = new Set<string>();
  for (const message of messages) {
    if (!message.content.trim() && !message.parts?.length) continue;
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    const progress =
      message.source === "executor" &&
      !message.id.startsWith("final_") &&
      !message.parts?.some((part) => part.type === "account-card") &&
      (message.id.startsWith("progress_") || message.parts?.some((part) => part.type === "tool"));
    if (!progress || !message.run_id) {
      rows.push({ id: message.id, message });
      continue;
    }
    let group = groups.get(message.run_id);
    if (!group) {
      group = { id: `execution_${message.run_id}`, message, events: [] };
      groups.set(message.run_id, group);
      rows.push(group);
    }
    group.events!.push(message);
  }
  return rows;
}
const labels: Record<string, string> = {
  observe: "查找控件",
  extract: "读取页面",
  act: "页面操作",
  navigate: "打开页面",
};
export function ExecutionProgress({
  events,
  transport,
  accountLabel,
}: {
  events: Message[];
  transport: Transport;
  accountLabel?: string;
}) {
  const counts = new Map<string, number>();
  for (const event of events)
    for (const part of event.parts ?? [])
      if (part.type === "tool") counts.set(part.name, (counts.get(part.name) ?? 0) + 1);
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0),
    last = events.at(-1)!;
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceTitle>{accountLabel ? `${accountLabel} · 执行过程` : "执行过程"}</TraceTitle>
            <TraceDescription>{total} 次调用</TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <p className="text-xs text-muted-foreground">
          已加载：
          {[...counts].map(([name, count]) => `${labels[name] ?? name} ${count} 次`).join(" · ")}
          {last.at && (
            <>
              {" "}
              · 最近更新 <time dateTime={last.at}>{new Date(last.at).toLocaleTimeString()}</time>
            </>
          )}
        </p>
        <TraceCollapsibleContent>
          <Trace>
            {events.map((event) => (
              <TraceCollapsible key={event.id}>
                <TraceCollapsibleTrigger>
                  <TraceLine>
                    <TraceTitle>{event.content}</TraceTitle>
                  </TraceLine>
                </TraceCollapsibleTrigger>
                <TraceCollapsibleContent>
                  <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time>
                  <ChatAttachments transport={transport} parts={event.parts ?? []} />
                </TraceCollapsibleContent>
              </TraceCollapsible>
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
