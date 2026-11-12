/** 管理员运维按设备、成员和执行池拆分视图，写操作共享确认及结果反馈。 */
import { useState } from "react";
import type { InferResponseType } from "hono/client";
import { PROTOCOL_VERSION, type Transport } from "../../contracts/src/index";
import { createApi, rpcData } from "./api";
import { QueryBoundary, useTransportQuery } from "./queries";
import { Item, ItemContent, ItemActions } from "./components/ui/item";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./components/ui/collapsible";
import { FormSelect } from "./form-select";
import { SelectItem } from "./components/ui/select";
import { Field, FieldGroup, FieldLabel } from "./components/ui/field";
import { Badge } from "./components/ui/badge";
import { LoadFeedback, Status, formatDate } from "./feedback";
import {
  SettingsSearch,
  SettingsEmpty,
  useSettingsAction,
  useConfirmation,
  useSettingsDirty,
} from "./settings-support";
type Operations = InferResponseType<
  ReturnType<typeof createApi>["api"]["admin"]["operations"]["$get"]
>;
type Props = {
  transport: Transport;
  section?: "devices" | "users" | "operations";
  currentUserId?: string;
};
export function AdminPanel(props: Props) {
  return (
    <QueryBoundary owner={props.transport}>
      <OperationsPanel {...props} />
    </QueryBoundary>
  );
}
function OperationsPanel({ transport, section = "operations", currentUserId }: Props) {
  const operations = useTransportQuery(
    transport,
    ["operations"],
    (signal) => rpcData(createApi(transport).api.admin.operations.$get({}, { init: { signal } })),
    60000,
  );
  const data = operations.data,
    action = useSettingsAction(),
    { ask, confirmation } = useConfirmation();
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [role, setRole] = useState("all");
  const act = (id: string, fn: () => Promise<unknown>) => action.act(id, fn, operations.refresh);
  const users =
    data?.users.filter(
      (u) =>
        u.email.toLowerCase().includes(search.toLowerCase()) &&
        (filter === "all" || !!u.disabled === (filter === "disabled")) &&
        (role === "all" || u.role === role),
    ) ?? [];
  return (
    <div className="flex flex-col gap-5">
      {confirmation}
      {action.feedback}
      <div className="section-heading">
        <div>
          <h2>
            {section === "devices" ? "执行设备" : section === "users" ? "用户管理" : "运行维护"}
          </h2>
          <p>
            {section === "devices"
              ? "在 Windows 执行器中发起连接，通过系统浏览器完成管理员授权。"
              : section === "users"
                ? "管理成员状态；个人次数限制保持关闭。"
                : "暂停领取不会停止已开始的任务。"}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={operations.isFetching || !!action.busy}
          onClick={() => void operations.refresh().catch(() => {})}
        >
          刷新状态
        </Button>
      </div>
      <LoadFeedback
        loading={operations.isPending}
        error={operations.error?.message ?? ""}
        label="正在读取管理信息…"
        onRetry={() => void operations.refresh().catch(() => {})}
      />
      {data && section === "users" && (
        <>
          <SettingsSearch
            value={search}
            onChange={setSearch}
            state={filter}
            onState={setFilter}
            label="搜索用户邮箱"
          />
          <Field>
            <FieldLabel htmlFor="member-role">角色</FieldLabel>
            <FormSelect id="member-role" value={role} onValueChange={setRole}>
              <SelectItem value="all">全部角色</SelectItem>
              <SelectItem value="user">普通用户</SelectItem>
              <SelectItem value="admin">管理员</SelectItem>
            </FormSelect>
          </Field>
          {!users.length && <SettingsEmpty />}
          {users.map((u) => (
            <Item key={u.id} asChild>
              <article>
                <ItemContent>
                  <h3>{u.email || "原管理员"}</h3>
                  <p>
                    {u.role === "admin" ? "管理员" : "普通用户"} · {u.disabled ? "已停用" : "正常"}
                  </p>
                  <MemberUsage transport={transport} id={u.id} />
                </ItemContent>
                <ItemActions>
                  <Button
                    variant="outline"
                    disabled={!!action.busy || u.id === currentUserId}
                    onClick={() =>
                      void (async () => {
                        if (
                          await ask(
                            `${u.disabled ? "恢复" : "停用"} ${u.email}`,
                            u.disabled
                              ? "恢复后可重新登录，旧任务不会自动重试。"
                              : "将退出该用户的登录会话，并请求停止其任务。",
                            u.disabled ? "恢复用户" : "停用用户",
                          )
                        )
                          await act(u.id, () =>
                            createApi(transport).api.admin.users[":id"].$put({
                              param: { id: u.id },
                              json: { disabled: !u.disabled },
                            }),
                          );
                      })()
                    }
                  >
                    {u.id === currentUserId ? "当前用户" : u.disabled ? "恢复用户" : "停用用户"}
                  </Button>
                </ItemActions>
              </article>
            </Item>
          ))}
        </>
      )}
      {data && section === "operations" && (
        <>
          <PoolSettings
            claims={data.settings.claimsEnabled}
            busy={!!action.busy}
            save={(enabled) =>
              act("pool", () =>
                createApi(transport).api.admin.pool.$put({ json: { claimsEnabled: enabled } }),
              )
            }
          />
          <h3 className="text-base font-semibold">最近运行</h3>
          <p className="text-sm text-muted-foreground">
            最近 50 次运行，仅展示运维状态，不展示其他用户的任务内容。
          </p>
          {!data.runs.length && (
            <SettingsEmpty title="暂无运行记录" description="任务开始运行后可在这里查看状态。" />
          )}
          {data.runs.map((r) => (
            <Item key={r.id}>
              <ItemContent>
                <Status value={r.status} />
                <p className="break-all">{r.id}</p>
                <p>
                  {formatDate(r.created_at)} · {r.error_code || "无错误"}
                </p>
              </ItemContent>
            </Item>
          ))}
        </>
      )}
      {data && section === "devices" && (
        <>
          {!data.devices.length && (
            <SettingsEmpty
              title="尚未连接设备"
              description="安装 Windows 执行器，在状态窗口发起连接并完成授权。"
            />
          )}
          {data.devices.map((d) => (
            <Item key={d.id} asChild>
              <article>
                <ItemContent>
                  <h3>{d.name}</h3>
                  <p>最近连接：{d.last_seen ? formatDate(d.last_seen) : "尚未连接"}</p>
                  <Badge
                    variant={
                      d.revoked || d.protocol_version !== PROTOCOL_VERSION
                        ? "destructive"
                        : "secondary"
                    }
                  >
                    {d.revoked
                      ? "已吊销"
                      : d.protocol_version !== PROTOCOL_VERSION
                        ? "需要升级客户端"
                        : "协议兼容"}
                  </Badge>
                  <p>{d.activeRunIds?.join("、") || "没有执行中或待清理的关联运行"}</p>
                </ItemContent>
                <ItemActions>
                  <Button
                    variant="outline"
                    disabled={!!action.busy || !!d.revoked}
                    onClick={() =>
                      void (async () => {
                        if (
                          await ask(
                            `吊销“${d.name}”的授权？`,
                            "设备将失去访问权限，正在执行的任务无法继续；重新连接需要再次授权。",
                            "吊销授权",
                          )
                        )
                          await act(d.id, () =>
                            createApi(transport).api.admin.devices[":id"].revoke.$post({
                              param: { id: d.id },
                            }),
                          );
                      })()
                    }
                  >
                    吊销授权
                  </Button>
                </ItemActions>
              </article>
            </Item>
          ))}
          <h3 className="text-base font-semibold">账号优先执行设备</h3>
          <p className="text-sm text-muted-foreground">
            先确认旧设备已停止。结果未知或持有清理锁的账号不能迁移；网站可能要求重新登录。
          </p>
          {!data.accounts.length && (
            <SettingsEmpty title="暂无站点账号" description="用户保存账号后可分配优先设备。" />
          )}
          {data.accounts.map((a) => (
            <Migration
              key={a.id}
              account={a}
              data={data}
              busy={!!action.busy}
              save={(deviceId) =>
                act(a.id, () =>
                  createApi(transport).api.admin.accounts[":id"].migrate.$post({
                    param: { id: a.id },
                    json: { deviceId, oldExecutionStopped: true },
                  }),
                )
              }
            />
          ))}
        </>
      )}
    </div>
  );
}
function MemberUsage({ transport, id }: { transport: Transport; id: string }) {
  const [open, setOpen] = useState(false);
  const usage = useTransportQuery(
    transport,
    ["member-usage", id],
    (signal) =>
      rpcData(
        createApi(transport).api.admin.users[":id"].usage.$get(
          { param: { id } },
          { init: { signal } },
        ),
      ),
    60000,
    open,
  );
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost">{open ? "收起使用量" : "查看今日使用量"}</Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <LoadFeedback
          loading={usage.isPending}
          error={usage.error?.message ?? ""}
          label="正在读取使用量…"
          onRetry={() => void usage.refresh().catch(() => {})}
        />
        {usage.data && (
          <p>
            运行 {usage.data.used.runs} · 对话 {usage.data.used.chat} · 模型调用{" "}
            {usage.data.used.models}
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
function PoolSettings({
  claims,
  busy,
  save,
}: {
  claims: string;
  busy: boolean;
  save: (v: boolean) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null),
    { ask, confirmation } = useConfirmation();
  useSettingsDirty(draft !== null && draft !== claims);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void (async () => {
          if (
            await ask(
              "修改公共执行池？",
              draft === "1"
                ? "允许设备领取等待中的任务。"
                : "暂停领取新任务，已开始的任务继续执行。",
            )
          ) {
            if (await save((draft ?? claims) === "1")) setDraft(null);
          }
        })().catch(() => {});
      }}
    >
      {confirmation}
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="pool-claims">领取任务</FieldLabel>
          <FormSelect
            id="pool-claims"
            disabled={busy}
            value={draft ?? claims}
            onValueChange={setDraft}
          >
            <SelectItem value="1">允许领取</SelectItem>
            <SelectItem value="0">暂停领取</SelectItem>
          </FormSelect>
        </Field>
        <div className="flex gap-2">
          <Button disabled={busy || draft === null}>保存公共池设置</Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || draft === null}
            onClick={() => setDraft(null)}
          >
            撤销修改
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
function Migration({
  account: a,
  data,
  busy,
  save,
}: {
  account: Operations["accounts"][number];
  data: Operations;
  busy: boolean;
  save: (id: string) => Promise<boolean>;
}) {
  const [device, setDevice] = useState(""),
    [stopped, setStopped] = useState(false);
  useSettingsDirty(!!device || stopped);
  return (
    <form
      className="settings-row"
      onSubmit={(e) => {
        e.preventDefault();
        if (stopped)
          void save(device)
            .then((ok) => {
              if (ok) {
                setDevice("");
                setStopped(false);
              }
            })
            .catch(() => {});
      }}
    >
      <FieldGroup>
        <p>
          {a.name} · {a.origin} · {data.users.find((u) => u.id === a.user_id)?.email || a.user_id}
        </p>
        <p className="text-sm text-muted-foreground">
          当前：{data.devices.find((d) => d.id === a.assigned_device_id)?.name || "未分配"}
        </p>
        <Field>
          <FieldLabel htmlFor={a.id + "device"}>优先设备</FieldLabel>
          <FormSelect
            id={a.id + "device"}
            disabled={busy}
            required
            placeholder="选择设备"
            value={device}
            onValueChange={setDevice}
          >
            {data.devices
              .filter((d) => !d.revoked && d.protocol_version === PROTOCOL_VERSION)
              .map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
          </FormSelect>
        </Field>
        <Field orientation="horizontal">
          <Checkbox
            id={a.id + "stopped"}
            disabled={busy}
            required
            checked={stopped}
            onCheckedChange={(checked) => setStopped(checked === true)}
          />
          <FieldLabel htmlFor={a.id + "stopped"}>已确认旧设备停止该账号的执行</FieldLabel>
        </Field>
        <Button variant="outline" disabled={busy || !device || !stopped}>
          设置优先设备
        </Button>
      </FieldGroup>
    </form>
  );
}
