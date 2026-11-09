/** 隔离浏览器夹具：使用正式聊天组件和 Web Transport，服务端只返回合成图片。 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Thread, ChatMessage } from "../../packages/ui/src/chat-parts";
import { MessageScrollerItem } from "../../packages/ui/src/components/ui/message-scroller";
import { ChatAttachments } from "../../packages/ui/src/chat-attachments";
import { createWebTransport } from "../../apps/web/src/transport";
import "../../packages/ui/src/styles.css";

const transport = createWebTransport();
function Images() {
  const [image, setImage] = useState("one");
  const [epoch, setEpoch] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [history, setHistory] = useState(false);
  const [visible, setVisible] = useState(true);
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="flex shrink-0 flex-wrap gap-2 p-2">
        <button id="refresh" onClick={() => setRefresh((value) => value + 1)}>
          刷新消息 {refresh}
        </button>
        <button id="switch" onClick={() => setImage((value) => `${value}-next`)}>
          切换图片
        </button>
        <button id="remove" onClick={() => setVisible(false)}>
          删除图片
        </button>
        <button
          id="thread"
          onClick={() => {
            setEpoch((value) => value + 1);
            setVisible(true);
          }}
        >
          切换会话
        </button>
        <button id="history" onClick={() => setHistory(true)}>
          加载更早图片
        </button>
      </div>
      <Thread key={epoch}>
        {history &&
          Array.from({ length: 40 }, (_, i) => (
            <MessageScrollerItem key={i} messageId={`old-${i}`}>
              <ChatMessage speaker="assistant">
                <ChatAttachments
                  transport={transport}
                  parts={[{ type: "image", artifactId: `old-${i}`, alt: `历史截图 ${i}` }]}
                />
              </ChatMessage>
            </MessageScrollerItem>
          ))}
        <MessageScrollerItem messageId="current">
          <ChatMessage speaker="assistant">
            <p>图片加载验收</p>
            {visible && (
              <ChatAttachments
                transport={transport}
                parts={[{ type: "image", artifactId: image, alt: "执行截图" }]}
              />
            )}
          </ChatMessage>
        </MessageScrollerItem>
      </Thread>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Images />);
