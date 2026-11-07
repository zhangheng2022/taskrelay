import { createHash } from "node:crypto";
import {
  imageLimits,
  type ImagePurpose,
  type SnapshotImage,
  type SavedImage,
} from "../../../../packages/contracts/src/images";

/** 同一次图片上传可安全重试一次；不重放浏览器动作或模型推理。只缓存短期引用，不缓存图像字节。 */
export function imageUploader(
  scope: string,
  guard: () => void,
  send: (captureId: string, image: SnapshotImage, purpose: ImagePurpose) => Promise<SavedImage>,
) {
  const references = new Map<string, { saved: SavedImage; expires: number }>();
  return async (image: SnapshotImage, purpose: ImagePurpose, captureId?: string) => {
    guard();
    const digest = createHash("sha256").update(image.image).digest("hex");
    const key = `${purpose}:${digest}`;
    const prior = references.get(key);
    if (prior && prior.expires > Date.now() + 30_000) return prior.saved;
    // 临时图片过期后必须使用新 ID，不能让旧请求复活过期的索引。
    const id = captureId ?? crypto.randomUUID();
    const stableId = createHash("sha256").update(`${scope}:${id}`).digest("hex");
    for (let attempt = 0; ; attempt++) {
      guard();
      try {
        const saved = await send(stableId, image, purpose);
        guard();
        references.set(key, {
          saved,
          expires: saved.expiresAt
            ? Date.parse(saved.expiresAt)
            : Date.now() + imageLimits.visionTtlMs,
        });
        if (references.size > 32) references.delete(references.keys().next().value!);
        return saved;
      } catch (error) {
        guard();
        if (
          attempt ||
          !["OFFLINE", "HTTP_502", "HTTP_503", "HTTP_504"].includes((error as Error).message)
        )
          throw error;
      }
    }
  };
}
