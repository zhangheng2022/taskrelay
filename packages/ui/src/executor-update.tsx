import { useState } from "react";
import type { Transport } from "../../contracts/src/index";
import type { DesktopUpdateStatus } from "../../contracts/src/updates";
import { Button } from "./components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./components/ui/card";
import { ErrorText } from "./feedback";

export function ExecutorUpdate({
  version,
  update,
  executor,
}: {
  version: string;
  update: DesktopUpdateStatus;
  executor: NonNullable<Transport["desktop"]>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const messages: Record<DesktopUpdateStatus["phase"], string> = {
    unsupported: "安装版执行器支持自动更新；开发或解压运行时不可用。",
    idle: "实时检查新版本，自动下载，空闲后安装并重启。",
    checking: "正在检查新版本…",
    unpublished: "更新通道尚未发布版本。",
    current: "当前已是最新版本。",
    available: `发现新版本 ${update.release?.version ?? ""}，即将自动下载`,
    downloading: `正在下载更新 ${update.progress ?? 0}%`,
    waiting: "下载完成，已暂停领取新任务。等待当前任务、人工协助和结果回传结束后自动安装。",
    installing: "正在安装更新，随后自动重启…",
    error: update.error ?? "更新失败，请重试。",
  };
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch {
      setError("操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }
  const locked =
    busy ||
    ["unsupported", "checking", "downloading", "waiting", "installing"].includes(update.phase);
  if (["idle", "checking", "current", "unpublished", "unsupported"].includes(update.phase))
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">版本 {version}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={() => void act(() => executor.checkUpdate())}
          >
            检查更新
          </Button>
        </div>
        {update.phase !== "idle" && (
          <p role="status" className="text-xs text-muted-foreground">
            {messages[update.phase]}
          </p>
        )}
        {error && <ErrorText error={error} />}
      </div>
    );
  return (
    <Card className="shrink-0 gap-3 py-4">
      <CardHeader>
        <CardTitle>版本更新</CardTitle>
        <CardDescription>当前版本 {version}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p role="status" aria-live="polite" className="text-sm">
          {messages[update.phase]}
        </p>
        {update.release?.notes && (
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {update.release.notes}
          </p>
        )}
        {update.phase === "error" && update.release && (
          <p className="text-sm text-muted-foreground">更新失败后将自动重试，也可立即重试。</p>
        )}
        {error && <ErrorText error={error} />}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={locked}
          onClick={() => void act(() => executor.checkUpdate())}
        >
          检查更新
        </Button>
        {update.phase === "error" && update.release && (
          <Button
            disabled={busy}
            onClick={() => void act(() => executor.downloadUpdate(update.release!.version))}
          >
            立即重试
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
