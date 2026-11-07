/** 稳定键集分页：游标只携带排序时点和 ID，归属始终由当前认证用户约束。 */
import { Buffer } from "node:buffer";
import { z } from "zod";
import { dbTime } from "./database";
export const pageQuery = z.object({ before: z.string().max(512).optional() }).strict();
const key = z.tuple([z.number().int().nonnegative(), z.string().min(1).max(200)]);
export function pageKey(before?: string): [number, string] | null {
  if (before === undefined) return null;
  try {
    return key.parse(JSON.parse(Buffer.from(before, "base64url").toString("utf8")));
  } catch {
    throw Error("INVALID_CURSOR");
  }
}
export function pageCursor(time: string | number, id: string) {
  return Buffer.from(JSON.stringify([dbTime(time), id])).toString("base64url");
}
