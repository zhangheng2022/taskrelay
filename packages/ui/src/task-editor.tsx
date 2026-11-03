import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import type {
  Snapshot,
  TaskDefinition,
  TaskInput,
  Transport,
} from "../../contracts/src/index";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
import { ErrorText } from "./app";
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function TaskEditor({
  task,
  snapshot,
  transport,
  onClose,
  onSaved,
}: {
  task: TaskDefinition | null;
  snapshot: Snapshot;
  transport: Transport;
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<TaskInput>(
    task ?? {
      title: "",
      goal: "",
      entryUrl: "",
      allowedOrigins: [],
      accountId: null,
      modelId:
        snapshot.models.find(
          (m) => m.capabilities.tools && m.capabilities.structured !== "none",
        )?.id ?? "",
      allowedActions: ["read", "navigate"],
      verification: { kind: "text_present", value: "" },
      schedule: { kind: "manual" },
    },
  );
  const [kind, setKind] = useState(task?.schedule.kind ?? "manual"),
    [cron, setCron] = useState(
      task?.schedule.kind === "cron" ? task.schedule.expression : "0 9 * * *",
    ),
    [at, setAt] = useState(
      task?.schedule.kind === "once"
        ? new Date(
            new Date(task.schedule.at).getTime() -
              new Date(task.schedule.at).getTimezoneOffset() * 60000,
          )
            .toISOString()
            .slice(0, 16)
        : "",
    ),
    [timezone, setTimezone] = useState(
      task?.schedule.kind === "cron" ? task.schedule.timezone : "Asia/Shanghai",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [originsText, setOriginsText] = useState(
    task?.allowedOrigins.join("\n") ?? "",
  );
  const change = <K extends keyof TaskInput>(key: K, value: TaskInput[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  async function parse() {
    setBusy(true);
    setError("");
    try {
      const d = await transport.request<TaskInput>(
        "POST",
        "/api/user/tasks/draft",
        { goal: draft.goal, modelId: draft.modelId },
      );
      setDraft(d);
      setOriginsText(d.allowedOrigins.join("\n"));
      setKind(d.schedule.kind);
      setCron(d.schedule.kind === "cron" ? d.schedule.expression : "0 9 * * *");
      setTimezone(
        d.schedule.kind === "cron" ? d.schedule.timezone : "Asia/Shanghai",
      );
      setAt(
        d.schedule.kind === "once"
          ? new Date(
              new Date(d.schedule.at).getTime() -
                new Date(d.schedule.at).getTimezoneOffset() * 60000,
            )
              .toISOString()
              .slice(0, 16)
          : "",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const schedule: TaskInput["schedule"] =
        kind === "manual"
          ? { kind: "manual" }
          : kind === "once"
            ? { kind: "once", at: new Date(at).toISOString() }
            : { kind: "cron", expression: cron, timezone };
      const {
        id,
        version,
        modelVersion,
        status,
        createdAt,
        nextRunAt,
        ...clean
      } = draft as TaskDefinition;
      const input = {
        ...clean,
        allowedOrigins: [
          ...new Set([
            new URL(draft.entryUrl).origin,
            ...originsText
              .split("\n")
              .map((x) => x.trim())
              .filter(Boolean),
          ]),
        ],
        schedule,
      };
      const result = await transport.request<{ id: string }>(
        task ? "PUT" : "POST",
        task ? `/api/user/tasks/${task.id}` : "/api/user/tasks",
        task
          ? { task: input, expectedVersion: task.version }
          : { task: input, requestId: crypto.randomUUID().replaceAll("-", "") },
      );
      await onSaved(result.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="task-editor">
        <DialogHeader>
          <DialogTitle>{task ? "编辑任务" : "创建一个任务"}</DialogTitle>
          <DialogDescription>
            先确认目标和允许的操作，再授权首次试运行。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void save(e)}>
          <Field label="想让它做什么？">
            <Textarea
              required
              rows={3}
              value={draft.goal}
              placeholder="例如：每天上午打开指定网站，查询我关注的信息并整理结果。请包含完整网站地址。"
              onChange={(e) => change("goal", e.target.value)}
            />
          </Field>
          <div className="form-grid">
            <Field label="使用的模型">
              <select
                value={draft.modelId}
                onChange={(e) => change("modelId", e.target.value)}
                required
              >
                <option value="">先在设置中配置模型</option>
                {snapshot.models.map((m) => (
                  <option
                    key={m.id}
                    value={m.id}
                    disabled={
                      !m.capabilities.tools ||
                      m.capabilities.structured === "none"
                    }
                  >
                    {m.name} · {m.model}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              type="button"
              className="align-bottom"
              variant="outline"
              disabled={busy || !draft.goal || !draft.modelId}
              onClick={() => void parse()}
            >
              {busy ? <Loader2 className="spin" /> : <Sparkles />}生成任务草稿
            </Button>
          </div>
          <Field label="任务名称">
            <Input
              required
              value={draft.title}
              maxLength={120}
              onChange={(e) => change("title", e.target.value)}
              placeholder="给这个任务起个名字"
            />
          </Field>
          <div className="form-grid">
            <Field label="网站地址">
              <Input
                required
                type="url"
                value={draft.entryUrl}
                onChange={(e) => change("entryUrl", e.target.value)}
                placeholder="https://example.com"
              />
            </Field>
            <Field label="站点账号">
              <select
                value={draft.accountId ?? ""}
                onChange={(e) => change("accountId", e.target.value || null)}
              >
                <option value="">不使用账号</option>
                {snapshot.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.usernameHint}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field
            label="允许访问的其他站点"
            hint="每行一个 HTTPS 域名地址；不会允许访问本地网络。"
          >
            <Textarea
              rows={2}
              value={originsText}
              onChange={(e) => setOriginsText(e.target.value)}
              placeholder="https://login.example.com"
            />
          </Field>
          <fieldset className="permissions">
            <legend>允许操作</legend>
            {(["read", "navigate", "fill", "submit", "publish"] as const).map(
              (a, i) => (
                <label key={a}>
                  <input
                    type="checkbox"
                    checked={draft.allowedActions.includes(a)}
                    onChange={(e) =>
                      change(
                        "allowedActions",
                        e.target.checked
                          ? [...draft.allowedActions, a]
                          : draft.allowedActions.filter((x) => x !== a),
                      )
                    }
                  />
                  {
                    [
                      "读取信息",
                      "页面导航",
                      "填写内容",
                      "提交表单",
                      "发布内容",
                    ][i]
                  }
                </label>
              ),
            )}
            <small>付款、删除等高影响操作仍会在对话中请求具体确认。</small>
          </fieldset>
          <div className="form-grid">
            <Field label="什么时候执行？">
              <select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as typeof kind);
                  if (e.target.value === "daily") setCron("0 9 * * *");
                  if (e.target.value === "weekly") setCron("0 9 * * 1");
                }}
              >
                <option value="manual">手动运行</option>
                <option value="once">一次性</option>
                <option value="daily">每日</option>
                <option value="weekly">每周</option>
                <option value="cron">自定义 cron</option>
              </select>
            </Field>
            {kind === "once" ? (
              <Field label="执行时间（本机时区）">
                <Input
                  type="datetime-local"
                  required
                  value={at}
                  onChange={(e) => setAt(e.target.value)}
                />
              </Field>
            ) : kind !== "manual" ? (
              <Field label="时区">
                <Input
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  required
                />
              </Field>
            ) : (
              <p className="form-note">创建后立即加入试运行队列。</p>
            )}
          </div>
          {kind !== "manual" && kind !== "once" && (
            <Field
              label="Cron 规则"
              hint="依次为 分 时 日 月 星期。每日 09:00：0 9 * * *；每周一：0 9 * * 1。"
            >
              <Input
                required
                value={cron}
                onChange={(e) => setCron(e.target.value)}
              />
            </Field>
          )}
          <div className="form-grid">
            <Field label="成功判据">
              <select
                value={draft.verification.kind}
                onChange={(e) =>
                  change("verification", {
                    ...draft.verification,
                    kind: e.target.value as TaskInput["verification"]["kind"],
                  })
                }
              >
                <option value="text_present">页面出现指定文字</option>
                <option value="text_absent">页面不再出现指定文字</option>
                <option value="url">到达指定完整地址</option>
                <option value="extraction">提取包含指定文字的信息</option>
              </select>
            </Field>
            <Field label="核验内容">
              <Input
                required
                value={draft.verification.value}
                onChange={(e) =>
                  change("verification", {
                    ...draft.verification,
                    value: e.target.value,
                  })
                }
                placeholder="例如：提交成功"
              />
            </Field>
          </div>
          {error && <ErrorText error={error} />}
          <div className="form-footer">
            <p>周期任务在试运行核验成功后启用。</p>
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={busy}
            >
              取消
            </Button>
            <Button type="submit" disabled={busy || !draft.modelId}>
              {busy && <Loader2 className="spin" />}
              {task ? "保存并重新试运行" : "创建并试运行"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
