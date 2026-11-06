import { useForm } from "react-hook-form";
import type { InferResponseType } from "hono/client";
import { createApi, rpcData } from "./api";
import { useState } from "react";
import { PROTOCOL_VERSION, type Transport } from "../../contracts/src/index";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { NativeSelect } from "./components/ui/native-select";
import { Field, FieldLabel, FieldGroup } from "./components/ui/field";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./components/ui/card";
import { ErrorText, Status, formatDate } from "./feedback";
import { QueryBoundary, useTransportQuery } from "./queries";
const fields = [
  ["daily_runs", "每日启动"],
  ["scheduled_tasks", "周期任务"],
  ["queued_runs", "排队上限"],
  ["daily_chat", "每日对话"],
  ["daily_models", "每日模型调用"],
] as const;
export function AdminPanel({ transport }: { transport: Transport }) {
  return (
    <QueryBoundary owner={transport}>
      <OperationsPanel transport={transport} />
    </QueryBoundary>
  );
}
function OperationsPanel({ transport }: { transport: Transport }) {
  const operations = useTransportQuery(
    transport,
    ["operations"],
    (signal) => rpcData(createApi(transport).api.admin.operations.$get({}, { init: { signal } })),
    60000,
  );
  const data = operations.data,
    load = operations.refresh;
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState("");
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await fn();
      await load();
      setNote("已保存");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-5">
      {(error || operations.error) && <ErrorText error={error || operations.error!.message} />}
      {note && <p role="status">{note}</p>}
      <Button variant="outline" disabled={busy} onClick={() => void action(load)}>
        刷新运行状态
      </Button>
      {data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>公共执行池</CardTitle>
              <CardDescription>暂停领取不会停止已经开始的任务。</CardDescription>
            </CardHeader>
            <CardContent>
              <PoolSettings
                claims={data.settings.claimsEnabled}
                busy={busy}
                save={(claimsEnabled) =>
                  action(() =>
                    rpcData(createApi(transport).api.admin.pool.$put({ json: { claimsEnabled } })),
                  )
                }
              />
            </CardContent>
          </Card>
          {data.users.map((u) => (
            <Card key={u.id}>
              <CardHeader>
                <CardTitle>{u.email || "原管理员"}</CardTitle>
                <CardDescription>
                  {u.role === "admin" ? "管理员" : "用户"} · {u.disabled ? "已停用" : "正常"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <MemberSettings
                  user={u}
                  busy={busy}
                  save={(input) =>
                    action(() =>
                      rpcData(
                        createApi(transport).api.admin.users[":id"].$put({
                          param: { id: u.id },
                          json: input,
                        }),
                      ),
                    )
                  }
                />
              </CardContent>
            </Card>
          ))}
          <Card>
            <CardHeader>
              <CardTitle>账号优先执行设备</CardTitle>
              <CardDescription>
                保留已保存的登录状态，在新设备尽量恢复；网站仍可能要求重新验证。先确认旧设备已经停止执行，操作结果待核查的账号不能迁移。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              {data.accounts.map((a) => (
                <form
                  key={a.id}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    if (f.get("stopped") !== "on") return;
                    const device = f.get("device");
                    if (typeof device !== "string") {
                      setError("DEVICE_REQUIRED");
                      return;
                    }
                    void action(() =>
                      rpcData(
                        createApi(transport).api.admin.accounts[":id"].migrate.$post({
                          param: { id: a.id },
                          json: {
                            deviceId: device,
                            oldExecutionStopped: true,
                          },
                        }),
                      ),
                    ).catch((error: Error) => setError(error.message));
                  }}
                >
                  <FieldGroup>
                    <p className="break-all text-sm">
                      账号 {a.id} · 用户{" "}
                      {data.users.find((u) => u.id === a.user_id)?.email || a.user_id} · 当前设备{" "}
                      {data.devices.find((d) => d.id === a.assigned_device_id)?.name || "未分配"}
                    </p>
                    <Field>
                      <FieldLabel htmlFor={a.id + "device"}>优先设备</FieldLabel>
                      <NativeSelect id={a.id + "device"} name="device" required defaultValue="">
                        <option value="" disabled>
                          选择设备
                        </option>
                        {data.devices
                          .filter((d) => !d.revoked && d.protocol_version === PROTOCOL_VERSION)
                          .map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                      </NativeSelect>
                    </Field>
                    <Field orientation="horizontal">
                      <Input
                        className="size-4"
                        id={a.id + "stopped"}
                        name="stopped"
                        type="checkbox"
                        required
                      />
                      <FieldLabel htmlFor={a.id + "stopped"}>
                        已确认旧设备停止该账号的执行
                      </FieldLabel>
                    </Field>
                    <Button variant="outline" disabled={busy}>
                      设置优先设备
                    </Button>
                  </FieldGroup>
                </form>
              ))}
              {!data.accounts.length && <p>暂无账号。</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>运行状态</CardTitle>
              <CardDescription>仅展示运维信息，不展示用户任务内容。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {data.runs.map((r) => (
                <div className="flex flex-wrap items-center gap-2 border-b pb-3" key={r.id}>
                  <Status value={r.status} />
                  <span className="break-all text-xs">
                    {r.id} · {formatDate(r.created_at)} · {r.error_code || "—"}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

type Member = InferResponseType<
  ReturnType<typeof createApi>["api"]["admin"]["operations"]["$get"]
>["users"][number];
type MemberInput = Pick<
  Member,
  "daily_runs" | "scheduled_tasks" | "queued_runs" | "daily_chat" | "daily_models"
> & { disabled: boolean };
// 后台刷新仅更新未编辑字段；库持有脏值，避免通知重挂载表单而丢失管理员输入。
function PoolSettings({
  claims,
  busy,
  save,
}: {
  claims: string;
  busy: boolean;
  save: (enabled: boolean) => Promise<void>;
}) {
  const form = useForm({ values: { claims }, resetOptions: { keepDirtyValues: true } });
  void form.formState.dirtyFields;
  return (
    <form
      onSubmit={(event) => {
        void form
          .handleSubmit((values) => save(values.claims === "1"))(event)
          .catch((error: Error) => form.setError("root", { message: error.message }));
      }}
    >
      {form.formState.errors.root?.message && (
        <ErrorText error={form.formState.errors.root.message} />
      )}
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="pool-claims">领取任务</FieldLabel>
          <NativeSelect id="pool-claims" {...form.register("claims")}>
            <option value="1">允许</option>
            <option value="0">暂停</option>
          </NativeSelect>
        </Field>
        <Button disabled={busy}>保存公共池设置</Button>
      </FieldGroup>
    </form>
  );
}
function MemberSettings({
  user,
  busy,
  save,
}: {
  user: Member;
  busy: boolean;
  save: (input: MemberInput) => Promise<void>;
}) {
  const form = useForm({
    values: {
      daily_runs: user.daily_runs,
      scheduled_tasks: user.scheduled_tasks,
      queued_runs: user.queued_runs,
      daily_chat: user.daily_chat,
      daily_models: user.daily_models,
      disabled: String(user.disabled),
    },
    resetOptions: { keepDirtyValues: true },
  });
  void form.formState.dirtyFields;
  return (
    <form
      onSubmit={(event) => {
        void form
          .handleSubmit((values) => save({ ...values, disabled: values.disabled === "1" }))(event)
          .catch((error: Error) => form.setError("root", { message: error.message }));
      }}
    >
      {form.formState.errors.root?.message && (
        <ErrorText error={form.formState.errors.root.message} />
      )}
      <FieldGroup>
        {fields.map(([key, label]) => (
          <Field key={key}>
            <FieldLabel htmlFor={user.id + key}>{label}</FieldLabel>
            <Input
              id={user.id + key}
              type="number"
              min={0}
              max={100000}
              required
              {...form.register(key, { valueAsNumber: true, min: 0, max: 100000 })}
            />
          </Field>
        ))}
        <Field>
          <FieldLabel htmlFor={user.id + "status"}>用户状态</FieldLabel>
          <NativeSelect id={user.id + "status"} {...form.register("disabled")}>
            <option value="0">正常</option>
            <option value="1">停用并停止任务</option>
          </NativeSelect>
        </Field>
        <Button disabled={busy}>保存用户设置</Button>
      </FieldGroup>
    </form>
  );
}
