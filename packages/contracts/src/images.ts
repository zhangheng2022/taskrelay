/** 图片协议的体积与生命周期约束；桌面先脱敏再编码，云端独立校验。 */
export const imageLimits = {
  bytes: 1_500_000,
  thumbnailBytes: 160_000,
  pixels: 16_000_000,
  thumbnailWidth: 640,
  thumbnailHeight: 360,
  visionTtlMs: 600_000,
} as const;

export type ImagePurpose = "chat" | "vision";
export interface SnapshotImage {
  image: Uint8Array;
  thumbnail?: Uint8Array;
}
export interface SavedImage {
  id: string;
  expiresAt?: string;
}
