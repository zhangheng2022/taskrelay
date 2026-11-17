import { createApi, rpcData } from "./api";
import { DraftMessages } from "./chat-parts";
import { ChatMarkdown } from "./chat-markdown";
import { useState, useRef } from "react";
import type { ModelProfile, TaskDefinition, TaskRun, Transport } from "../../contracts/src/index";
import { attachmentCapabilities } from "../../contracts/src/attachments";
import { canUseModel, ModelSelector, ReasoningEffortSelector } from "./model-selector";
import { useThread } from "./use-thread";
import { Thread, Composer, ChatMessage, ThreadActivity, SendingMessage } from "./chat-parts";
import { MessageScrollerItem } from "./components/ui/message-scroller";
import { Button } from "./components/ui/button";
import { ErrorText, LoadFeedback } from "./feedback";
import { ChatAttachments, SentAttachments } from "./chat-attachments";
import { conversationRows, ExecutionProgress } from "./execution-progress";

// 将用户消息、云端协助和执行器反馈合并到同一聊天；停止直接调用运行控制接口。
// run 由工作空间选择当前活动运行，历史记录入口不会把停止按钮绑定到旧运行。
export function Conversation({
  transport,
  task,
  run,
  runs = [],
  models,
  offline,
  refresh,
}: {
  transport: Transport;
  task: TaskDefinition;
  run: TaskRun | null;
  runs?: TaskRun[];
  models?: ModelProfile[];
  refresh: () => Promise<void>;
  offline: boolean;
}) {
  const thread = useThread(transport, "chat", task.modelId, task.id);
  const [text, setText] = useState(""),
    [files, setFiles] = useState<File[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [stopping, setStopping] = useState<string | null>(null);
  const [switching, setSwitching] = useState("");
  const sending = useRef(false);
  const stopFlight = useRef<string | null>(null);
  const active =
    run &&
    (["queued", "running", "waiting_user", "verifying"].includes(run.status) ||
      run.cleanupPending ||
      run.dispatchGroupActive);
  const cancellable =
    run &&
    (["queued", "running", "waiting_user", "verifying"].includes(run.status) ||
      !!run.dispatchGroupActive);
  const stopPending = !!run && (stopping === run.id || !!run.cancelRequested);
  const runLabels = new Map(runs.map((item) => [item.id, item.accountName]));
  if (run?.accountName) runLabels.set(run.id, run.accountName);
  const modelId = thread.page?.modelId ?? task.modelId;
  const modelUnavailable =
    thread.page?.modelAvailable === undefined
      ? !!models && !models.some((m) => m.id === modelId && canUseModel(m))
      : !thread.page.modelAvailable;
  const modelLocked =
    !!active ||
    run?.status === "unknown" ||
    runs.some((item) => item.status === "unknown") ||
    !!thread.page?.activeTurn ||
    !!thread.page?.queued?.length;
  async function changeModel(selection: Parameters<typeof thread.changeModel>[0]) {
    if (sending.current || switching || modelLocked) return;
    sending.current = true;
    setSwitching("modelId" in selection ? "正在切换模型…" : "正在保存推理强度…");
    setError("");
    try {
      await thread.changeModel(selection);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      sending.current = false;
      setSwitching("");
    }
  }
  let activity: string | null = null;
  if (thread.sending) activity = "正在发送…";
  else if (thread.page?.activeTurn) activity = "云端助手正在处理…";
  else if (active) {
    if (stopPending) activity = "正在停止…";
    else if (run.status === "unknown") activity = "本次操作结果待核查，后续账号已暂停";
    else if (run.cleanupPending && !["running", "waiting_user", "verifying"].includes(run.status))
      activity = "正在结束本次执行…";
    else if (thread.page?.waiting || run.status === "waiting_user") activity = "等待你的回复";
    else if (run.status === "queued") activity = "等待执行设备";
    else activity = "执行器正在处理…";
  }
  const messages = [...(thread.page?.messages ?? [])].sort((a, b) => a.seq - b.seq);
  async function send() {
    if (
      sending.current ||
      (!text.trim() && !files.length) ||
      offline ||
      (cancellable && stopPending) ||
      (modelUnavailable && !active)
    )
      return;
    sending.current = true;
    setBusy(true);
    setError("");
    const value = text;
    setText("");
    setFiles([]);
    try {
      await thread.send(value, undefined, undefined, files);
    } catch (e) {
      setText(value);
      setFiles(files);
      setError((e as Error).message);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function stop() {
    if (!cancellable || !run || offline || stopPending || stopFlight.current === run.id) return;
    stopFlight.current = run.id;
    setStopping(run.id);
    setError("");
    let accepted = false;
    try {
      await rpcData(
        createApi(transport).api.user.runs[":id"].cancel.$post({ param: { id: run.id } }),
      );
      accepted = true;
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (stopFlight.current === run.id) stopFlight.current = null;
      if (!accepted) setStopping((id) => (id === run.id ? null : id));
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Thread key={thread.page?.id ?? "loading"} followRequest={thread.sending?.id}>
        {(thread.loading || thread.error) && (
          <MessageScrollerItem messageId="loading">
            <LoadFeedback
              loading={thread.loading}
              error={thread.error}
              label="正在加载聊天…"
              onRetry={thread.retry}
            />
          </MessageScrollerItem>
        )}
        {thread.page?.nextCursor && (
          <MessageScrollerItem messageId="older">
            <Button variant="ghost" onClick={() => void thread.older()}>
              加载更早消息
            </Button>
          </MessageScrollerItem>
        )}
        {conversationRows(messages).map(({ id, message: m, events }) => (
          <MessageScrollerItem key={id} messageId={id}>
            {events ? (
              <ExecutionProgress
                events={events}
                transport={transport}
                accountLabel={m.run_id ? runLabels.get(m.run_id) : undefined}
              />
            ) : (
              <ChatMessage speaker={m.role}>
                {"source" in m && m.role !== "user" && (
                  <div className="text-xs text-muted-foreground">
                    {m.source === "executor" ? "执行器" : "云端助手"}
                    {"run_id" in m && m.run_id && runLabels.get(m.run_id)
                      ? ` · ${runLabels.get(m.run_id)}`
                      : ""}
                  </div>
                )}
                {m.role === "assistant" ? <ChatMarkdown content={m.content} /> : m.content}
                {"parts" in m && (
                  <ChatAttachments
                    transport={transport}
                    parts={m.parts ?? []}
                    offline={offline}
                    onAccountSaved={async () => {
                      await Promise.all([refresh(), thread.refresh()]);
                    }}
                  />
                )}
                <SentAttachments
                  files={"attachments" in m ? m.attachments : undefined}
                  threadId={thread.page?.id}
                  transport={transport}
                />
              </ChatMessage>
            )}
          </MessageScrollerItem>
        ))}
        {thread.page?.queued?.map((m) => (
          <MessageScrollerItem key={m.id} messageId={m.id}>
            <ChatMessage speaker="user">
              {m.content}
              <SentAttachments
                files={m.attachments}
                threadId={thread.page?.id}
                transport={transport}
              />
            </ChatMessage>
          </MessageScrollerItem>
        ))}
        <DraftMessages drafts={thread.page?.drafts} />
        <SendingMessage message={thread.sending} />
        <ThreadActivity offline={offline} error={thread.error} paused={run?.status === "unknown"}>
          {activity}
        </ThreadActivity>
        {(error || thread.page?.latestTurn?.error) && (
          <MessageScrollerItem messageId="error">
            <ErrorText error={error || thread.page?.latestTurn?.error || ""} />
          </MessageScrollerItem>
        )}
      </Thread>
      <Composer
        text={text}
        setText={setText}
        onSend={() => void send()}
        busy={busy}
        attachments={
          transport.sendAttachments
            ? {
                files,
                setFiles,
                caps:
                  thread.page?.attachmentCapabilities ??
                  attachmentCapabilities(
                    models?.find((model) => model.id === modelId)?.capabilities,
                    active ? run.task.reasoningEffort : thread.page?.reasoningEffort,
                  ),
              }
            : undefined
        }
        stop={
          cancellable
            ? { onStop: () => void stop(), pending: stopPending, disabled: offline }
            : undefined
        }
        disabled={offline || !thread.page || !!switching || (modelUnavailable && !active)}
        label="消息"
        placeholder={thread.page?.waiting ? "在这里回复，执行器会继续…" : "发送消息或补充要求…"}
        modelControls={
          models && (
            <>
              <ModelSelector
                models={models}
                value={modelId}
                onChange={(id) => void changeModel({ modelId: id })}
                disabled={offline || !thread.page || busy || !!switching || modelLocked}
              />
              <ReasoningEffortSelector
                efforts={thread.page?.reasoningEfforts}
                value={thread.page?.reasoningEffort ?? null}
                onChange={(reasoningEffort) => void changeModel({ reasoningEffort })}
                disabled={
                  offline || !thread.page || busy || !!switching || modelLocked || modelUnavailable
                }
              />
            </>
          )
        }
      >
        {switching && (
          <span className="text-xs text-muted-foreground" role="status">
            {switching}
          </span>
        )}
        {modelUnavailable && !modelLocked && (
          <span className="text-xs text-muted-foreground">当前模型不可用，请选择可用模型</span>
        )}
        {active && run.accountName && (
          <span className="text-xs text-muted-foreground">
            {run.accountName}
            {run.dispatchTotal ? ` · ${(run.dispatchIndex ?? 0) + 1}/${run.dispatchTotal}` : ""}
          </span>
        )}
      </Composer>
    </div>
  );
}
