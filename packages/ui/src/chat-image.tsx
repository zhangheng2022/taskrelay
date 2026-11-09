/** 聊天图片显示与预览：缩略图沿用宿主鉴权地址；每个会话仅持有当前原图的内存 URL。
 * 切图、移除附件或离开会话会中止请求并释放原图；不写磁盘缓存、不经过聊天 JSON。
 * 网络完成与图片解码分别驱动 Loading，旧请求不能覆盖新选择。 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog";
import { Attachment, AttachmentMedia } from "./components/ui/attachment";
import { Button } from "./components/ui/button";
import { Skeleton } from "./components/ui/skeleton";
import { Spinner } from "./components/ui/spinner";

type Picture = { src: string; thumbnail?: string; alt: string; trigger: HTMLButtonElement };
type Preview = { show: (picture: Picture) => void; remove: (src: string) => void };
export const ImagePreviewContext = createContext<Preview | null>(null);

function ImageLoading({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2"
    >
      <Spinner role="presentation" aria-label={undefined} aria-hidden="true" />
      <span className="rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

function usePreviewImage(src: string) {
  const [attempt, setAttempt] = useState(0);
  const [resource, setResource] = useState<{ url?: string; error?: boolean }>({});
  const [decoded, setDecoded] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setResource({});
    setDecoded(false);
    (async () => {
      const response = await fetch(src, {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok || !response.headers.get("content-type")?.startsWith("image/"))
        throw Error("IMAGE_UNAVAILABLE");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setResource({ url });
    })().catch(() => {
      if (!controller.signal.aborted) setResource({ error: true });
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [src, attempt]);
  return {
    resource,
    decoded,
    setDecoded,
    fail: () => setResource({ error: true }),
    retry: () => {
      setResource({});
      setDecoded(false);
      setAttempt((value) => value + 1);
    },
  };
}

function PreviewImage({
  picture,
  image,
}: {
  picture: Picture;
  image: ReturnType<typeof usePreviewImage>;
}) {
  const { resource, decoded, setDecoded, fail, retry } = image;
  return (
    <div
      className="relative h-[min(65vh,40rem)] w-full overflow-hidden rounded-lg"
      aria-busy={!decoded && !resource.error}
    >
      {!decoded && !resource.error && (
        <Skeleton className="absolute inset-0 size-full" aria-hidden="true" />
      )}
      {!decoded && picture.thumbnail && (
        <img
          src={picture.thumbnail}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 size-full object-contain"
        />
      )}
      {resource.url && (
        <img
          src={resource.url}
          alt={picture.alt}
          decoding="async"
          className="absolute inset-0 size-full object-contain"
          onLoad={() => setDecoded(true)}
          onError={fail}
        />
      )}
      {resource.error ? (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/90"
          role="alert"
        >
          <p>原图加载失败或已不可用。</p>
          <Button variant="outline" onClick={retry}>
            重新加载原图
          </Button>
        </div>
      ) : (
        !decoded && <ImageLoading label="正在加载原图…" />
      )}
    </div>
  );
}

export function ImagePreviewProvider({ children }: { children: ReactNode }) {
  const [picture, setPicture] = useState<Picture | null>(null);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const show = useCallback((next: Picture) => {
    trigger.current = next.trigger;
    setPicture(next);
    setOpen(true);
  }, []);
  const remove = useCallback(
    (src: string) => setPicture((previous) => (previous?.src === src ? null : previous)),
    [],
  );
  // 保留一份预览资源而非 forceMount 弹窗：关闭时不保留焦点陷阱或滚动锁。
  return (
    <ImagePreviewContext.Provider value={{ show, remove }}>
      {children}
      {picture && (
        <PreviewResource
          key={picture.src}
          picture={picture}
          open={open}
          setOpen={setOpen}
          trigger={trigger}
        />
      )}
    </ImagePreviewContext.Provider>
  );
}

function PreviewResource({
  picture,
  open,
  setOpen,
  trigger,
}: {
  picture: Picture;
  open: boolean;
  setOpen: (open: boolean) => void;
  trigger: React.RefObject<HTMLButtonElement | null>;
}) {
  // 原图由此层持有；弹窗卸载后仍可复用同一 Blob，切换图片时整个资源组件卸载。
  const image = usePreviewImage(picture.src);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        aria-describedby={undefined}
        className="max-w-[95vw] sm:max-w-5xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          trigger.current?.focus();
        }}
      >
        <DialogTitle>{picture.alt}</DialogTitle>
        <PreviewImage picture={picture} image={image} />
      </DialogContent>
    </Dialog>
  );
}

export function ChatImage({
  src,
  thumbnail,
  alt,
}: {
  src?: string;
  thumbnail?: string;
  alt: string;
}) {
  const preview = useContext(ImagePreviewContext);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"processing" | "done" | "error">(src ? "processing" : "error");
  const remove = preview?.remove;
  useEffect(
    () => () => {
      if (src) remove?.(src);
    },
    [src, remove],
  );
  return (
    <Attachment
      orientation="vertical"
      state={state}
      aria-busy={state === "processing"}
      className="w-80 max-w-full"
    >
      <Button
        variant="ghost"
        disabled={!src}
        className="relative h-auto w-full p-0"
        aria-label="查看完整截图"
        onClick={(event) => {
          if (src)
            preview?.show({
              src,
              thumbnail: state === "done" ? (thumbnail ?? src) : undefined,
              alt,
              trigger: event.currentTarget,
            });
        }}
      >
        <AttachmentMedia
          variant="image"
          className="aspect-video w-full [&_img]:aspect-auto [&_img]:h-full [&_img]:object-contain"
        >
          {state === "processing" && (
            <Skeleton className="absolute inset-0 size-full" aria-hidden="true" />
          )}
          {state !== "error" && (
            <img
              key={attempt}
              src={thumbnail ?? src}
              alt={alt}
              width={640}
              height={360}
              loading="lazy"
              decoding="async"
              className="relative max-w-full"
              onLoad={() => setState("done")}
              onError={() => setState("error")}
            />
          )}
        </AttachmentMedia>
        {state === "processing" && <ImageLoading label="正在加载图片…" />}
        {state === "error" && (
          <span className="absolute inset-0 flex items-center justify-center whitespace-normal p-3 text-xs">
            {src ? "缩略图不可用，点击查看原图" : "图片已不可用"}
          </span>
        )}
      </Button>
      {state === "error" && src && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setAttempt((value) => value + 1);
            setState("processing");
          }}
        >
          重新加载图片
        </Button>
      )}
    </Attachment>
  );
}
