import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import type {
  HumanChallenge,
  RunEvent,
  TaskDefinition,
  TaskRun,
  Transport,
} from "../../contracts/src/index";
import { InputGroupButton } from "./components/ui/input-group";
import { MessageScrollerItem } from "./components/ui/message-scroller";
import { Thread, Composer, ChatMessage, PendingMessage } from "./chat-parts";
import { ErrorText } from "./feedback";
import { RunReport, type Usage } from "./run-report";
import { ChallengePanel } from "./challenge-panel";

type ChatEntry = { id: string; role: string; content: string; at: string };
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
  const challenge = challenges.find(
    (c) =>
      c.runId === run?.id &&
      ["pending", "answered", "consuming", "expired"].includes(c.status),
  );
  const [, tick] = useState(0);
  const expired =
    !!challenge &&
    (challenge.status === "expired" ||
      Date.parse(challenge.expiresAt) <= Date.now());
  const binding = challenge
    ? JSON.stringify([
        challenge.id,
        challenge.runId,
        challenge.stepId,
        challenge.version,
        challenge.leaseEpoch,
      ])
    : `${task.id}:chat`;
  const scope = `${binding}:${challenge?.status}:${expired}:${!!run?.cancelRequested}`;
  const [input, setInput] = useState({ scope, text: "" });
  const text = input.scope === scope ? input.text : "";
  const [busy, setBusy] = useState("");
  const [error, setError] = useState({ scope, message: "" });
  const [loadError, setLoadError] = useState("");
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [usage, setUsage] = useState<Usage[]>([]);
  const [image, setImage] = useState<{
    binding: string;
    dataUrl: string;
  } | null>(null);
  const [submitted, setSubmitted] = useState("");
  const [cancelled, setCancelled] = useState(false);
  const flight = useRef(false),
    revision = useRef(0);
  const chatAttempt = useRef<{ content: string; requestId: string } | null>(
    null,
  );
  const replyBlocked =
    offline ||
    (!!challenge &&
      (cancelled ||
        !!run?.cancelRequested ||
        expired ||
        challenge.status !== "pending" ||
        challenge.kind === "unsupported" ||
        submitted === binding ||
        run?.status !== "waiting_user"));

  // Clear retained sensitive input on binding/status/expiry changes; the scoped value also prevents a one-frame leak.
  useEffect(() => {
    setInput((current) =>
      current.scope === scope ? current : { scope, text: "" },
    );
  }, [scope]);

  useEffect(() => {
    if (!challenge || expired) return;
    const timer = setTimeout(
      () => tick((v) => v + 1),
      Math.max(0, Date.parse(challenge.expiresAt) - Date.now()) + 1,
    );
    return () => clearTimeout(timer);
  }, [challenge?.expiresAt, expired]);
  useEffect(() => {
    let live = true,
      loading = false;
    async function load() {
      if (loading || flight.current) return;
      loading = true;
      const version = revision.current;
      try {
        const [chat, details] = await Promise.all([
          transport.request<ChatEntry[]>(
            "GET",
            `/api/user/tasks/${task.id}/chat`,
          ),
          run
            ? transport.request<{ events: RunEvent[]; usage: Usage[] }>(
                "GET",
                `/api/user/runs/${run.id}`,
              )
            : Promise.resolve(null),
        ]);
        if (live && version === revision.current) {
          setMessages(chat);
          setEvents(details?.events ?? []);
          setUsage(details?.usage ?? []);
          setLoadError("");
        }
      } catch (e) {
        if (live && version === revision.current)
          setLoadError((e as Error).message);
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
    if (challenge?.imageId && !expired && challenge.status === "pending")
      void transport
        .request<{ dataUrl: string }>(
          "GET",
          `/api/user/artifacts/${challenge.imageId}?format=data`,
        )
        .then((r) => {
          if (live) setImage({ binding, dataUrl: r.dataUrl });
        })
        .catch((e) => {
          if (live) setError({ scope, message: e.message });
        });
    return () => {
      live = false;
    };
  }, [binding, scope, challenge?.imageId, expired, transport]);

  async function send(content = text) {
    if (
      flight.current ||
      replyBlocked ||
      !content.trim() ||
      (challenge && Date.parse(challenge.expiresAt) <= Date.now())
    )
      return;
    flight.current = true;
    revision.current++;
    setBusy(challenge ? "正在提交当前步骤的回复…" : "正在回复…");
    setError({ scope, message: "" });
    try {
      if (challenge) {
        await transport.request(
          "POST",
          `/api/user/challenges/${challenge.id}/reply`,
          {
            runId: challenge.runId,
            stepId: challenge.stepId,
            version: challenge.version,
            leaseEpoch: challenge.leaseEpoch,
            text: content,
          },
        );
        setSubmitted(binding);
      } else {
        if (chatAttempt.current?.content !== content)
          chatAttempt.current = { content, requestId: crypto.randomUUID() };
        await transport.request(
          "POST",
          `/api/user/tasks/${task.id}/chat`,
          chatAttempt.current,
        );
        chatAttempt.current = null;
      }
      setInput({ scope, text: "" });
      const [chat] = await Promise.all([
        transport.request<ChatEntry[]>(
          "GET",
          `/api/user/tasks/${task.id}/chat`,
        ),
        refresh(),
      ]);
      setMessages(chat);
    } catch (e) {
      setError({ scope, message: (e as Error).message });
    } finally {
      flight.current = false;
      revision.current++;
      setBusy("");
    }
  }
  async function action(kind: "cancel" | "reconcile") {
    if (
      !run ||
      flight.current ||
      offline ||
      (kind === "cancel" && (cancelled || run.cancelRequested))
    )
      return;
    flight.current = true;
    revision.current++;
    setBusy(kind === "cancel" ? "正在请求取消…" : "正在请求只读核查…");
    setError({ scope, message: "" });
    try {
      await transport.request(
        "POST",
        `/api/user/runs/${run.id}/${kind}`,
        kind === "reconcile" ? { requestId: crypto.randomUUID() } : undefined,
      );
      if (kind === "cancel") setCancelled(true);
      await refresh();
    } catch (e) {
      setError({ scope, message: (e as Error).message });
    } finally {
      flight.current = false;
      revision.current++;
      setBusy("");
    }
  }
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
            <RunReport
              run={cancelled ? { ...run, cancelRequested: true } : run}
              events={events}
              usage={usage}
              disabled={!!busy || offline}
              onCancel={() => void action("cancel")}
              onReconcile={() => void action("reconcile")}
            />
          </MessageScrollerItem>
        )}
        {challenge && (
          <MessageScrollerItem messageId={binding}>
            <ChallengePanel
              challenge={challenge}
              image={image?.binding === binding ? image.dataUrl : undefined}
              expired={expired}
              submitted={submitted === binding}
              cancelled={cancelled || !!run?.cancelRequested}
              disabled={!!busy || replyBlocked}
              onReply={(value) => void send(value)}
              onDeny={() => void action("cancel")}
            />
          </MessageScrollerItem>
        )}
        {busy && (
          <MessageScrollerItem messageId="pending">
            <PendingMessage>{busy}</PendingMessage>
          </MessageScrollerItem>
        )}
        {((error.scope === scope && error.message) || loadError) && (
          <MessageScrollerItem messageId="error">
            <ErrorText
              error={(error.scope === scope && error.message) || loadError}
            />
          </MessageScrollerItem>
        )}
      </Thread>
      <Composer
        text={text}
        setText={(value) => setInput({ scope, text: value })}
        busy={!!busy}
        disabled={replyBlocked}
        onSend={() => void send()}
        label={challenge ? "当前验证回复" : "任务对话回复"}
        maxLength={challenge ? 4000 : 6000}
        placeholder={
          challenge
            ? challenge.kind === "approval"
              ? "核对操作后点击确认，或输入“确认执行”…"
              : "输入当前步骤需要的信息…"
            : "询问执行情况，或调整任务修改目标…"
        }
      >
        {!challenge && (
          <InputGroupButton
            size="sm"
            disabled={!!busy || offline}
            onClick={onEdit}
          >
            <Pencil />
            调整任务
          </InputGroupButton>
        )}
      </Composer>
    </div>
  );
}
