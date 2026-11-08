/** 固定官方工具的下载与哈希校验入口；fetcher 允许隔离验证失败、跳转和凭据边界。 */
export function qualityToolBytes(
  platform: { url: string; sha256: string },
  fetcher?: typeof fetch,
  token?: string,
): Promise<Buffer>;
/** 返回通过固定归档哈希校验并解包后的本机可执行文件路径。 */
export function qualityTool(name: string): Promise<string>;
