import { useEffect, useState } from "react";
import type { Transport } from "../../contracts/src/index";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Switch } from "./components/ui/switch";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./components/ui/card";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldGroup,
  FieldContent,
} from "./components/ui/field";
import { ErrorText, LoadingState } from "./feedback";
import { BrandMark } from "./brand-mark";
import { ExecutorUpdate } from "./executor-update";
import { QueryBoundary, useTransportQuery } from "./queries";
// Windows 状态窗口仅通过命名接口管理连接、领取开关、停止与更新；任务和聊天留在网站。
// 本机状态与云端在线状态分别展示，因此断网时仍可停止正在执行的任务。
export function ExecutorApp({ executor }: { executor: NonNullable<Transport["desktop"]> }) {
  return (
    <QueryBoundary owner={executor}>
      <ExecutorStatus executor={executor} />
    </QueryBoundary>
  );
}
function ExecutorStatus({ executor }: { executor: NonNullable<Transport["desktop"]> }) {
  const query = useTransportQuery(executor, ["executor-status"], () => executor.status(), 5000);
  const status = query.data ?? null,
    loadError = query.error?.message ?? "",
    refresh = query.refresh;
  const [url, setUrl] = useState(""),
    [pair, setPair] = useState<{ code: string } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState("");
  useEffect(() => {
    if (status) setUrl((v) => v || status.cloudUrl);
  }, [status?.cloudUrl]);
  useEffect(() => {
    if (!pair) return;
    let live = true;
    const timer = setInterval(() => {
      void executor
        .pairPoll()
        .then((done) => {
          if (live && done) {
            setPair(null);
            void refresh();
          }
        })
        .catch((e) => {
          if (live) {
            setError(e.message);
            setPair(null);
          }
        });
    }, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pair, executor, refresh]);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const showUpdateFirst =
    !!status &&
    ["available", "downloading", "waiting", "installing", "error"].includes(status.update.phase);
  return (
    <main className="flex h-dvh flex-col gap-3 overflow-y-auto p-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {status && showUpdateFirst && (
        <ExecutorUpdate version={status.version} update={status.update} executor={executor} />
      )}
      <Card className="shrink-0 gap-4 py-5">
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            <BrandMark />
            TaskRelay 执行器
          </CardTitle>
          <CardDescription>接收云端任务，执行并回传结果。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!status && !loadError && <LoadingState label="正在读取执行器状态…" />}
          {loadError && <ErrorText error={loadError} />}
          {status && (
            <p role="status">
              {!status.paired
                ? "尚未连接"
                : !status.online
                  ? status.activeRunId
                    ? "连接中断，本机仍在执行"
                    : "暂时无法连接云端"
                  : status.activeRunId
                    ? "正在执行"
                    : status.paused
                      ? "已暂停领取"
                      : "在线，等待任务"}
            </p>
          )}
          {status?.paired && !status.online && (
            <p className="text-sm text-muted-foreground">
              正在自动重连，暂不领取新任务。可查看本机状态或停止当前执行；结果待连接恢复后回传。
            </p>
          )}
          {status?.activeRunId && (
            <p className="break-all text-sm text-muted-foreground">
              运行编号：{status.activeRunId}
            </p>
          )}
          {status?.error && <ErrorText error={status.error} />}
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="executor-url">工作空间地址</FieldLabel>
              <Input
                id="executor-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={busy || !!status?.activeRunId}
              />
              <FieldDescription>由管理员在网站授权设备进入公共池。</FieldDescription>
            </Field>
            <Button
              disabled={busy || !status || !!status.activeRunId || !!pair}
              onClick={() => void act(async () => setPair(await executor.configure(url)))}
            >
              {busy ? "正在处理…" : "在浏览器中授权设备"}
            </Button>
            {pair && (
              <p role="status">
                请在浏览器核对校验码：<strong>{pair.code}</strong>
              </p>
            )}
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="executor-paused">暂停领取新任务</FieldLabel>
                <FieldDescription>已开始的任务继续执行。</FieldDescription>
              </FieldContent>
              <Switch
                id="executor-paused"
                checked={status?.paused ?? false}
                disabled={busy || !status}
                onCheckedChange={(v) => void act(() => executor.pause(v))}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="executor-startup">登录 Windows 时启动</FieldLabel>
              <Switch
                id="executor-startup"
                checked={status?.autoStart ?? false}
                disabled={busy || !status}
                onCheckedChange={(v) => void act(() => executor.autoStart(v))}
              />
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy || !status?.activeRunId}
            onClick={() => void act(() => executor.stop())}
          >
            停止当前执行
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void act(async () => setNote(await executor.diagnostics()))}
          >
            导出诊断
          </Button>
        </CardFooter>
      </Card>
      {error && <ErrorText error={error} />}
      {note && (
        <p role="status" className="break-all text-sm">
          {note}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        任务配置和人工协助请在网站完成。关闭窗口后继续在托盘运行；通过托盘菜单退出。
      </p>
      {status && !showUpdateFirst && (
        <ExecutorUpdate version={status.version} update={status.update} executor={executor} />
      )}
    </main>
  );
}
