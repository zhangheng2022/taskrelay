import { z } from "zod";

/** 账号浏览器状态的可迁移部分。保留 Chromium Cookie 属性，存储秘密仅穿过鉴权接口，不能进入日志或普通聊天。 */
export const browserCookieSchema = z
  .object({
    name: z.string(),
    value: z.string(),
    domain: z.string().min(1),
    path: z.string(),
    expires: z.number().optional(),
    httpOnly: z.boolean().optional(),
    secure: z.boolean().optional(),
    sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
    priority: z.enum(["Low", "Medium", "High"]).optional(),
    sameParty: z.boolean().optional(),
    sourceScheme: z.enum(["Unset", "NonSecure", "Secure"]).optional(),
    sourcePort: z.number().int().optional(),
    partitionKey: z
      .object({ topLevelSite: z.string(), hasCrossSiteAncestor: z.boolean() })
      .optional(),
    // 不透明分区无法重建；拒绝整份同步，不能丢掉分区标志后恢复成普通 Cookie。
    partitionKeyOpaque: z.boolean().optional(),
  })
  .refine((cookie) => !cookie.partitionKeyOpaque, { message: "BROWSER_STATE_UNSUPPORTED_COOKIE" })
  .transform(({ partitionKeyOpaque: _opaque, ...cookie }) => cookie);
export const browserStateSchema = z.object({
  version: z.literal(1),
  cookies: z.array(browserCookieSchema),
  origins: z.array(
    z.object({ origin: z.url(), localStorage: z.array(z.tuple([z.string(), z.string()])) }),
  ),
});
export type BrowserState = z.infer<typeof browserStateSchema>;
export const BROWSER_STATE_MAX_BYTES = 2_000_000;
export interface BrowserStateAccess {
  accountId: string | null;
  credentialVersion: number;
  stateEpoch: number;
  revision: number;
  origins: string[];
  state: BrowserState | null;
  restoreFailed?: boolean;
}
export interface AccountCardDetail {
  id: string;
  kind: "save" | "update";
  status: "pending" | "saved" | "dismissed" | "expired";
  accountId: string | null;
  credentialVersion: number | null;
  verified: boolean;
  canResume: boolean;
  name: string;
  origin: string;
  businessDomains: string[];
  loginOrigins: string[];
  username?: string;
  password?: string;
  expiresAt: string;
}
