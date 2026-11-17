import { ImagePreviewProvider } from "./chat-image";
import { Spinner } from "./components/ui/spinner";
import { ChatMarkdown } from "./chat-markdown";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Loader2, CirclePause, Paperclip, Square } from "lucide-react";
import { attachmentAccept, type AttachmentCapabilities } from "../../contracts/src/attachments";
import {
  addAttachmentFiles,
  ComposeAttachmentList,
  draftAttachmentError,
} from "./compose-attachments";
import { ErrorText } from "./feedback";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "./components/ui/input-group";
import { Message, MessageContent } from "./components/ui/message";
import { Bubble, BubbleContent } from "./components/ui/bubble";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerButton,
  MessageScrollerItem,
  useMessageScroller,
} from "./components/ui/message-scroller";
import { Marker, MarkerIcon, MarkerContent } from "./components/ui/marker";
import type { ChatDraft } from "../../contracts/src/streaming";

/** 草稿是实时正文预览，不是正式历史；滚动仍交给 MessageScroller。 */
export function DraftMessages({ drafts = [] }: { drafts?: ChatDraft[] }) {
  return drafts.map((draft) => (
    <MessageScrollerItem key={draft.id} messageId={draft.id} deferRendering={false}>
      <ChatMessage speaker="assistant">
        <div className="text-xs text-muted-foreground">
          {draft.source === "executor" ? "执行器" : "云端助手"} ·{" "}
          {draft.status === "interrupted"
            ? "生成中断，内容未完成"
            : draft.status === "pending"
              ? "正在确认回复…"
              : "生成中…"}
        </div>
        <ChatMarkdown content={draft.content} status={draft.status} />
      </ChatMessage>
    </MessageScrollerItem>
  ));
}

// 普通更新由官方组件跟随底部或保留上翻位置；只有本地发送请求才主动回到最新。
// 不将历史用户行设为 turn anchor，避免同数量节点替换重新定位到旧问题。
function FollowSend({ request }: { request?: string }) {
  const { scrollToEnd } = useMessageScroller();
  useLayoutEffect(() => {
    if (request) scrollToEnd({ behavior: "auto" });
  }, [request, scrollToEnd]);
  return null;
}
export function Thread({
  children,
  followRequest,
}: {
  children: ReactNode;
  followRequest?: string;
}) {
  return (
    <ImagePreviewProvider>
      <MessageScrollerProvider autoScroll>
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto max-w-3xl px-4 py-8 md:px-8">
              {children}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton aria-label="回到最新消息" />
        </MessageScroller>
        <FollowSend request={followRequest} />
      </MessageScrollerProvider>
    </ImagePreviewProvider>
  );
}
export function ChatMessage({ speaker: role, children }: { speaker: string; children: ReactNode }) {
  return (
    <Message align={role === "user" ? "end" : "start"}>
      <MessageContent>
        {role === "user" ? (
          <Bubble variant="muted" align="end">
            <BubbleContent>
              <div className="whitespace-pre-wrap break-words">{children}</div>
            </BubbleContent>
          </Bubble>
        ) : (
          <div className="min-w-0 break-words text-sm leading-7">{children}</div>
        )}
      </MessageContent>
    </Message>
  );
}
export function PendingMessage({
  children,
  paused = false,
}: {
  children: ReactNode;
  paused?: boolean;
}) {
  return (
    <Marker role="status">
      <MarkerIcon>
        {paused ? (
          <CirclePause />
        ) : (
          <span className="chat-status-spinner block size-full animate-spin">
            <Loader2 />
          </span>
        )}
      </MarkerIcon>
      <MarkerContent>{children}</MarkerContent>
    </Marker>
  );
}
// 状态复用同一个 DOM 行，发送→推理时不重启动画；持续渲染避开 WebKit 离屏动画恢复缺陷。
export function ThreadActivity({
  children,
  offline,
  error,
  paused = false,
}: {
  children: ReactNode;
  offline: boolean;
  error: string;
  paused?: boolean;
}) {
  if (!children) return null;
  const interrupted = offline || !!error || paused;
  let content = children;
  if (offline) content = "连接已中断，等待恢复后更新状态";
  else if (error) content = "状态更新失败，请重试";
  return (
    <MessageScrollerItem messageId="activity" deferRendering={false}>
      <PendingMessage paused={interrupted}>{content}</PendingMessage>
    </MessageScrollerItem>
  );
}
// 新交办和既有聊天共用发送回显。确认后由服务端消息替换，失败后原文回到输入框重试。
export function SendingMessage({
  message,
}: {
  message: { id: string; content: string; filenames?: string[] } | null;
}) {
  if (!message) return null;
  return (
    <MessageScrollerItem messageId={message.id}>
      <ChatMessage speaker="user">
        {message.content}
        {message.filenames?.length ? (
          <div className="break-all text-sm">{message.filenames.join("、")}</div>
        ) : null}
      </ChatMessage>
    </MessageScrollerItem>
  );
}
export function Composer({
  text,
  setText,
  onSend,
  busy,
  disabled,
  placeholder,
  label = "消息",
  maxLength = 6000,
  modelControls,
  children,
  attachments,
  stop,
}: {
  text: string;
  setText: (value: string) => void;
  onSend: () => void;
  busy: boolean;
  disabled?: boolean;
  placeholder: string;
  label?: string;
  maxLength?: number;
  modelControls?: ReactNode;
  children?: ReactNode;
  attachments?: {
    files: readonly File[];
    setFiles: (files: File[]) => void;
    caps: AttachmentCapabilities;
  };
  stop?: { onStop: () => void; pending: boolean; disabled?: boolean };
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState("");
  const hasDraft = !!text.trim() || !!attachments?.files.length;
  const showStop = !!stop && (!hasDraft || stop.pending) && !busy;
  const capabilityError = attachments && draftAttachmentError(attachments.files, attachments.caps);
  const inputLocked = !!disabled || busy || !!stop?.pending;
  function add(files: File[]) {
    if (!attachments || inputLocked || !files.length) return;
    const result = addAttachmentFiles(attachments.files, files);
    attachments.setFiles(result.files);
    setFileError(result.error);
  }
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- 拖放是附件选择器的可选入口；键盘使用添加附件按钮。
    <form
      aria-busy={busy}
      className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4 pt-2 md:px-8"
      onSubmit={(e) => {
        e.preventDefault();
        if (hasDraft && !inputLocked && !capabilityError) {
          setFileError("");
          onSend();
        }
      }}
      onDragOver={(e) => {
        if (attachments && e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!attachments || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        add(Array.from(e.dataTransfer.files));
      }}
    >
      <InputGroup className="rounded-2xl bg-muted">
        {!!attachments?.files.length && (
          <InputGroupAddon align="block-start" className="min-w-0">
            <ComposeAttachmentList
              files={attachments.files}
              disabled={busy || stop?.pending}
              onRemove={(index) => {
                attachments.setFiles(attachments.files.filter((_, i) => i !== index));
                setFileError("");
              }}
            />
          </InputGroupAddon>
        )}
        <InputGroupTextarea
          aria-label={label}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          rows={2}
          maxLength={maxLength}
          readOnly={busy || stop?.pending}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onPaste={(e) => {
            if (!attachments) return;
            const images = Array.from(e.clipboardData.files).filter((file) =>
              file.type.startsWith("image/"),
            );
            if (!images.length) return;
            if (!e.clipboardData.getData("text/plain")) e.preventDefault();
            add(images);
          }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <InputGroupAddon align="block-end" className="flex-wrap">
          {attachments && (
            <>
              <input
                ref={fileInput}
                type="file"
                multiple
                accept={attachmentAccept}
                hidden
                aria-label="选择附件文件"
                onChange={(e) => {
                  add(Array.from(e.currentTarget.files ?? []));
                  e.currentTarget.value = "";
                }}
              />
              <InputGroupButton
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="添加附件"
                title="添加附件"
                disabled={inputLocked}
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip aria-hidden="true" />
              </InputGroupButton>
            </>
          )}
          {children}
          <div className="ml-auto flex min-w-0 max-w-full items-center justify-end gap-2">
            {modelControls}
            <InputGroupButton
              type={showStop ? "button" : "submit"}
              size="icon-sm"
              variant="default"
              className="shrink-0 rounded-full"
              aria-label={showStop ? (stop.pending ? "正在停止执行" : "停止执行") : "发送消息"}
              title={showStop ? (stop.pending ? "正在停止执行" : "停止执行") : "发送消息"}
              onClick={showStop ? stop.onStop : undefined}
              disabled={
                showStop
                  ? stop.disabled || stop.pending
                  : inputLocked || !hasDraft || !!capabilityError
              }
            >
              {busy || (showStop && stop.pending) ? (
                <Spinner aria-hidden="true" data-icon="inline-start" />
              ) : showStop ? (
                <Square data-icon="inline-start" aria-hidden="true" className="fill-current" />
              ) : (
                <ArrowUp data-icon="inline-start" />
              )}
            </InputGroupButton>
          </div>
        </InputGroupAddon>
      </InputGroup>
      {(capabilityError || fileError) && <ErrorText error={capabilityError || fileError} />}
      <p className="mt-2 text-center text-xs text-muted-foreground">
        Enter 发送 · Shift + Enter 换行
      </p>
    </form>
  );
}
