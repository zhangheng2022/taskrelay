import { Disclosure } from "./disclosure";
import { useContext } from "react";
import type { ChatPart } from "../../contracts/src/execution";
import type { Transport } from "../../contracts/src/index";
import { AccountCard } from "./account-card";
import { ChatImage, ImagePreviewContext, ImagePreviewProvider } from "./chat-image";

// 正常聊天共用 Thread 的单图预览；独立附件宿主也具备相同的资源生命周期。
export function ChatAttachments(props: Parameters<typeof Attachments>[0]) {
  const preview = useContext(ImagePreviewContext);
  return preview ? (
    <Attachments {...props} />
  ) : (
    <ImagePreviewProvider>
      <Attachments {...props} />
    </ImagePreviewProvider>
  );
}
function Attachments({
  parts,
  transport,
  offline,
  onAccountSaved,
}: {
  parts: ChatPart[];
  transport: Transport;
  offline?: boolean;
  onAccountSaved?: () => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-2">
      {parts.map((p, i) => {
        if (p.type === "image") {
          const src = transport.artifactUrl?.(p.artifactId);
          const thumbnail = transport.artifactUrl?.(p.artifactId, "thumbnail");
          return (
            <ChatImage
              key={`${p.artifactId}:${src ?? ""}:${thumbnail ?? ""}`}
              src={src}
              thumbnail={thumbnail}
              alt={p.alt}
            />
          );
        }
        return p.type === "account-card" ? (
          <AccountCard
            key={p.cardId}
            id={p.cardId}
            transport={transport}
            offline={offline}
            onSaved={onAccountSaved}
          />
        ) : (
          <Disclosure key={i} label="操作反馈" className="text-xs text-muted-foreground">
            <p className="whitespace-pre-wrap break-words">{p.result}</p>
          </Disclosure>
        );
      })}
    </div>
  );
}
