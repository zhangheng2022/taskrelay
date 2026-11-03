import { useRef, useState } from "react";
import { Loader2, Pencil, Plus } from "lucide-react";
import {
  taskInputSchema,
  type Snapshot,
  type TaskDefinition,
  type TaskInput,
  type TaskProposal,
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
import { Thread, ChatMessage, Composer } from "./chat-parts";
import { TaskSummary } from "./task-summary";
import { TaskEditor, Field } from "./task-editor";
import { ErrorText } from "./feedback";

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
  const available = snapshot.models.filter(
    (m) =>
      m.capabilities.connection &&
      m.capabilities.tools &&
      m.capabilities.structured !== "none",
  );
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
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<
    { id: string; role: "user" | "assistant"; content: string }[]
  >([]);
  const [draft, setDraft] = useState<TaskInput | null>(
    initial ? taskInputSchema.strip().parse(initial) : null,
  );
  const [ready, setReady] = useState(false),
    [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  // Once sent, retain exactly the same payload/id on an ambiguous network failure.
  const attempt = useRef<{ task: TaskInput; requestId: string } | null>(null);
  const locked = saving || !!attempt.current;
  const capable = available.some((m) => m.id === modelId);
  async function send() {
    if (busy || locked || offline || !text.trim() || !capable) return;
    const pending = {
      id: crypto.randomUUID(),
      role: "user" as const,
      content: text,
    };
    const history = [...messages, pending];
    setBusy(true);
    setError("");
    try {
      const response = await transport.request<TaskProposal>(
        "POST",
        "/api/user/tasks/compose",
        {
          modelId,
          messages: history
            .slice(-20)
            .map(({ role, content }) => ({ role, content })),
          current: draft,
        },
      );
      setMessages([
        ...history,
        { id: crypto.randomUUID(), role: "assistant", content: response.reply },
      ]);
      if (response.task) setDraft(response.task);
      setReady(!!response.task);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!draft || saving || offline || !capable) return;
    attempt.current ??= {
      task: { ...draft, modelId },
      requestId: crypto.randomUUID(),
    };
    setSaving(true);
    setError("");
    try {
      const result = await transport.request<{ id: string }>(
        initial ? "PUT" : "POST",
        initial ? `/api/user/tasks/${initial.id}` : "/api/user/tasks",
        initial
          ? { task: attempt.current.task, expectedVersion: initial.version }
          : attempt.current,
      );
      await onSaved(result.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Thread>
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
                  配置模型服务
                </Button>
              ) : (
                !initial && (
                  <div className="flex flex-wrap justify-center gap-2">
                    {[
                      "每天查看网站上的最新信息",
                      "监测页面是否发生变化",
                      "登录网站并完成签到",
                    ].map((x) => (
                      <Button
                        key={x}
                        variant="outline"
                        size="sm"
                        onClick={() => setText(x)}
                        disabled={locked || busy}
                      >
                        <Plus data-icon="inline-start" />
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
        {messages.map((m) => (
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
                <Field label="选择站点账号">
                  <NativeSelect
                    disabled={locked || busy}
                    value={draft.accountId ?? ""}
                    onChange={(e) =>
                      setDraft({ ...draft, accountId: e.target.value || null })
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
                  {attempt.current
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
        {busy && (
          <MessageScrollerItem messageId="pending">
            <p role="status" className="text-sm text-muted-foreground">
              正在整理任务…
            </p>
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
        busy={busy}
        disabled={offline || locked || !capable}
        placeholder={
          initial ? "例如：改成每周一上午九点" : "描述任务，附上完整网站地址…"
        }
        label="任务需求"
      >
        <NativeSelect
          aria-label="使用的模型"
          value={modelId}
          disabled={busy || locked}
          onChange={(e) => {
            setModelId(e.target.value);
            setReady(false);
            try {
              localStorage.setItem("taskrelay.model", e.target.value);
            } catch {}
          }}
        >
          <option value="">选择模型</option>
          {available.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} · {m.model}
            </option>
          ))}
        </NativeSelect>
      </Composer>
      {editing && draft && (
        <TaskEditor
          initial={draft}
          snapshot={snapshot}
          onClose={() => setEditing(false)}
          onApply={(value) => {
            setDraft(value);
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}
