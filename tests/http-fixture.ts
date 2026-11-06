import assert from "node:assert/strict";

// 测试边界保留 fetch 的 Request/URL 语义；JSON 请求必须真的携带字符串，不能隐式转成 [object Object]。
export function requestUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof Request) return input.url;
  assert.ok(input instanceof URL);
  return input.toString();
}
export function jsonBody(body: unknown): any {
  assert.equal(typeof body, "string");
  return JSON.parse(body as string);
}
export function socketText(data: Buffer | ArrayBuffer | Buffer[]): string {
  return (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString("utf8");
}
