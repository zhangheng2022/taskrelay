import { useEffect, useRef } from "react";
import { FileText, X } from "lucide-react";
import {
  attachmentCapabilityError,
  attachmentLimits,
  attachmentMime,
  attachmentSizeLimit,
  type AttachmentCapabilities,
} from "../../contracts/src/attachments";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "./components/ui/attachment";

/** 草稿只持有本地 File。预览只为已挂载的缩略图创建和释放 blob URL。 */
export function addAttachmentFiles(current: readonly File[], files: readonly File[]) {
  const next = [...current];
  let total = next.reduce((sum, file) => sum + file.size, 0);
  let error = "";
  for (const file of files) {
    const mime = attachmentMime(file.name);
    if (!mime || file.name.length > attachmentLimits.name || /[\p{Cc}\p{Cf}\\/]/u.test(file.name))
      error ||= "ATTACHMENT_FORMAT_INVALID";
    else if (next.length >= attachmentLimits.count) error ||= "ATTACHMENT_COUNT";
    else if (
      !file.size ||
      file.size > attachmentSizeLimit(mime) ||
      total + file.size > attachmentLimits.total
    )
      error ||= "ATTACHMENT_SIZE";
    else {
      next.push(file);
      total += file.size;
    }
  }
  return { files: next, error };
}

export function draftAttachmentError(files: readonly File[], caps: AttachmentCapabilities) {
  for (const file of files) {
    const mime = attachmentMime(file.name);
    if (!mime) return "ATTACHMENT_FORMAT_INVALID";
    const error = attachmentCapabilityError(mime, caps);
    if (error) return error;
  }
  return null;
}

export function attachmentSizeLabel(bytes: number) {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${+(bytes / 1_000).toFixed(1)} KB`;
  return `${+(bytes / 1_000_000).toFixed(2)} MB`;
}

function DraftImage({ file }: { file: File }) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img = ref.current;
    if (!img || typeof window.URL.createObjectURL !== "function") return;
    const url = window.URL.createObjectURL(file);
    img.src = url;
    return () => {
      img.removeAttribute("src");
      window.URL.revokeObjectURL(url);
    };
  }, [file]);
  return <img ref={ref} alt="" />;
}

export function ComposeAttachmentList({
  files,
  disabled,
  onRemove,
}: {
  files: readonly File[];
  disabled?: boolean;
  onRemove: (index: number) => void;
}) {
  return (
    <AttachmentGroup className="w-full" aria-label="待发送附件">
      {files.map((file, index) => {
        const image = attachmentMime(file.name)?.startsWith("image/");
        return (
          <Attachment
            key={`${file.name}:${file.lastModified}:${file.size}:${index}`}
            size="sm"
            state="idle"
            className="w-48"
          >
            <AttachmentMedia variant={image ? "image" : "icon"}>
              {image ? <DraftImage file={file} /> : <FileText aria-hidden="true" />}
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle title={file.name}>{file.name}</AttachmentTitle>
              <AttachmentDescription>{attachmentSizeLabel(file.size)}</AttachmentDescription>
            </AttachmentContent>
            <AttachmentActions>
              <AttachmentAction
                type="button"
                disabled={disabled}
                onClick={() => onRemove(index)}
                aria-label={`移除 ${file.name}`}
              >
                <X aria-hidden="true" />
              </AttachmentAction>
            </AttachmentActions>
          </Attachment>
        );
      })}
    </AttachmentGroup>
  );
}
