import {HistoryCleanup,type CleanupSelection} from './history-cleanup';
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
  Snapshot,
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
  SidebarMenuAction,
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
import {QueryBoundary,useTransportQuery} from './queries';
import {createApi,rpcData} from './api';
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
    <QueryBoundary owner={transport}><TooltipProvider>
      <SidebarProvider className="h-dvh min-h-0">
        <Workspace transport={transport} />
      </SidebarProvider>
    </TooltipProvider></QueryBoundary>
  );
}
// 工作空间只编排导航、云端快照和当前运行选择；会话读写交给共享聊天组件。
// 通知与轮询共用加载入口，写操作完成后额外刷新，避免旧快照覆盖操作结果。
function Workspace({ transport }: { transport: Transport }) {
  const workspace=useTransportQuery<Snapshot>(transport,['workspace'],signal=>rpcData(createApi(transport).api.user.snapshot.$get({}, {init:{signal}})),transport.subscribe?60000:15000);
  const snapshot=workspace.data??null,error=workspace.error?.message??'',refreshing=workspace.isFetching;
  const [actionError, setActionError] = useState(""),[busy, setBusy] = useState(false);
  const [page, setPage] = useState<"tasks" | "runs" | "settings">("tasks"),
    [selected, setSelected] = useState<string | null>(
      () => location.hash.slice(1) || null,
    ),
    [runId, setRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState(false),
    [search, setSearch] = useState(""),
    [draftKey, setDraftKey] = useState(0);
  const [cleanupSelection,setCleanupSelection]=useState<CleanupSelection|null>(null);
  const [chatEpoch,setChatEpoch]=useState(0);
  const [theme, setTheme] = useTheme();
  const { setOpenMobile } = useSidebar();
  const focusComposer = useRef(false);
  const refresh=useCallback(async()=>{await workspace.refresh().catch(()=>{});},[workspace.refresh]);
  async function act(action:()=>Promise<unknown>) {
    setBusy(true);
    setActionError("");
    try {
      await action();
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
  const taskRuns = task ? data.runs.filter(r=>r.taskId===task.id).map(r=>({...r,accountName:r.accountName??data.accounts.find(a=>a.id===(r.accountId??r.task.accountId))?.name})) : [];
  const activeRun = taskRuns.find(r=>["queued","running","waiting_user","verifying"].includes(r.status))
    ?? taskRuns.find(r=>r.cleanupPending||r.dispatchGroupActive) ?? null;
  const pending = data.waitingHelp ?? [];
  function choose(id: string | null, rid: string | null = null) {
    setSelected(id);
    setRunId(rid);
    setPage("tasks");
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
  const offline = !!error;
  function requestCleanup(scope:CleanupSelection['scope'],target?:{id:string;title:string}){
    setCleanupSelection({scope,targetId:target?.id,title:target?.title,requestId:crypto.randomUUID()});
  }
  async function cleanupAccepted(value:CleanupSelection){
    if(value.scope==='all'||(value.scope==='task'&&value.targetId===selected))newTask();
    if(value.scope==='clear'&&value.targetId===selected)setChatEpoch(n=>n+1);
    await refresh();
  }
  return (
    <>
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center justify-between px-2 py-2">
            <span className="flex items-center gap-2 text-sm font-semibold"><BrandMark />TaskRelay</span>
            <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="聊天列表操作"><Ellipsis/></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end"><DropdownMenuGroup><DropdownMenuItem disabled={offline} onSelect={()=>requestCleanup('all')}>一键清理全部聊天</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
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
                      <DropdownMenu><DropdownMenuTrigger asChild><SidebarMenuAction aria-label={`操作：${t.title}`}><Ellipsis/></SidebarMenuAction></DropdownMenuTrigger>
                      <DropdownMenuContent align="end"><DropdownMenuGroup><DropdownMenuItem disabled={offline} onSelect={()=>requestCleanup('task',t)}>删除聊天</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
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
              {data.devices.some((d) => !d.revoked)
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
        <HistoryCleanup transport={transport} selection={cleanupSelection} onClose={()=>setCleanupSelection(null)} onAccepted={cleanupAccepted}/>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 md:px-6">
          <SidebarTrigger />
          <BrandMark className="w-6 md:hidden" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-medium">
              {page === "settings"
                ? "设置"
                : page === "runs"
                  ? "运行记录"
                  : (task?.title ?? "新任务")}
            </h1>
            {task && page === "tasks" && (
              <p className="truncate text-xs text-muted-foreground">
                {scheduleLabel(task.schedule)}
              </p>
            )}
          </div>
          {task && page === "tasks" && (
            <>
              <Status value={activeRun?.status ?? run?.status ?? task.status} outcome={(activeRun ?? run)?.result?.outcome} />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="任务操作">
                    <Ellipsis data-icon="inline-start" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onCloseAutoFocus={(event) => {
                  if (focusComposer.current) {
                    event.preventDefault();
                    focusComposer.current = false;
                    document.querySelector<HTMLTextAreaElement>('[aria-label="消息"]')?.focus();
                  }
                }}>
                  <DropdownMenuGroup>
                    <DropdownMenuItem onSelect={() => setDetail(true)}>
                      任务详情与历史
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={offline}
                      onSelect={() => { setDetail(false); focusComposer.current = true; }}
                    >
                      调整任务
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={offline || busy || !!activeRun}
                      onSelect={() =>
                        void act(()=>createApi(transport).api.user.tasks[':id'].run.$post({param:{id:task.id},json:{requestId:crypto.randomUUID()}}))
                      }
                    >
                      立即运行
                    </DropdownMenuItem>
                    {task.confirmedCondition && <>
                    <DropdownMenuItem
                      disabled={offline || busy}
                      onSelect={() =>
                        void act(()=>createApi(transport).api.user.tasks[':id'].state.$post({param:{id:task.id},json:{enabled:task.status!=='active'}}))
                      }
                    >
                      {task.status === "active" ? "暂停调度" : "启用调度"}
                    </DropdownMenuItem>
                    </>}
                    <DropdownMenuItem disabled={offline} onSelect={()=>requestCleanup('clear',task)}>清空当前聊天</DropdownMenuItem>
                    <DropdownMenuItem disabled={offline} onSelect={()=>requestCleanup('task',task)}>删除聊天</DropdownMenuItem>
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
            <Button variant="outline" size="sm" disabled={refreshing} onClick={() => void refresh()}>
              {refreshing ? "正在重新连接…" : "重新连接"}
            </Button>

          </div>
        )}
        {actionError && (
          <div className="px-4 py-2">
            <ErrorText error={actionError} />
          </div>
        )}
        <PairingNotice transport={transport} refresh={refresh} />
        {pending.length > 0 &&
          !(task && pending.some((c) => c.taskId === task.id)) && (
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
                    <Status value={r.status} outcome={r.result?.outcome} />
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
        ) : !task ? (
          <TaskCompose
            key={draftKey}
            transport={transport}
            snapshot={data}
            offline={offline}
            onSettings={() => setPage("settings")}
            onSaved={async (id) => {
              await refresh();
              choose(id);
            }}
          />
        ) : (
          <Conversation
            key={`${task.id}:${chatEpoch}`}
            transport={transport}
            task={task}
            run={activeRun}
            runs={taskRuns}
            refresh={refresh}
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
                    {formatDate(r.createdAt)} · <Status value={r.status} outcome={r.result?.outcome} />
                  </Button>
                ))}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
