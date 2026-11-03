import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  Loader2,
  MessageSquare,
  Send,
  ShieldCheck,
} from "lucide-react";
import type {
  HumanChallenge,
  RunEvent,
  TaskDefinition,
  TaskRun,
  Transport,
} from "../../contracts/src/index";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { ErrorText, formatDate, Status } from "./app";
export function Conversation({
  transport,
  task,
  run,
  challenges,
  refresh,
  assistanceJump,
}: {
  assistanceJump: number;
  transport: Transport;
  task: TaskDefinition;
  run: TaskRun | null;
  challenges: HumanChallenge[];
  refresh: () => Promise<void>;
}) {
  const [tab, setTab] = useState<"chat" | "steps" | "definition">("chat"),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [events, setEvents] = useState<RunEvent[]>([]),
    [messages, setMessages] = useState<
      { id: string; role: string; content: string; at: string }[]
    >([]),
    [usage, setUsage] = useState<
      { input: number | null; output: number | null; cost: number | null }[]
    >([]),
    [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    setTab("chat");
  }, [task.id, run?.id, assistanceJump]);
  const challenge = challenges.find((c) =>
    ["pending", "answered", "consuming"].includes(c.status),
  );
  useEffect(() => {
    setText("");
    setError("");
    setImage(null);
    setEvents([]);
    setMessages([]);
  }, [task.id, run?.id, challenge?.id]);
  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const chat = await transport.request<typeof messages>(
          "GET",
          `/api/user/tasks/${task.id}/chat`,
        );
        if (live) setMessages(chat);
        if (run) {
          const r = await transport.request<{
            events: RunEvent[];
            usage: typeof usage;
          }>("GET", `/api/user/runs/${run.id}`);
          if (live) {
            setEvents(r.events);
            setUsage(r.usage);
          }
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    }
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [transport, task.id, run?.id]);
  useEffect(() => {
    if (challenge?.imageId)
      void transport
        .request<{ dataUrl: string }>(
          "GET",
          `/api/user/artifacts/${challenge.imageId}?format=data`,
        )
        .then((x) => setImage(x.dataUrl))
        .catch((e) => setError(e.message));
  }, [challenge?.imageId, transport]);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError("");
    const reply = text;
    setText("");
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
            text: reply,
          },
        );
      else
        await transport.request("POST", `/api/user/tasks/${task.id}/chat`, {
          content: reply,
          requestId: crypto.randomUUID(),
        });
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
    <div className="conversation">
      <div className="detail-tabs" role="tablist" aria-label="任务详情">
        {(["chat", "steps", "definition"] as const).map((id, i) => (
          <button
            role="tab"
            id={`detail-tab-${id}`}
            aria-controls="detail-panel"
            tabIndex={tab === id ? 0 : -1}
            onKeyDown={(e) => {
              const ids = ["chat", "steps", "definition"] as const;
              const i = ids.indexOf(tab);
              const next =
                e.key === "ArrowRight"
                  ? ids[(i + 1) % 3]
                  : e.key === "ArrowLeft"
                    ? ids[(i + 2) % 3]
                    : e.key === "Home"
                      ? ids[0]
                      : e.key === "End"
                        ? ids[2]
                        : null;
              if (next) {
                e.preventDefault();
                setTab(next);
                document.getElementById(`detail-tab-${next}`)?.focus();
              }
            }}
            aria-selected={tab === id}
            key={id}
            onClick={() => setTab(id)}
          >
            {["任务对话", "执行步骤", "任务范围"][i]}
          </button>
        ))}
      </div>
      <div
        className="conversation-body"
        role="tabpanel"
        id="detail-panel"
        aria-labelledby={`detail-tab-${tab}`}
      >
        {tab === "definition" ? (
          <dl className="definition">
            <dt>目标</dt>
            <dd>{task.goal}</dd>
            <dt>网站范围</dt>
            <dd>{task.allowedOrigins.join("\n")}</dd>
            <dt>允许操作</dt>
            <dd>
              {task.allowedActions
                .map(
                  (x) =>
                    ({
                      read: "读取",
                      navigate: "导航",
                      fill: "填写",
                      submit: "提交",
                      publish: "发布",
                    })[x],
                )
                .join("、")}
            </dd>
            <dt>成功判据</dt>
            <dd>
              {task.verification.kind} · {task.verification.value}
            </dd>
            <dt>执行时间</dt>
            <dd>
              {task.schedule.kind === "manual"
                ? "手动执行"
                : task.schedule.kind === "once"
                  ? formatDate(task.schedule.at)
                  : `${task.schedule.expression} · ${task.schedule.timezone}`}
            </dd>
            <dt>模型版本</dt>
            <dd>
              {task.modelId} / v{task.modelVersion}
            </dd>
          </dl>
        ) : tab === "steps" ? (
          <>
            <div className="usage-line">
              实际用量：
              {usage.length &&
              usage.every((x) => x.input !== null && x.output !== null)
                ? `${usage.reduce((a, x) => a + x.input! + x.output!, 0)} tokens`
                : "未知"}
              <span>
                费用：
                {usage.length && usage.every((x) => x.cost !== null)
                  ? usage.reduce((a, x) => a + x.cost!, 0).toFixed(6)
                  : "未知"}
              </span>
            </div>
            {!events.length ? (
              <p className="quiet">尚无执行步骤。设备领取任务后会开始回传。</p>
            ) : (
              <ol className="timeline">
                {events.map((e) => (
                  <li key={e.id}>
                    <span className="timeline-dot" />
                    <div>
                      <strong>{e.message}</strong>
                      <time>{formatDate(e.at)}</time>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </>
        ) : (
          <>
            <div className="task-intro">
              <ShieldCheck size={18} />
              <p>
                任务已限定网站和操作范围。需要验证码、扫码或操作确认时，会在这段对话中等你。
              </p>
            </div>
            {run && (
              <article className="run-summary">
                <div>
                  <Status value={run.status} />
                  <time>{formatDate(run.createdAt)}</time>
                </div>
                <h3>
                  {run.result?.summary ??
                    {
                      queued: "准备好了，等待执行设备上线。",
                      waiting_user: "执行已暂停，等你完成下面的协助。",
                      running: "执行器正在处理任务。",
                      verifying: "正在核验页面实际结果。",
                      succeeded: "本次运行已完成。",
                      failed: "本次执行失败，请查看执行步骤。",
                      cancelled: "本次运行已取消。",
                      expired: "已错过允许的执行时间。",
                      unknown: "操作结果尚未确认，需要只读核查。",
                    }[run.status]}
                </h3>
                {run.status === "unknown" && (
                  <p className="warning-copy">
                    可能已完成提交。当前账号已锁定，核查之前不会再次写入。
                  </p>
                )}
                {run.result?.evidence.map((e, i) => (
                  <blockquote key={i}>
                    {e.quote}
                    <cite>{e.url}</cite>
                  </blockquote>
                ))}
                {run.result?.data !== undefined && (
                  <pre>
                    {typeof run.result.data === "string"
                      ? run.result.data
                      : JSON.stringify(run.result.data, null, 2)}
                  </pre>
                )}
                {run.status === "unknown" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void transport
                        .request("POST", `/api/user/runs/${run.id}/reconcile`, {
                          requestId: crypto.randomUUID(),
                        })
                        .then(refresh)
                        .catch((e) => setError(e.message))
                        .finally(() => setBusy(false));
                    }}
                  >
                    只读核查结果
                  </Button>
                )}
                {active && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void transport
                        .request("POST", `/api/user/runs/${run.id}/cancel`)
                        .then(refresh)
                        .catch((e) => setError(e.message))
                        .finally(() => setBusy(false));
                    }}
                  >
                    取消本次运行
                  </Button>
                )}
              </article>
            )}
            {messages.map((m) => (
              <article className={`chat-message ${m.role}`} key={m.id}>
                <span>{m.role === "user" ? "你" : "TaskRelay"}</span>
                <p>{m.content}</p>
                <time>{formatDate(m.at)}</time>
              </article>
            ))}
            {challenge && (
              <article className="challenge">
                <div className="challenge-title">
                  <MessageSquare size={19} />
                  <h3>
                    {challenge.kind === "approval"
                      ? "请确认这次操作"
                      : challenge.kind === "unsupported"
                        ? "当前验证不支持"
                        : "需要你接力一下"}
                  </h3>
                </div>
                <p>{challenge.instruction}</p>
                {image && (
                  <img
                    src={image}
                    className="challenge-image"
                    alt="当前站点的扫码验证图片"
                  />
                )}
                {challenge.kind === "approval" && (
                  <p>核对操作后，回复“确认执行”。</p>
                )}
                <div className="challenge-meta">
                  <Clock3 size={14} />
                  {formatDate(challenge.expiresAt)} 前有效
                  {challenge.status !== "pending" && (
                    <strong>已回复，正在核验</strong>
                  )}
                </div>
                <small>敏感回复仅用于当前步骤，完成或过期后清除。</small>
              </article>
            )}
            {!run && !messages.length && (
              <div className="chat-empty">
                <CheckCircle2 size={28} />
                <h3>任务已准备就绪</h3>
                <p>
                  立即运行一次，或在这里补充目标。修改授权范围需要编辑任务卡。
                </p>
              </div>
            )}
          </>
        )}
      </div>
      {error && <ErrorText error={error} />}
      <form className="reply-form" onSubmit={(e) => void send(e)}>
        <label className="sr-only" htmlFor={`reply-${task.id}`}>
          任务对话回复
        </label>
        <Textarea
          id={`reply-${task.id}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            challenge
              ? "输入当前步骤需要的信息…"
              : "补充任务信息，或询问执行情况…"
          }
          disabled={
            busy ||
            (!!challenge &&
              (challenge.status !== "pending" ||
                challenge.kind === "unsupported"))
          }
        />
        <Button
          type="submit"
          size="icon"
          aria-label="发送回复"
          disabled={
            busy ||
            !text.trim() ||
            (!!challenge &&
              (challenge.status !== "pending" ||
                challenge.kind === "unsupported"))
          }
        >
          {busy ? <Loader2 className="spin" /> : <Send size={18} />}
        </Button>
      </form>
    </div>
  );
}
