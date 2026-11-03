import {
  cloneElement,
  isValidElement,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Snapshot, TaskInput } from "../../contracts/src/index";
import { taskInputSchema } from "../../contracts/src/index";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { NativeSelect } from "./components/ui/native-select";
import { Checkbox } from "./components/ui/checkbox";
import {
  Field as ShadcnField,
  FieldLabel,
  FieldDescription,
  FieldGroup,
  FieldSet,
  FieldLegend,
} from "./components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
import { ErrorText } from "./feedback";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const generated = useId();
  const child = isValidElement(children)
    ? (children as ReactElement<{ id?: string; "aria-describedby"?: string }>)
    : null;
  const id = child?.props.id ?? generated;
  return (
    <ShadcnField>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {child
        ? cloneElement(child, {
            id,
            ...(hint ? { "aria-describedby": id + "-hint" } : {}),
          })
        : children}
      {hint && <FieldDescription id={id + "-hint"}>{hint}</FieldDescription>}
    </ShadcnField>
  );
}
export function TaskEditor({
  initial,
  snapshot,
  onClose,
  onApply,
}: {
  initial: TaskInput;
  snapshot: Snapshot;
  onClose: () => void;
  onApply: (task: TaskInput) => void;
}) {
  const [draft, setDraft] = useState(initial),
    [error, setError] = useState("");
  const [origins, setOrigins] = useState(initial.allowedOrigins.join("\n"));
  const change = <K extends keyof TaskInput>(key: K, value: TaskInput[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const schedule = draft.schedule;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>编辑任务配置</DialogTitle>
          <DialogDescription>
            修改后返回确认卡，再授权试运行。
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              onApply(
                taskInputSchema.parse({
                  ...draft,
                  allowedOrigins: [
                    ...new Set([
                      new URL(draft.entryUrl).origin,
                      ...origins
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    ]),
                  ],
                }),
              );
            } catch {
              setError("请检查网站、时间和必填内容。");
            }
          }}
        >
          <FieldGroup>
            <Field label="任务名称">
              <Input
                required
                value={draft.title}
                onChange={(e) => change("title", e.target.value)}
              />
            </Field>
            <Field label="任务目标">
              <Textarea
                required
                value={draft.goal}
                onChange={(e) => change("goal", e.target.value)}
              />
            </Field>
            <Field label="网站地址">
              <Input
                type="url"
                required
                value={draft.entryUrl}
                onChange={(e) => change("entryUrl", e.target.value)}
              />
            </Field>
            <Field label="站点账号">
              <NativeSelect
                value={draft.accountId ?? ""}
                onChange={(e) => change("accountId", e.target.value || null)}
              >
                <option value="">不使用账号</option>
                {snapshot.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="执行安排">
              <NativeSelect
                value={schedule.kind}
                onChange={(e) =>
                  change(
                    "schedule",
                    e.target.value === "manual"
                      ? { kind: "manual" }
                      : e.target.value === "once"
                        ? {
                            kind: "once",
                            at: new Date(Date.now() + 3600000).toISOString(),
                          }
                        : {
                            kind: "cron",
                            expression: "0 9 * * *",
                            timezone: "Asia/Shanghai",
                          },
                  )
                }
              >
                <option value="manual">手动执行</option>
                <option value="once">指定时间执行一次</option>
                <option value="cron">周期执行</option>
              </NativeSelect>
            </Field>
            {schedule.kind === "once" && (
              <Field label="执行时间（本机时区）">
                <Input
                  required
                  type="datetime-local"
                  value={new Date(
                    new Date(schedule.at).getTime() -
                      new Date(schedule.at).getTimezoneOffset() * 60000,
                  )
                    .toISOString()
                    .slice(0, 16)}
                  onChange={(e) => {
                    if (e.target.value)
                      change("schedule", {
                        kind: "once",
                        at: new Date(e.target.value).toISOString(),
                      });
                  }}
                />
              </Field>
            )}
            {schedule.kind === "cron" && (
              <>
                <Field
                  label="Cron 表达式"
                  hint="也可回到对话中说：每天九点、每周一上午十点。"
                >
                  <Input
                    required
                    value={schedule.expression}
                    onChange={(e) =>
                      change("schedule", {
                        ...schedule,
                        expression: e.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="时区">
                  <Input
                    required
                    value={schedule.timezone}
                    onChange={(e) =>
                      change("schedule", {
                        ...schedule,
                        timezone: e.target.value,
                      })
                    }
                  />
                </Field>
              </>
            )}
            <FieldSet>
              <FieldLegend variant="label">允许操作</FieldLegend>
              <FieldGroup className="gap-3">
                {(
                  ["read", "navigate", "fill", "submit", "publish"] as const
                ).map((a) => (
                  <ShadcnField key={a} orientation="horizontal">
                    <Checkbox
                      id={"permission-" + a}
                      checked={draft.allowedActions.includes(a)}
                      onCheckedChange={(v) =>
                        change(
                          "allowedActions",
                          v
                            ? [...draft.allowedActions, a]
                            : draft.allowedActions.filter((x) => x !== a),
                        )
                      }
                    />
                    <FieldLabel htmlFor={"permission-" + a}>
                      {
                        {
                          read: "读取信息",
                          navigate: "页面导航",
                          fill: "填写内容",
                          submit: "提交表单",
                          publish: "发布内容",
                        }[a]
                      }
                    </FieldLabel>
                  </ShadcnField>
                ))}
              </FieldGroup>
            </FieldSet>
            <Field label="成功判据">
              <NativeSelect
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
                <option value="url">到达完整地址</option>
                <option value="extraction">提取内容包含指定文字</option>
              </NativeSelect>
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
              />
            </Field>
            <Field
              label="允许访问的站点"
              hint="每行一个 HTTPS origin；不会自动扩大授权范围。"
            >
              <Textarea
                value={origins}
                onChange={(e) => setOrigins(e.target.value)}
              />
            </Field>
          </FieldGroup>
          {error && <ErrorText error={error} />}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button type="submit">更新确认卡</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
