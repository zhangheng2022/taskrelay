/** 浏览器构建下载的进程适配边界；生产保持系统 curl，测试可替换公开资源响应。 */
export function downloadBrowserArchive(options: {
  url: string;
  archive: string;
  sha256: string;
  runCurl?: (args: string[]) => Promise<number>;
}): Promise<{ cached: boolean }>;
/** Electron 固定归档的官方 API 备用入口；不接受错误哈希或改变资产身份。 */
export function downloadElectronArchive(options: {
  url: string;
  archive: string;
  sha256: string;
  runCurl?: (args: string[]) => Promise<number>;
  fetcher?: typeof fetch;
  token?: string;
}): Promise<{ cached: boolean }>;
