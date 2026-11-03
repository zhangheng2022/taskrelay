import { z } from "zod";
export const requestSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT"]),
    path: z
      .string()
      .max(500)
      .regex(
        /^\/api\/user\/(snapshot|tasks|runs|models|accounts|devices|challenges|artifacts|settings)(\/[a-zA-Z0-9_-]+)*(\?format=data)?$/,
      ),
    body: z.unknown().optional(),
  })
  .strict();
export const cloudUrlSchema = z
  .string()
  .url()
  .max(2000)
  .transform((value) => {
    const u = new URL(value);
    if (u.username || u.password || u.search || u.hash || u.pathname !== "/")
      throw new Error("CLOUD_URL_INVALID");
    if (
      u.protocol !== "https:" &&
      !(
        process.env.NODE_ENV === "development" &&
        u.protocol === "http:" &&
        u.hostname === "127.0.0.1"
      )
    )
      throw new Error("HTTPS_REQUIRED");
    return u.origin;
  });
export interface RpcRequest {
  generation: string;
  id: string;
  type: "rpc";
  path: string;
  body?: unknown;
  binary?: Uint8Array;
}
