import { Disclosure } from "./disclosure";
import { useContext } from "react";
import type { ChatPart } from "../../contracts/src/execution";
import type { Transport } from "../../contracts/src/index";
import { AccountCard } from "./account-card";
import { ChatImage, ImagePreviewContext, ImagePreviewProvider } from "./chat-image";
import type { ChatAttachment } from "../../contracts/src/attachments";
import { Download, FileText } from "lucide-react";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "./components/ui/attachment";
import { attachmentSizeLabel } from "./compose-attachments";

export function SentAttachments({
  files,
  threadId,
  transport,
}: {
  files?: ChatAttachment[];
  threadId?: string;
  transport: Transport;
}) {
  if (!files?.length || !threadId) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2" aria-label="消息附件">
      {files.map((file) => {
        const url = transport.attachmentUrl?.(threadId, file.id);
        const download = transport.attachmentUrl?.(threadId, file.id, true);
        return (
          <div key={file.id} className="flex min-w-0 flex-col gap-1">
            {file.mime.startsWith("image/") && url && (
              <ChatImage src={url} thumbnail={url} alt={file.name} />
            )}
            <Attachment size="sm">
              <AttachmentMedia>
                <FileText aria-hidden="true" />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle title={file.name}>{file.name}</AttachmentTitle>
                <AttachmentDescription>{attachmentSizeLabel(file.size)}</AttachmentDescription>
              </AttachmentContent>
              {download && (
                <AttachmentActions>
                  <AttachmentAction asChild>
                    <a href={download} download={file.name} aria-label={`下载 ${file.name}`}>
                      <Download aria-hidden="true" />
                    </a>
                  </AttachmentAction>
                </AttachmentActions>
              )}
            </Attachment>
          </div>
        );
      })}
    </div>
  );
}

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
