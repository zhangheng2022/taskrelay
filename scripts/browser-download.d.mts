/** 浏览器构建下载的进程适配边界；生产保持系统 curl，测试可替换公开资源响应。 */
export function downloadBrowserArchive(options: {
  url: string;
  archive: string;
  sha256: string;
  runCurl?: (args: string[]) => Promise<number>;
}): Promise<{ cached: boolean }>;
