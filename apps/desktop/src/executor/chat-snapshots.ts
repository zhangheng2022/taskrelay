import { hash } from "../../../../packages/contracts/src/security";
import type { ChatPart } from "../../../../packages/contracts/src/execution";
import { createHash } from "node:crypto";
import type { SnapshotImage } from "../../../../packages/contracts/src/images";

/** 聊天截图的捕获与上传所有者；事件只捕获一次，脱敏后的图片按内容复用。
 * 只管理聊天证据，不缓存 Stagehand 视觉输入，也不参与动作准入或业务成功判断。
 */
export function chatSnapshots(
  scope: string,
  capture: () => Promise<SnapshotImage>,
  save: (captureId: string, image: SnapshotImage) => Promise<{ id: string }>,
) {
  const attempted = new Set<string>(),
    images = new Map<string, string>(),
    published = new Set<string>();
  const take = async (
    event: string,
  ): Promise<{ parts: ChatPart[]; reused: boolean; available: boolean; error?: string }> => {
    if (attempted.has(event)) return { parts: [], reused: false, available: false };
    attempted.add(event);
    try {
      const image = await capture(),
        digest = createHash("sha256").update(image.image).digest("hex");
      const prior = images.get(digest);
      if (prior && published.has(prior)) return { parts: [], reused: true, available: true };
      const saved = prior ? { id: prior } : await save(await hash(`${scope}:${digest}`), image);
      images.set(digest, saved.id);
      return {
        parts: [{ type: "image", artifactId: saved.id, alt: "当前页面" }],
        reused: false,
        available: true,
      };
    } catch (error) {
      const code = (error as Error).message;
      if (
        [
          "CANCEL_REQUESTED",
          "LEASE_EXPIRED",
          "INSTRUCTIONS_PENDING",
          "INSTRUCTIONS_CHANGED",
        ].includes(code)
      )
        throw error;
      const reason =
        code === "IMAGE_TOO_LARGE"
          ? "截图超过大小限制"
          : code === "OFFLINE"
            ? "截图上传失败，连接暂不可用"
            : "截图处理或保存失败";
      return { parts: [], reused: false, available: false, error: reason };
    }
  };
  // 上传成功不等于聊天已发布；发布失败后下个节点仍须附图，不能声称“沿用此前”。
  return {
    take,
    published: (parts: ChatPart[]) => {
      for (const part of parts) if (part.type === "image") published.add(part.artifactId);
    },
  };
}
