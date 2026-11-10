/** 隔离流式布局夹具：真实 hook 与聊天滚动组件，合成事件不会连接业务服务。 */
import { createRoot } from "react-dom/client";
import { Thread, ChatMessage, DraftMessages } from "../../packages/ui/src/chat-parts";
import { MessageScrollerItem } from "../../packages/ui/src/components/ui/message-scroller";
import { useThread } from "../../packages/ui/src/use-thread";
import type { ThreadPage } from "../../packages/contracts/src/conversation";
import type { Transport } from "../../packages/contracts/src/index";
import type { ChatDraft, DraftEvent } from "../../packages/contracts/src/streaming";
import "../../packages/ui/src/styles.css";
let emit: ((event: DraftEvent) => void) | undefined;
let changed: (() => void) | undefined;
const at = new Date().toISOString();
let page: ThreadPage = {
  id: "thread",
  modelId: "model",
  version: 0,
  partial: {},
  draft: null,
  activeTurn: "turn",
  nextCursor: null,
  messages: Array.from({ length: 40 }, (_, i) => ({
    id: `history-${i}`,
    seq: i + 1,
    role: "assistant",
    content: `历史消息 ${i + 1}\n已保存的任务说明。`,
    at,
  })),
  drafts: [],
};
let draft: ChatDraft = {
  id: "draft",
  threadId: "thread",
  callId: "call",
  version: 0,
  seq: 0,
  at,
  source: "cloud",
  content: "",
  status: "streaming",
};
const transport: Transport = {
  request: async <T,>(_method: string, path: string) =>
    structuredClone(
      path.split("?")[0] === "/api/user/threads"
        ? { items: [{ id: "thread", model_id: "model", task_id: null }] }
        : page,
    ) as T,
  subscribe: (fn) => {
    changed = fn;
    return () => {
      changed = undefined;
    };
  },
  subscribeDrafts: (fn) => {
    emit = fn;
    return () => {
      emit = undefined;
    };
  },
};
Object.assign(window, {
  streamFixture: {
    update(content: string) {
      draft = { ...draft, content, seq: draft.seq + 1 };
      page.drafts = [draft];
      emit?.({ protocol: 2, type: "draft.update", draft });
    },
    finish() {
      page = {
        ...page,
        version: 1,
        activeTurn: null,
        drafts: [],
        messages: [
          ...page.messages,
          {
            id: "final",
            source_call_id: "call",
            seq: 41,
            role: "assistant",
            content: draft.content,
            at,
          },
        ],
      };
      emit?.({
        protocol: 2,
        type: "draft.end",
        reason: "committed",
        draft: { ...draft, seq: draft.seq + 1 },
      });
      changed?.();
    },
    interrupt() {
      draft = { ...draft, status: "interrupted", seq: draft.seq + 1 };
      page.drafts = [draft];
      changed?.();
    },
  },
});
function Streaming() {
  const { page: current } = useThread(transport, "compose", "model");
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <Thread>
        {current?.messages.map((message) => (
          <MessageScrollerItem key={message.id} messageId={message.id}>
            <ChatMessage speaker={message.role}>{message.content}</ChatMessage>
          </MessageScrollerItem>
        ))}
        <DraftMessages drafts={current?.drafts} />
      </Thread>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Streaming />);
