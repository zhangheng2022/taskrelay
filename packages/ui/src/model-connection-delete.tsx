/** 服务删除确认：读取当前版本引用，显式确认后提交；冲突重新检查，不自动重放删除。 */
import { useEffect, useRef, useState } from "react";
import type { ModelConnection, Transport } from "../../contracts/src/index";
import type { connectionDeletionPreview } from "../../../apps/cloud/src/model-gateway";
import { createApi, rpcData } from "./api";
import { Button } from "./components/ui/button";
import { Spinner } from "./components/ui/spinner";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "./components/ui/alert-dialog";
import { ErrorText } from "./feedback";

type DeletionPreview = Awaited<ReturnType<typeof connectionDeletionPreview>>;

function readPreview(
  transport: Transport,
  id: string,
  signal: AbortSignal,
): Promise<DeletionPreview> {
  return rpcData(
    createApi(transport).api.admin["model-connections"][":id"].deletion.$get(
      { param: { id } },
      { init: { signal } },
    ),
  );
}

export function ModelConnectionDelete({
  connection,
  transport,
  onClose,
  onDeleted,
  restoreFocus,
}: {
  connection: ModelConnection;
  transport: Transport;
  onClose: () => void;
  onDeleted: () => Promise<void>;
  restoreFocus: (deleted: boolean) => void;
}) {
  const api = createApi(transport).api.admin["model-connections"][":id"];
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const deleted = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setPreview(null);
    setError("");
    void readPreview(transport, connection.id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPreview(value);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [connection.id, transport, attempt]);

  async function remove() {
    if (lock.current || !preview || preview.referenceCount > 0) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await rpcData(api.$delete({ param: { id: connection.id } }));
    } catch (e) {
      // 即使预览曾允许删除，失败后也须重新检查，不能直接重发旧确认。
      setPreview(null);
      setError((e as Error).message);
      return;
    } finally {
      lock.current = false;
      setBusy(false);
    }
    deleted.current = true;
    await onDeleted();
  }

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !lock.current) onClose();
      }}
    >
      <AlertDialogContent
        className="max-h-[85dvh] overflow-y-auto"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus(deleted.current);
        }}
        onEscapeKeyDown={(event) => {
          if (lock.current) event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>删除服务？</AlertDialogTitle>
          <AlertDialogDescription className="break-all">
            将永久删除“{preview?.name ?? connection.name}”在 TaskRelay 中的连接配置，无法撤销。
            Cloudflare 中的密钥、网关和自定义提供方配置会保留。
          </AlertDialogDescription>
        </AlertDialogHeader>
        {!preview && !error && (
          <p role="status">
            <Spinner /> 正在检查关联模型…
          </p>
        )}
        {preview &&
          (preview.referenceCount ? (
            <div className="flex min-w-0 flex-col gap-2">
              <p role="status">暂不能删除：仍有 {preview.referenceCount} 个模型版本引用此服务。</p>
              <ul className="flex max-h-48 list-disc flex-col gap-1 overflow-y-auto pl-5">
                {preview.references.map((reference) => (
                  <li className="break-all" key={`${reference.modelId}:${reference.version}`}>
                    {reference.name} · v{reference.version}
                  </li>
                ))}
              </ul>
              {preview.referenceCount > preview.references.length && (
                <p>仅展示前 {preview.references.length} 个版本。</p>
              )}
              <p>请先在模型列表删除关联模型配置；停用模型仍会保留引用。</p>
            </div>
          ) : (
            <p role="status">没有模型版本引用，可以删除。</p>
          ))}
        {error && <ErrorText error={error} />}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          {(error || (preview && preview.referenceCount > 0)) && (
            <Button variant="outline" disabled={busy} onClick={() => setAttempt((n) => n + 1)}>
              重新检查
            </Button>
          )}
          <Button
            variant="destructive"
            disabled={busy || !preview || preview.referenceCount > 0}
            onClick={() => void remove()}
          >
            {busy ? (
              <>
                <Spinner /> 正在删除…
              </>
            ) : (
              "永久删除服务"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
