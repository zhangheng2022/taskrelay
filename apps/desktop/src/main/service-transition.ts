/** 切换只持有执行门闩，不改用户暂停偏好。安装取消时由原拥有者恢复领取。 */
import { newerVersion, type ServiceRelease } from "../../../../packages/contracts/src/updates";

export type InstalledService = { mode: "auto" | "manual"; running: boolean };
interface Transition {
  enabled: boolean;
  upgrade: boolean;
  info(): Promise<InstalledService | null>;
  startup(enabled: boolean): Promise<void>;
  start(): Promise<void>;
  currentVersion(): Promise<string>;
  release(): Promise<ServiceRelease | null>;
  prepare(release: ServiceRelease): Promise<{ run(): Promise<void>; cleanup(): Promise<void> }>;
  drain(): Promise<void>;
  waitUntilIdle(): Promise<void>;
  stopPrevious(): Promise<boolean>;
  adopt(): Promise<void>;
  restore(stopped: boolean): Promise<void>;
}

export async function transitionService(input: Transition) {
  const info = await input.info();
  if (info && !input.upgrade) {
    if (info.mode !== (input.enabled ? "auto" : "manual")) await input.startup(input.enabled);
    if (input.enabled && !info.running) await input.start();
    return;
  }
  if (!input.enabled && !input.upgrade) return;
  if (input.upgrade && !info?.running) throw Error("请先启动开机服务。");
  const release = await input.release();
  if (!release || (input.upgrade && !newerVersion(release.version, await input.currentVersion())))
    throw Error("当前没有可用的开机服务安装包。");
  const prepared = await input.prepare(release);
  let drained = false;
  let stopped = false;
  let installed = false;
  try {
    await input.drain();
    drained = true;
    await input.waitUntilIdle();
    stopped = await input.stopPrevious();
    await prepared.run();
    installed = true;
    await input.adopt();
  } finally {
    if (drained && !installed) await input.restore(stopped);
    await prepared.cleanup().catch(() => {});
  }
}
