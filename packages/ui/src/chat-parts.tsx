import type { ReactNode } from "react";
import { ArrowUp, Loader2 } from "lucide-react";
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
} from "./components/ui/message-scroller";
import { Marker, MarkerIcon, MarkerContent } from "./components/ui/marker";

export function Thread({ children }: { children: ReactNode }) {
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto max-w-3xl px-4 py-8 md:px-8">
            {children}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton aria-label="回到最新消息" />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
export function ChatMessage({
  role,
  children,
}: {
  role: string;
  children: ReactNode;
}) {
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
          <div className="whitespace-pre-wrap break-words text-sm leading-7">
            {children}
          </div>
        )}
      </MessageContent>
    </Message>
  );
}
export function PendingMessage({ children }: { children: ReactNode }) {
  return (
    <Marker role="status">
      <MarkerIcon>
        <Loader2 className="animate-spin" />
      </MarkerIcon>
      <MarkerContent>{children}</MarkerContent>
    </Marker>
  );
}
// 新交办和既有聊天共用发送回显。确认后由服务端消息替换，失败后原文回到输入框重试。
export function SendingMessage({message}:{message:{id:string;content:string}|null}){
  if(!message)return null;
  return <>
    <MessageScrollerItem messageId={message.id} scrollAnchor><ChatMessage role="user">{message.content}</ChatMessage></MessageScrollerItem>
    <MessageScrollerItem messageId={`${message.id}_status`}><PendingMessage>正在发送…</PendingMessage></MessageScrollerItem>
  </>;
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
