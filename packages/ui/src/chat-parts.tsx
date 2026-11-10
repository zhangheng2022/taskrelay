import { ImagePreviewProvider } from "./chat-image";
import { useLayoutEffect, type ReactNode } from "react";
import { ArrowUp, Loader2, CirclePause } from "lucide-react";
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
        {draft.content}
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
          <div className="whitespace-pre-wrap break-words text-sm leading-7">{children}</div>
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
export function SendingMessage({ message }: { message: { id: string; content: string } | null }) {
  if (!message) return null;
  return (
    <MessageScrollerItem messageId={message.id}>
      <ChatMessage speaker="user">{message.content}</ChatMessage>
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
  children,
}: {
  text: string;
  setText: (value: string) => void;
  onSend: () => void;
  busy: boolean;
  disabled?: boolean;
  placeholder: string;
  label?: string;
  maxLength?: number;
  children?: ReactNode;
}) {
  return (
    <form
      aria-busy={busy}
      className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4 pt-2 md:px-8"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() && !busy && !disabled) onSend();
      }}
    >
      <InputGroup>
        <InputGroupTextarea
          aria-label={label}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          rows={2}
          maxLength={maxLength}
          readOnly={busy}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
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
          {children}
          <span className="ml-auto" />
          <InputGroupButton
            type="submit"
            size="icon-sm"
            variant="default"
            aria-label="发送消息"
            disabled={busy || disabled || !text.trim()}
          >
            {busy ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <ArrowUp data-icon="inline-start" />
            )}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <p className="mt-2 text-center text-xs text-muted-foreground">
        Enter 发送 · Shift + Enter 换行
      </p>
    </form>
  );
}
