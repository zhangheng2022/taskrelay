import { useEffect, useState } from "react";
import { Activity, Pencil, Square } from "lucide-react";
import type {
  HumanChallenge,
  RunEvent,
  TaskDefinition,
  TaskRun,
  Transport,
} from "../../contracts/src/index";
import { Button } from "./components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./components/ui/card";
import { MessageScrollerItem } from "./components/ui/message-scroller";
import {
  Trace,
  TraceLine,
  TraceTitle,
  TraceIcon,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
} from "./components/ui/trace";
import { Thread, Composer, ChatMessage } from "./chat-parts";
import { ErrorText, formatDate, Status } from "./feedback";

export function Conversation({
  transport,
  task,
  run,
  challenges,
  refresh,
  onEdit,
  offline,
}: {
  transport: Transport;
  task: TaskDefinition;
  run: TaskRun | null;
  challenges: HumanChallenge[];
  refresh: () => Promise<void>;
  onEdit: () => void;
  offline: boolean;
}) {
  const [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [events, setEvents] = useState<RunEvent[]>([]),
    [messages, setMessages] = useState<
      { id: string; role: string; content: string; at: string }[]
    >([]);
  const [usage, setUsage] = useState<
      { input: number | null; output: number | null; cost: number | null }[]
    >([]),
    [image, setImage] = useState<string | null>(null);
  const challenge = challenges.find((c) =>
    ["pending", "answered", "consuming"].includes(c.status),
  );
  const challengeExpired =
    !!challenge && Date.parse(challenge.expiresAt) <= Date.now();
  const replyBlocked =
    offline ||
    (!!challenge &&
      (challenge.status !== "pending" ||
        challenge.kind === "unsupported" ||
        challengeExpired));
  useEffect(() => {
    let live = true,
      loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const [chat, details] = await Promise.all([
          transport.request<typeof messages>(
            "GET",
            `/api/user/tasks/${task.id}/chat`,
          ),
          run
            ? transport.request<{ events: RunEvent[]; usage: typeof usage }>(
                "GET",
                `/api/user/runs/${run.id}`,
              )
            : Promise.resolve(null),
        ]);
        if (live) {
          setMessages(chat);
          setEvents(details?.events ?? []);
          setUsage(details?.usage ?? []);
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        loading = false;
      }
    }
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [transport, task.id, run?.id]);
  useEffect(() => {
    let live = true;
    setImage(null);
    setText("");
    if (challenge?.imageId)
      void transport
        .request<{ dataUrl: string }>(
          "GET",
          `/api/user/artifacts/${challenge.imageId}?format=data`,
        )
        .then((r) => {
          if (live) setImage(r.dataUrl);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
    };
  }, [
    challenge?.id,
    challenge?.version,
    challenge?.leaseEpoch,
    challenge?.imageId,
    transport,
  ]);
  async function send() {
    if (busy || replyBlocked || !text.trim()) return;
    setBusy(true);
    setError("");
    try {
      if (challenge)
        await transport.request(
          "POST",
          `/api/user/challenges/${challenge.id}/reply`,
          {
            runId: challenge.runId,
            stepId: challenge.stepId,
            version: challenge.version,
            leaseEpoch: challenge.leaseEpoch,
            text,
          },
        );
      else
        await transport.request("POST", `/api/user/tasks/${task.id}/chat`, {
          content: text,
          requestId: crypto.randomUUID(),
        });
      setText("");
      await refresh();
      const chat = await transport.request<typeof messages>(
        "GET",
        `/api/user/tasks/${task.id}/chat`,
      );
      setMessages(chat);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function action(path: string, body?: unknown) {
    setBusy(true);
    setError("");
    try {
      await transport.request("POST", path, body);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const active =
    !!run &&
    ["queued", "running", "waiting_user", "verifying"].includes(run.status);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Thread>
        <MessageScrollerItem messageId="goal">
          <ChatMessage role="user">{task.goal}</ChatMessage>
        </MessageScrollerItem>
        <MessageScrollerItem messageId="intro">
          <ChatMessage role="assistant">
            任务已创建。执行进度、结果和需要你协助的步骤会显示在这里。
          </ChatMessage>
        </MessageScrollerItem>
        {messages.map((m) => (
          <MessageScrollerItem
            key={m.id}
            messageId={m.id}
            scrollAnchor={m.role === "user"}
          >
            <ChatMessage role={m.role}>{m.content}</ChatMessage>
          </MessageScrollerItem>
        ))}
        {run && (
          <MessageScrollerItem messageId={run.id}>
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <Status value={run.status} />
                <time className="text-xs text-muted-foreground">
                  {formatDate(run.createdAt)}
                </time>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-7">
                {run.result?.summary ??
                  {
                    queued: "等待执行设备上线并领取任务。",
                    waiting_user: "执行已暂停，需要你完成下面的协助。",
                    running: "执行器正在处理任务。",
                    verifying: "正在核验页面实际结果。",
                    succeeded: "运行已完成。",
                    failed: "执行失败，请查看步骤。",
                    cancelled: "本次运行已取消。",
                    expired: "已错过允许执行的时间。",
                    unknown: "结果尚未确认，账号保持锁定，先进行只读核查。",
                  }[run.status]}
              </p>
              <Trace>
                <TraceCollapsible>
                  <TraceCollapsibleTrigger>
                    <TraceLine>
                      <TraceIcon>
                        <Activity />
                      </TraceIcon>
                      <TraceTitle>
                        {events.length
                          ? `${events.length} 个执行步骤`
                          : "等待步骤回传"}
                      </TraceTitle>
                    </TraceLine>
                  </TraceCollapsibleTrigger>
                  <TraceCollapsibleContent>
                    <ol className="flex flex-col gap-3">
                      {events.map((e) => (
                        <li key={e.id} className="flex flex-col gap-1 text-sm">
                          <span>{e.message}</span>
                          <time className="text-xs text-muted-foreground">
                            {formatDate(e.at)}
                          </time>
                        </li>
                      ))}
                    </ol>
                    <p className="mt-4 text-xs">
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
                <p className="text-sm text-muted-foreground">
                  以上是已回传的信息，最终结果仍待确认。账号保持锁定，请先进行只读核查。
                </p>
              )}
              {run.result?.evidence.map((e, i) => (
                <blockquote key={i} className="border-l-2 pl-4 text-sm">
                  <p className="whitespace-pre-wrap">{e.quote}</p>
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    {e.url}
                  </p>
                </blockquote>
              ))}
              {run.result?.data !== undefined && (
                <pre className="max-h-80 overflow-auto rounded-md bg-muted p-4 text-xs">
                  {typeof run.result.data === "string"
                    ? run.result.data
                    : JSON.stringify(run.result.data, null, 2)}
                </pre>
              )}
              <div className="flex flex-wrap gap-2">
                {run.status === "unknown" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || offline}
                    onClick={() =>
                      void action(`/api/user/runs/${run.id}/reconcile`, {
                        requestId: crypto.randomUUID(),
                      })
                    }
                  >
                    只读核查结果
                  </Button>
                )}
                {active && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || offline}
                    onClick={() =>
                      void action(`/api/user/runs/${run.id}/cancel`)
                    }
                  >
                    <Square data-icon="inline-start" />
                    取消本次运行
                  </Button>
                )}
              </div>
            </div>
          </MessageScrollerItem>
        )}
        {challenge && (
          <MessageScrollerItem messageId={challenge.id}>
            <Card>
              <CardHeader>
                <CardTitle>
                  {challenge.kind === "approval"
                    ? "确认这次操作"
                    : challenge.kind === "unsupported"
                      ? "当前验证不支持"
                      : "需要你的协助"}
                </CardTitle>
                <CardDescription>
                  {formatDate(challenge.expiresAt)} 前有效
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <p className="whitespace-pre-wrap text-sm">
                  {challenge.instruction}
                </p>
                {image && (
                  <img
                    src={image}
                    className="max-h-64 max-w-full self-start"
                    alt="当前步骤的扫码验证图片"
                  />
                )}
                {challenge.kind === "approval" && (
                  <p className="text-sm">核对具体操作后，回复“确认执行”。</p>
                )}
              </CardContent>
              <CardFooter>
                <p className="text-xs text-muted-foreground">
                  {challengeExpired
                    ? "此协助请求已过期，请等待执行状态更新。"
                    : challenge.status !== "pending"
                      ? "已回复，正在检查网站状态。"
                      : "回复只用于当前步骤，不进入聊天记录。"}
                </p>
              </CardFooter>
            </Card>
          </MessageScrollerItem>
        )}
        {busy && (
          <MessageScrollerItem messageId="sending">
            <p role="status" className="text-sm text-muted-foreground">
              正在处理…
            </p>
          </MessageScrollerItem>
        )}
        {error && (
          <MessageScrollerItem messageId="error">
            <ErrorText error={error} />
          </MessageScrollerItem>
        )}
      </Thread>
      <Composer
        text={text}
        setText={setText}
        busy={busy}
        disabled={replyBlocked}
        onSend={() => void send()}
        label={challenge ? "当前验证回复" : "任务对话回复"}
        placeholder={
          challenge
            ? "输入当前步骤需要的信息…"
            : "询问执行情况，或点击调整任务修改目标…"
        }
      >
        {!challenge && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onEdit}
            disabled={busy || offline}
          >
            <Pencil data-icon="inline-start" />
            调整任务
          </Button>
        )}
      </Composer>
    </div>
  );
}
