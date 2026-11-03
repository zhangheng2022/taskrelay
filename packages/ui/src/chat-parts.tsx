import type { ReactNode } from "react";
import { ArrowUp, Loader2 } from "lucide-react";
import { Button } from "./components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
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
} from "./components/ui/message-scroller";

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
        <Bubble
          variant={role === "user" ? "default" : "ghost"}
          align={role === "user" ? "end" : "start"}
        >
          <BubbleContent>
            <div className="whitespace-pre-wrap break-words">{children}</div>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
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
  children,
}: {
  text: string;
  setText: (value: string) => void;
  onSend: () => void;
  busy: boolean;
  disabled?: boolean;
  placeholder: string;
  label?: string;
  children?: ReactNode;
}) {
  return (
    <form
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
          maxLength={6000}
          disabled={busy || disabled}
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
              if (text.trim() && !busy && !disabled) onSend();
            }
          }}
        />
        <InputGroupAddon align="block-end" className="flex-wrap">
          {children}
          <span className="ml-auto" />
          <Button
            type="submit"
            size="icon-sm"
            aria-label="发送消息"
            disabled={busy || disabled || !text.trim()}
          >
            {busy ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <ArrowUp data-icon="inline-start" />
            )}
          </Button>
        </InputGroupAddon>
      </InputGroup>
      <p className="mt-2 text-center text-xs text-muted-foreground">
        Enter 发送 · Shift + Enter 换行
      </p>
    </form>
  );
}
