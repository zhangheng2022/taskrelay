import { useEffect, useRef, useState } from "react";
import { ChatMarkdown } from "./chat-markdown";
import type { Snapshot, Transport } from "../../contracts/src/index";
import { useThread } from "./use-thread";
import { canUseModel, ModelSelector } from "./model-selector";
import { Thread, ChatMessage, Composer, ThreadActivity, SendingMessage } from "./chat-parts";
import { MessageScrollerItem } from "./components/ui/message-scroller";
import { Button } from "./components/ui/button";
import { ErrorText, LoadFeedback } from "./feedback";
import { ChatAttachments } from "./chat-attachments";
import { DraftMessages } from "./chat-parts";

// 新任务以普通聊天交办；云端返回 taskId 后沿用原会话进入任务页，不在本地创建执行计划。
export function TaskCompose({
  threadId,
  transport,
  snapshot,
  offline,
  onSaved,
  onSettings,
  onThreadCreated,
}: {
  threadId?: string;
  transport: Transport;
  snapshot: Snapshot;
  offline: boolean;
  onSaved: (id: string) => Promise<void>;
  onSettings: () => void;
  onThreadCreated?: (id: string) => void;
}) {
  const available = snapshot.models.filter(canUseModel);
  const [modelId, setModelId] = useState(available.length === 1 ? available[0].id : "");
  // 初次发送后地址栏记录会话，但仍由当前组件接收这次发送的结果。
  const [resumeThreadId] = useState(threadId);
  const thread = useThread(transport, "compose", modelId, undefined, resumeThreadId);
  const canSend = !!thread.page || (!resumeThreadId && !!modelId);
  const [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const flight = useRef(false),
    opened = useRef("");
  let activity: string | null = null;
  if (thread.sending) activity = "正在发送…";
  else if (thread.page?.activeTurn) activity = "正在处理交办…";
  useEffect(() => {
    const id = thread.page?.taskId;
    if (id && opened.current !== id) {
      opened.current = id;
      void onSaved(id).catch((e) => {
        opened.current = "";
        setError(e.message);
      });
    }
  }, [thread.page?.taskId, onSaved]);
  async function send() {
    if (flight.current || offline || !text.trim() || !canSend) return;
    flight.current = true;
    setBusy(true);
    setError("");
    const content = text;
    setText("");
    try {
      await thread.send(content, onThreadCreated);
    } catch (e) {
      setText(content);
      setError((e as Error).message);
    } finally {
      flight.current = false;
      setBusy(false);
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
              label="正在加载对话…"
              onRetry={thread.retry}
            />
          </MessageScrollerItem>
        )}
        {!thread.page?.messages.length && !thread.loading && !thread.sending && (
          <MessageScrollerItem messageId="welcome">
            <ChatMessage speaker="assistant">
              描述目标和网站，我会开始执行。有需要你决定的问题，会在这里继续沟通。
            </ChatMessage>
            {!available.length && <Button onClick={onSettings}>查看模型设置</Button>}
          </MessageScrollerItem>
        )}
        {thread.page?.nextCursor && (
          <MessageScrollerItem messageId="older">
            <Button variant="ghost" onClick={() => void thread.older()}>
              加载更早消息
            </Button>
          </MessageScrollerItem>
        )}
        {thread.page?.messages.map((m) => (
          <MessageScrollerItem key={m.id} messageId={m.id}>
            <ChatMessage speaker={m.role}>
              {m.role === "assistant" ? <ChatMarkdown content={m.content} /> : m.content}
              <ChatAttachments
                parts={m.parts ?? []}
                transport={transport}
                offline={offline}
                onAccountSaved={thread.refresh}
              />
            </ChatMessage>
          </MessageScrollerItem>
        ))}
        {thread.page?.queued?.map((m) => (
          <MessageScrollerItem key={m.id} messageId={m.id}>
            <ChatMessage speaker="user">{m.content}</ChatMessage>
          </MessageScrollerItem>
        ))}
        <DraftMessages drafts={thread.page?.drafts} />
        <SendingMessage message={thread.sending} />
        <ThreadActivity offline={offline} error={thread.error}>
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
        disabled={offline || !canSend}
        label="任务需求"
        placeholder="交代任务，或继续补充要求…"
      >
        <ModelSelector
          models={snapshot.models}
          value={thread.page?.modelId ?? modelId}
          disabled={busy || !!resumeThreadId || !!thread.page}
          onChange={setModelId}
        />
      </Composer>
    </div>
  );
}
