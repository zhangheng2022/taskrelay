import { useThread } from './use-thread';
import { allowedNavigation, publicUrl } from "../../contracts/src/security";
import { useEffect, useRef, useState } from "react";
import { Loader2, Pencil } from "lucide-react";
import {
  taskInputSchema,
  type Snapshot,
  type TaskDefinition,
  type TaskInput,
  type Transport,
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
import { NativeSelect } from "./components/ui/native-select";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "./components/ui/empty";
import { MessageScrollerItem } from "./components/ui/message-scroller";
import { Thread, ChatMessage, Composer, PendingMessage } from "./chat-parts";
import { canUseModel, ModelSelector } from "./model-selector";
import { TaskSummary } from "./task-summary";
import { TaskEditor, Field } from "./task-editor";
import { ErrorText, LoadFeedback } from "./feedback";

export function TaskCompose({
  transport,
  snapshot,
  initial,
  offline,
  onSaved,
  onSettings,
  onCancel,
}: {
  transport: Transport;
  snapshot: Snapshot;
  initial?: TaskDefinition;
  offline: boolean;
  onSaved: (id: string) => Promise<void>;
  onSettings: () => void;
  onCancel?: () => void;
}) {
  const available = snapshot.models.filter(canUseModel);
  const [modelId, setModelId] = useState(() => {
    if (initial) return initial.modelId;
    try {
      const saved = localStorage.getItem("taskrelay.model");
      if (available.some((m) => m.id === saved)) return saved!;
    } catch {
      /* storage can be unavailable */
    }
    return available.length === 1 ? available[0].id : "";
  });
  const thread=useThread(transport,'compose',modelId,initial?.id);
  const [text, setText] = useState("");
  const messages=thread.page?.messages??[];
  const [draft, setDraft] = useState<TaskInput | null>(
    initial ? taskInputSchema.strip().parse(initial) : null,
  );
  const [ready, setReady] = useState(false),
    [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  // Once sent, retain exactly the same payload/id on an ambiguous network failure.
  const attempt = useRef<{ task: TaskInput; requestId: string; threadId:string; draftVersion:number } | null>(null);
  const inFlight = useRef(false);
  const [pending, setPending] = useState<{
    id: string;
    role: "user";
    content: string;
  } | null>(null);
  useEffect(()=>{setDraft(thread.page?.draft??null);setReady(!!thread.page?.draft);},[thread.page?.id,thread.page?.version,thread.page?.latestTurn?.status]);
  const locked = saving || !!attempt.current || !!thread.page?.activeTurn || !thread.page;
  const capable = available.some((m) => m.id === modelId);
  async function send(content = text) {
    if (inFlight.current || locked || offline || !content.trim() || !capable)
      return;
    const pending = {
      id: crypto.randomUUID(),
      role: "user" as const,
      content,
    };
    inFlight.current = true;
    setPending(pending);
    setText("");
    setReady(false);
    setBusy(true);
    setError("");
    try {
      const response = await thread.send(content);
      if (response.draft) setDraft(response.draft);
      setReady(!!response.draft);
      setText("");
    } catch (e) {
      setError((e as Error).message);
      setText(content);
    } finally {
      inFlight.current = false;
      setPending(null);
      setBusy(false);
    }
  }
  async function confirm() {
    if (!draft || inFlight.current || offline || !capable) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      if (!attempt.current) {
        draft.allowedOrigins.forEach((origin) => publicUrl(origin));
        allowedNavigation(draft.entryUrl, draft.allowedOrigins);
      }
      if(!attempt.current){const saved=await thread.saveDraft({...draft,modelId});attempt.current={task:{...draft,modelId},requestId:crypto.randomUUID(),threadId:saved.id,draftVersion:saved.version};}
      const result = await transport.request<{ id: string }>(
        initial ? "PUT" : "POST",
        initial ? `/api/user/tasks/${initial.id}` : "/api/user/tasks",
        initial
          ? { ...attempt.current, expectedVersion: initial.version }
          : attempt.current,
      );
      await onSaved(result.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Thread>
        {thread.page?.nextCursor && <MessageScrollerItem messageId="older"><Button variant="ghost" onClick={()=>void thread.older()}>加载更早消息</Button></MessageScrollerItem>}
        {(thread.loading||thread.error) && <MessageScrollerItem messageId="load-error"><LoadFeedback loading={thread.loading} error={thread.error} label="正在加载任务对话…" onRetry={thread.retry}/></MessageScrollerItem>}
        {thread.page?.latestTurn?.error && <MessageScrollerItem messageId="turn-error"><ErrorText error={thread.page.latestTurn.error}/></MessageScrollerItem>}

        {!messages.length && !pending && !thread.loading && !thread.error && (
          <MessageScrollerItem messageId="welcome">
            <Empty className="py-8 md:py-14">
              <EmptyHeader>
                <EmptyTitle>
                  {initial ? "想调整什么？" : "今天想交给 TaskRelay 什么任务？"}
                </EmptyTitle>
                <EmptyDescription>
                  {initial
                    ? "描述修改内容，核对新任务卡后保存并重新试运行。"
                    : "描述目标和网站，确认后即可试运行。"}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent className="max-w-xl">
                {!available.length ? (
                  <Button variant="outline" onClick={onSettings}>
                    查看设置
                  </Button>
                ) : (
                  !initial && (
                    <div
                      className="flex w-full gap-2 overflow-x-auto pb-2"
                      aria-label="任务建议"
                    >
                      {[
                        "每天查看网站上的最新信息",
                        "监测页面是否发生变化",
                        "登录网站并完成签到",
                      ].map((x) => (
                        <Button
                          key={x}
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={() => void send(x)}
                          disabled={locked || busy || offline || !capable}
                        >
                          {x}
                        </Button>
                      ))}
                    </div>
                  )
                )}
                {initial && onCancel && (
                  <Button
                    variant="ghost"
                    onClick={onCancel}
                    disabled={busy || saving}
                  >
                    返回任务对话
                  </Button>
                )}
              </EmptyContent>
            </Empty>
          </MessageScrollerItem>
        )}
        {(pending ? [...messages, pending] : messages).map((m) => (
          <MessageScrollerItem
            messageId={m.id}
            key={m.id}
            scrollAnchor={m.role === "user"}
          >
            <ChatMessage role={m.role}>{m.content}</ChatMessage>
          </MessageScrollerItem>
        ))}
        {draft && ready && (
          <MessageScrollerItem messageId="proposal">
            <Card>
              <CardHeader>
                <CardTitle>{draft.title}</CardTitle>
                <CardDescription>
                  {initial
                    ? "核对以上修改说明和下面的新配置。"
                    : "确认任务范围后，授权首次执行。"}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <TaskSummary
                  task={draft}
                  accountName={
                    snapshot.accounts.find((a) => a.id === draft.accountId)
                      ?.name
                  }
                />
                {(draft.accountId ||
                  snapshot.accounts.some(
                    (a) => a.origin === new URL(draft.entryUrl).origin,
                  )) && (
                  <Field label="选择站点账号">
                    <NativeSelect
                      disabled={locked || busy}
                      value={draft.accountId ?? ""}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          accountId: e.target.value || null,
                        })
                      }
                    >
                      <option value="">不使用账号</option>
                      {snapshot.accounts
                        .filter(
                          (a) => a.origin === new URL(draft.entryUrl).origin,
                        )
                        .map((a) => (
                          <option value={a.id} key={a.id}>
                            {a.name}
                          </option>
                        ))}
                    </NativeSelect>
                  </Field>
                )}
              </CardContent>
              <CardFooter className="flex flex-wrap gap-2">
                <Button
                  onClick={() => void confirm()}
                  disabled={saving || busy || offline || !capable}
                >
                  {saving && (
                    <Loader2
                      className="animate-spin"
                      data-icon="inline-start"
                    />
                  )}
                  {saving
                    ? "正在保存…"
                    : attempt.current
                      ? "重试确认"
                      : initial
                        ? "保存并重新试运行"
                        : "创建并试运行"}
                </Button>
                <Button
                  variant="outline"
                  disabled={locked || busy}
                  onClick={() => setEditing(true)}
                >
                  <Pencil data-icon="inline-start" />
                  编辑配置
                </Button>
                <p className="w-full text-xs text-muted-foreground">
                  周期任务通过试运行核验后才启用。
                </p>
              </CardFooter>
            </Card>
          </MessageScrollerItem>
        )}
        {(busy || !!thread.page?.activeTurn) && (
          <MessageScrollerItem messageId="pending">
            <PendingMessage>正在整理任务…</PendingMessage>
          </MessageScrollerItem>
        )}
        {error && (
          <MessageScrollerItem messageId="error">
            <ErrorText error={error} />
            {attempt.current && (
              <p className="mt-2 text-sm text-muted-foreground">
                {initial
                  ? "确认请求已保留；若提示版本已更新，请返回任务对话核对最新配置。"
                  : "确认请求已保留，重试会核对同一任务，避免重复创建。"}
              </p>
            )}
          </MessageScrollerItem>
        )}
      </Thread>
      <Composer
        text={text}
        setText={setText}
        onSend={() => void send()}
        busy={busy || !!thread.page?.activeTurn}
        disabled={offline || locked || !capable}
        placeholder={
          initial ? "例如：改成每周一上午九点" : "描述任务，附上完整网站地址…"
        }
        label="任务需求"
      >
        <ModelSelector
          models={snapshot.models}
          value={modelId}
          disabled={busy || locked || offline}
          onChange={(id) => {
            setModelId(id);
            setReady(false);
            try {
              localStorage.setItem("taskrelay.model", id);
            } catch {}
          }}
        />
      </Composer>
      {editing && draft && (
        <TaskEditor
          initial={draft}
          snapshot={snapshot}
          onClose={() => setEditing(false)}
          onApply={(value) => {
            setError("");
            setDraft(value);
            setModelId(value.modelId);
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}
