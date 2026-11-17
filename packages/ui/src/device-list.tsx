/** 管理员设备清单根据服务端快照展示领取条件、关联运行和授权历史。 */
import { ChevronDown, Ellipsis, Monitor, ShieldOff } from "lucide-react";
import { Fragment } from "react";
import { PROTOCOL_VERSION } from "../../contracts/src/index";
import type { Operations } from "./admin-panel";
import { Alert, AlertDescription } from "./components/ui/alert";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { Item, ItemGroup, ItemSeparator } from "./components/ui/item";
import { Skeleton } from "./components/ui/skeleton";
import { ErrorText, Status, formatDate } from "./feedback";
import { SettingsEmpty } from "./settings-support";

type Device = Operations["devices"][number];
type Pool = Operations["settings"];
type State = { label: string; group: "ready" | "busy" | "unavailable" | "revoked" };
type Row = { device: Device; state: State };

function deviceState(device: Device, pool: Pool): State {
  if (device.revoked) return { label: "已吊销", group: "revoked" };
  if (device.protocol_version !== PROTOCOL_VERSION)
    return { label: "需要升级客户端", group: "unavailable" };
  if (!device.online)
    return { label: device.last_seen ? "离线" : "尚未连接", group: "unavailable" };
  if (device.relatedRuns.some((run) => run.cleanupPending))
    return { label: "待清理", group: "busy" };
  // 已清理的未知结果仍供核查；只有活动运行或待清理才占用设备。
  if (
    device.relatedRuns.some(({ status }) =>
      ["running", "waiting_user", "verifying"].includes(status),
    )
  )
    return { label: "执行占用", group: "busy" };
  if (!device.claimReady) return { label: "本机未就绪", group: "unavailable" };
  if (pool.maintenance) return { label: "云端维护", group: "unavailable" };
  if (pool.claimsEnabled !== "1") return { label: "暂停领取", group: "unavailable" };
  return { label: "可接任务", group: "ready" };
}

const groups = [
  ["ready", "可接任务"],
  ["busy", "占用"],
  ["unavailable", "暂不可用"],
] as const;

export function DeviceConnectionHelp() {
  return (
    <Collapsible className="rounded-lg border px-3 py-1">
      <CollapsibleTrigger asChild>
        <Button className="group/help w-full justify-between" variant="ghost" size="sm">
          如何连接
          <ChevronDown data-icon="inline-end" className="group-data-[state=open]/help:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2.5 pt-1 pb-3 text-sm text-muted-foreground">
        打开 Windows 执行器，发起连接，再在系统浏览器中完成管理员授权。
      </CollapsibleContent>
    </Collapsible>
  );
}

export function DeviceLoadFeedback({
  loading,
  error,
  lastUpdatedAt,
  retry,
}: {
  loading: boolean;
  error: string;
  lastUpdatedAt: number;
  retry: () => void;
}) {
  if (loading)
    return (
      <div role="status" className="flex flex-col gap-3">
        <span className="sr-only">正在读取设备状态…</span>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  if (!error) return null;
  return (
    <div className="flex flex-col items-start gap-2">
      <ErrorText error={error} />
      {lastUpdatedAt > 0 && (
        <p className="text-sm text-muted-foreground" role="status">
          刷新失败，正在显示上次结果。上次更新 {formatDate(new Date(lastUpdatedAt).toISOString())}
        </p>
      )}
      <Button variant="outline" size="sm" onClick={retry}>
        重新加载
      </Button>
    </div>
  );
}

export function DeviceList({
  data,
  busy,
  onRevoke,
}: {
  data: Operations;
  busy: boolean;
  onRevoke: (device: Device) => void;
}) {
  const byGroup: Record<State["group"], Row[]> = {
    ready: [],
    busy: [],
    unavailable: [],
    revoked: [],
  };
  // last_seen 是 ISO 时间。稳定排序保留接口返回的同刻设备顺序。
  for (const device of [...data.devices].sort((a, b) =>
    (b.last_seen ?? "").localeCompare(a.last_seen ?? ""),
  )) {
    const state = deviceState(device, data.settings);
    byGroup[state.group].push({ device, state });
  }
  const authorized = groups.flatMap(([group]) => byGroup[group]);
  const renderRow = ({ device, state }: Row, index: number) => (
    <Fragment key={device.id}>
      {index > 0 && <ItemSeparator className="m-0" />}
      <DeviceRow device={device} state={state} busy={busy} onRevoke={onRevoke} />
    </Fragment>
  );
  return (
    <div className="flex flex-col gap-4">
      {data.settings.maintenance || data.settings.claimsEnabled !== "1" ? (
        <Alert>
          <AlertDescription>
            {data.settings.maintenance ? "云端维护中，暂不领取任务。" : "管理员已暂停领取新任务。"}
          </AlertDescription>
        </Alert>
      ) : null}
      <dl
        aria-label="执行设备概览"
        className="grid grid-cols-3 divide-x rounded-lg border bg-muted/30"
      >
        {groups.map(([group, label]) => (
          <div key={group} className="flex flex-col gap-1 px-3 py-3 sm:px-4">
            <dt className="text-xs text-muted-foreground sm:text-sm">{label}</dt>
            <dd className="text-xl font-semibold tabular-nums">{byGroup[group].length}</dd>
          </div>
        ))}
      </dl>
      {authorized.length > 0 ? (
        <ItemGroup
          aria-label="已授权设备"
          className="gap-0 rounded-xl border bg-card text-card-foreground"
        >
          {authorized.map(renderRow)}
        </ItemGroup>
      ) : (
        <SettingsEmpty
          title="暂无已授权设备"
          description="在 Windows 执行器中发起连接，再完成管理员授权。"
        />
      )}
      {byGroup.revoked.length > 0 && (
        <Collapsible className="rounded-xl border">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              className="group/history h-auto min-h-11 w-full justify-between px-4 py-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <ShieldOff data-icon="inline-start" />
                已吊销设备
                <span className="text-muted-foreground tabular-nums">{byGroup.revoked.length}</span>
              </span>
              <ChevronDown
                data-icon="inline-end"
                className="group-data-[state=open]/history:rotate-180"
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ItemGroup aria-label="已吊销设备" className="gap-0 border-t">
              {byGroup.revoked.map(renderRow)}
            </ItemGroup>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function DeviceRow({
  device,
  state,
  busy,
  onRevoke,
}: {
  device: Device;
  state: State;
  busy: boolean;
  onRevoke: (device: Device) => void;
}) {
  const lastSeen = device.last_seen ? formatDate(device.last_seen) : "尚未连接";
  return (
    <Item
      asChild
      data-layout="device-row"
      className="block rounded-none border-0 px-3 py-3 sm:px-4"
    >
      <div role="listitem">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Monitor aria-hidden="true" className="size-4" />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <h3 className="min-w-0 font-semibold [overflow-wrap:anywhere]">{device.name}</h3>
                <Badge variant={state.group === "ready" ? "default" : "secondary"}>
                  {state.label}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">最近连接 {lastSeen}</p>
            </div>
          </div>
          {!device.revoked && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`更多操作：${device.name}`}
                  disabled={busy}
                >
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem variant="destructive" onSelect={() => onRevoke(device)}>
                    吊销授权
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <RelatedRuns runs={device.relatedRuns} />
      </div>
    </Item>
  );
}

function RelatedRuns({ runs }: { runs: Device["relatedRuns"] }) {
  if (runs.length === 0)
    return <p className="mt-1 px-12 text-xs text-muted-foreground">关联运行 0</p>;
  return (
    <Collapsible className="mt-1 pl-9 sm:pl-10">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="group/runs text-muted-foreground">
          <ChevronDown
            data-icon="inline-start"
            className="group-data-[state=open]/runs:rotate-180"
          />
          关联运行 {runs.length}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-1 flex flex-col gap-2 rounded-md bg-muted/40 p-2.5">
          {runs.map((run) => (
            <li key={run.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <Status value={run.status} />
              {run.cleanupPending && <Badge variant="secondary">待清理</Badge>}
              <code className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {run.id}
              </code>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
