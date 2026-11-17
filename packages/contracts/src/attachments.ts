/** 网站附件的公开元数据与发送限制；原件始终通过受鉴权的附件接口读取。 */
export const attachmentLimits = {
  count: 4,
  total: 2_000_000,
  image: 1_500_000,
  text: 16 * 1024,
  name: 120,
} as const;

const formats = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
} as const;

export type AttachmentMime = (typeof formats)[keyof typeof formats];
export type AttachmentCapabilities = { vision: boolean; pdf: boolean };
export type ChatAttachment = { id: string; name: string; mime: AttachmentMime; size: number };
export type AttachmentMessage = { requestId: string; content: string; files: readonly File[] };

export const attachmentAccept = Object.keys(formats)
  .map((extension) => "." + extension)
  .join(",");

export function attachmentMime(name: string): AttachmentMime | undefined {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return name.lastIndexOf(".") > 0 && Object.hasOwn(formats, extension)
    ? formats[extension as keyof typeof formats]
    : undefined;
}

export function attachmentSizeLimit(mime: AttachmentMime) {
  if (mime.startsWith("image/")) return attachmentLimits.image;
  return mime === "application/pdf" ? attachmentLimits.total : attachmentLimits.text;
}

export function attachmentCapabilityError(mime: AttachmentMime, caps: AttachmentCapabilities) {
  if (mime === "application/pdf" && !caps.pdf) return "ATTACHMENT_PDF_UNSUPPORTED";
  if (mime.startsWith("image/") && !caps.vision) return "ATTACHMENT_VISION_UNSUPPORTED";
  return null;
}

export function attachmentCapabilities(
  capabilities: import("./index").ModelCapabilities | undefined,
  effort?: import("./index").ReasoningEffort | null,
): AttachmentCapabilities {
  const modality = effort ? capabilities?.reasoningEfforts?.[effort] : capabilities;
  return { vision: modality?.vision === true, pdf: modality?.pdf === true };
}
