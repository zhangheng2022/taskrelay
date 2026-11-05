import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Check,
  Ellipsis,
  MessageSquare,
  Moon,
  Plus,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";
import type {
  DesktopStatus,
  Snapshot,
  TaskDefinition,
  Transport,
} from "../../contracts/src/index";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Skeleton } from "./components/ui/skeleton";
import { TooltipProvider } from "./components/ui/tooltip";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
  useSidebar,
} from "./components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "./components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "./components/ui/sheet";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "./components/ui/empty";
import { Settings } from "./settings";
import { PairingNotice } from "./pairing-notice";
import { BrandMark } from "./brand-mark";
import { Conversation } from "./conversation";
import { TaskCompose } from "./task-compose";
import { TaskSummary, scheduleLabel } from "./task-summary";
import { ErrorText, Status, formatDate, LoadingState } from "./feedback";
import { useTheme } from "./use-theme";
import "./styles.css";
export { ErrorText, Status, formatDate } from "./feedback";
const empty: Snapshot = {
  tasks: [],
  runs: [],
  models: [],
  accounts: [],
  devices: [],
  challenges: [],
  serverTime: "",
};
export function App({ transport }: { transport: Transport }) {
  return (
    <TooltipProvider>
      <SidebarProvider className="h-dvh min-h-0">
        <Workspace transport={transport} />
      </SidebarProvider>
    </TooltipProvider>
  );
}
function Workspace({ transport }: { transport: Transport }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [actionError, setActionError] = useState(""),
    [busy, setBusy] = useState(false),
    [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState<"tasks" | "runs" | "settings">("tasks"),
    [selected, setSelected] = useState<string | null>(
      () => location.hash.slice(1) || null,
    ),
    [runId, setRunId] = useState<string | null>(null);
  const [edit, setEdit] = useState<TaskDefinition | null>(null),
    [detail, setDetail] = useState(false),
    [search, setSearch] = useState(""),
    [draftKey, setDraftKey] = useState(0);
  const [desktop, setDesktop] = useState<DesktopStatus | null>(null);
  const [theme, setTheme] = useTheme();
  const { setOpenMobile } = useSidebar();
  const loading = useRef<Promise<void> | null>(null),
    mounted = useRef(true);
  const load = useCallback(
    async (fresh = false) => {
      // A mutation must refresh after an older poll has finished, not reuse its snapshot.
      while (loading.current) {
        await loading.current;
        if (!fresh) return;
      }
      setRefreshing(true);
      const request = (async () => {
        try {
          const status = await transport.desktop?.status();
          if (!mounted.current) return;
          if (status) {
            setDesktop(status);
            if (!status.paired) {
              setPage("settings");
              setError("");
              return;
            }
          }
          const data = await transport.request<Snapshot>(
            "GET",
            "/api/user/snapshot",
          );
          if (mounted.current) {
            setSnapshot(data);
            setError(status && !status.online ? "OFFLINE" : "");
          }
        } catch (e) {
          if (mounted.current) setError((e as Error).message || "OFFLINE");
        }
      })();
      loading.current = request;
      try {
        await request;
      } finally {
        if (loading.current === request) loading.current = null;
        if (mounted.current) setRefreshing(false);
      }
    },
    [transport],
  );
  const refresh = useCallback(() => load(true), [load]);
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = setInterval(() => {if(!document.hidden)void load();}, transport.subscribe ? 60000 : 15000);
    const updates=transport.subscribe?.(()=>void load());
    const unsub = transport.desktop?.subscribe(() => void load());
    return () => {
      mounted.current = false;
      clearInterval(timer);
      updates?.();
      unsub?.();
    };
  }, [load, transport]);
  async function act(path: string, body?: unknown) {
    setBusy(true);
    setActionError("");
    try {
      await transport.request("POST", path, body);
      await refresh();
      return true;
    } catch (e) {
      setActionError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const data = snapshot ?? empty,
    task = data.tasks.find((t) => t.id === selected) ?? null;
  const run =
    data.runs.find((r) => r.id === runId) ??
    (task ? data.runs.find((r) => r.taskId === task.id) : null) ??
    null;
  const pending = data.challenges.filter((c) => c.status === "pending");
  function choose(id: string | null, rid: string | null = null) {
    setSelected(id);
    setRunId(rid);
    setPage("tasks");
    setEdit(null);
    setActionError("");
    setOpenMobile(false);
    history.replaceState(
      null,
      "",
      location.pathname + location.search + (id ? "#" + id : ""),
    );
  }
  function newTask() {
    choose(null);
    setDraftKey((k) => k + 1);
  }
  const offline = !!error || (!!desktop && !desktop.paired);
  return (
    <>
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center justify-between px-2 py-2">
            <span className="flex items-center gap-2 text-sm font-semibold"><BrandMark />TaskRelay</span>
            <span className="text-xs text-muted-foreground">我的任务</span>
          </div>
          <Button variant="outline" onClick={newTask}>
            <Plus data-icon="inline-start" />
            新建任务
          </Button>
          <Input
            aria-label="搜索任务"
            placeholder="搜索任务…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>任务</SidebarGroupLabel>
            <SidebarMenu>
              {data.tasks
                .filter((t) =>
                  (t.title + " " + t.goal)
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((t) => {
                  const waiting = pending.some((c) =>
                    data.runs.some(
                      (r) => r.id === c.runId && r.taskId === t.id,
                    ),
                  );
                  return (
                    <SidebarMenuItem key={t.id}>
                      <SidebarMenuButton
                        isActive={page === "tasks" && selected === t.id}
                        onClick={() => choose(t.id)}
                        tooltip={t.title}
                      >
                        <MessageSquare />
                        <span>{t.title}</span>
                        {waiting && (
                          <span className="ml-auto text-xs">待协助</span>
                        )}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              {!data.tasks.length && (
                <p className="px-2 py-4 text-xs text-muted-foreground">
                  新建一个任务，从一句话开始。
                </p>
              )}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={page === "runs"}
                onClick={() => {
                  setPage("runs");
                  setOpenMobile(false);
                }}
              >
                <Activity />
                <span>运行记录</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={page === "settings"}
                onClick={() => {
                  setPage("settings");
                  setOpenMobile(false);
                }}
              >
                <SettingsIcon />
                <span>设置</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <div className="flex items-center justify-between gap-2 px-2 py-1">
            <button
              className="text-left text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                setPage("settings");
                setOpenMobile(false);
              }}
            >
              {desktop
                ? desktop.activeRunId
                  ? "执行器运行中"
                  : desktop.paused
                    ? "已暂停领取"
                    : desktop.paired
                      ? desktop.online
                        ? "执行器在线"
                        : "执行器离线"
                      : "连接执行器"
                : data.devices.some((d) => !d.revoked)
                  ? "执行设备已连接"
                  : "连接 Windows 执行器"}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="切换主题">
                  <Sun data-icon="inline-start" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuGroup>
                  {(
                    [
                      ["system", "跟随系统"],
                      ["light", "浅色"],
                      ["dark", "深色"],
                    ] as const
                  ).map(([v, label]) => (
                    <DropdownMenuItem key={v} onSelect={() => setTheme(v)}>
                      {theme === v ? <Check /> : <Moon />}
                      {label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 md:px-6">
          <SidebarTrigger />
          <BrandMark className="w-6 md:hidden" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-medium">
              {page === "settings"
                ? "设置"
                : page === "runs"
                  ? "运行记录"
                  : edit
                    ? "调整任务"
                    : (task?.title ?? "新任务")}
            </h1>
            {task && page === "tasks" && (
              <p className="truncate text-xs text-muted-foreground">
                {scheduleLabel(task.schedule)}
              </p>
            )}
          </div>
          {task && page === "tasks" && !edit && (
            <>
              <Status value={run?.status ?? task.status} />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="任务操作">
                    <Ellipsis data-icon="inline-start" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem onSelect={() => setDetail(true)}>
                      任务详情与历史
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={offline}
                      onSelect={() => { setDetail(false); document.querySelector<HTMLTextAreaElement>('[aria-label="任务对话回复"]')?.focus(); }}
                    >
                      调整任务
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={offline || busy}
                      onSelect={() =>
                        void act(`/api/user/tasks/${task.id}/run`, {
                          requestId: crypto.randomUUID(),
                        })
                      }
                    >
                      立即运行
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={offline || busy}
                      onSelect={() =>
                        void act(`/api/user/tasks/${task.id}/state`, {
                          enabled: task.status !== "active",
                        })
                      }
                    >
                      {task.status === "active" ? "暂停调度" : "启用调度"}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </header>
        {data.quota && <div className="border-b px-4 py-2 text-xs text-muted-foreground" role="status">{data.quota.paused
          ? <>{data.quota.pausedUntil?<>个人次数限制已暂停至 {formatDate(data.quota.pausedUntil)}</>:'个人次数限制已关闭，等待手动恢复'} · 今日启动 {data.quota.used.runs} · 模型请求 {data.quota.used.models} · 对话 {data.quota.used.chat}</>
          : <>今日启动 {data.quota.used.runs}/{data.quota.limits.runs} · 模型请求 {data.quota.used.models}/{data.quota.limits.models} · 对话 {data.quota.used.chat}/{data.quota.limits.chat} · {formatDate(data.quota.resetAt)} 重置</>}</div>}
        {error && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2">
            <div className="min-w-0 flex-1">
              <ErrorText error={error} />
            </div>
            <Button variant="outline" size="sm" disabled={refreshing} onClick={() => void load()}>
              {refreshing ? "正在重新连接…" : "重新连接"}
            </Button>
            {desktop?.activeRunId && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void transport
                    .desktop!.stop()
                    .then(refresh)
                    .catch((e) => setActionError(e.message))
                }
              >
                停止本机任务
              </Button>
            )}
          </div>
        )}
        {actionError && (
          <div className="px-4 py-2">
            <ErrorText error={actionError} />
          </div>
        )}
        <PairingNotice transport={transport} refresh={refresh} />
        {pending.length > 0 &&
          !(task && pending.some((c) => c.runId === run?.id)) && (
            <div className="px-4 py-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const r = data.runs.find((r) => r.id === pending[0].runId);
                  if (r) choose(r.taskId, r.id);
                }}
              >
                {pending.length} 个任务需要协助
              </Button>
            </div>
          )}
        {page === "settings" ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-8">
            <Settings transport={transport} snapshot={data} refresh={refresh} />
          </div>
        ) : !snapshot ? (
          <div
            className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-8"
            role="status"
            aria-label="加载工作空间"
          >
            {!error && <><LoadingState label="正在加载工作空间…"/><Skeleton className="h-8 w-40" /><Skeleton className="h-24 w-full" /></>}
            {error && (
              <Button variant="outline" onClick={() => setPage("settings")}>
                打开设置
              </Button>
            )}
          </div>
        ) : page === "runs" ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-8">
            <div className="mx-auto flex max-w-3xl flex-col gap-2">
              {data.runs.length ? (
                data.runs.map((r) => (
                  <Button
                    key={r.id}
                    variant="ghost"
                    className="h-auto justify-start whitespace-normal py-4"
                    onClick={() => choose(r.taskId, r.id)}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1 text-left">
                      <span className="truncate">{r.task.title}</span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        {r.result?.summary ?? formatDate(r.createdAt)}
                      </span>
                    </div>
                    <Status value={r.status} />
                  </Button>
                ))
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>还没有运行记录</EmptyTitle>
                    <EmptyDescription>
                      任务执行后，结果会出现在这里。
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </div>
          </div>
        ) : edit || !task ? (
          <TaskCompose
            key={edit?.id ?? draftKey}
            transport={transport}
            snapshot={data}
            initial={edit ?? undefined}
            offline={offline}
            onCancel={() => setEdit(null)}
            onSettings={() => setPage("settings")}
            onSaved={async (id) => {
              await refresh();
              choose(id);
            }}
          />
        ) : (
          <Conversation
            snapshot={data}
            key={task.id + ":" + (run?.id ?? "")}
            transport={transport}
            task={task}
            run={run}
            challenges={data.challenges.filter((c) => c.runId === run?.id)}
            refresh={refresh}
            onEdit={() => setEdit(task)}
            offline={offline}
          />
        )}
      </SidebarInset>
      <Sheet open={detail} onOpenChange={setDetail}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>任务详情</SheetTitle>
            <SheetDescription>{task?.title}</SheetDescription>
          </SheetHeader>
          {task && (
            <div className="flex flex-col gap-6 p-4">
              <TaskSummary
                task={task}
                accountName={
                  data.accounts.find((a) => a.id === task.accountId)?.name
                }
              />
              <p className="text-xs text-muted-foreground">
                下次执行：{formatDate(task.nextRunAt)} · 配置 v{task.version}
              </p>
              <h2 className="text-sm font-medium">历史运行</h2>
              {data.runs
                .filter((r) => r.taskId === task.id)
                .map((r) => (
                  <Button
                    key={r.id}
                    variant="outline"
                    onClick={() => {
                      choose(task.id, r.id);
                      setDetail(false);
                    }}
                  >
                    {formatDate(r.createdAt)} · <Status value={r.status} />
                  </Button>
                ))}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
