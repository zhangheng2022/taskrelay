/** 隔离更新界面：生产 ExecutorApp 配合合成 Transport，不下载或安装程序。 */
import { createRoot } from "react-dom/client";
import { ExecutorApp } from "../../packages/ui/src/executor-app";
import type { DesktopStatus, Transport } from "../../packages/contracts/src/index";
import "../../packages/ui/src/styles.css";
let changed = () => {};
const status: DesktopStatus = {
  paired: true,
  cloudUrl: "https://example.test",
  paused: false,
  online: true,
  activeRunId: "fixture-run",
  version: "0.22.0",
  autoStart: false,
  error: null,
  update: {
    phase: "downloading",
    release: {
      version: "0.22.1",
      sha1: "a".repeat(40),
      sha256: "b".repeat(64),
      bytes: 1,
      notes: "改进执行器更新体验。",
      publishedAt: "2026-11-10T00:00:00.000Z",
    },
    progress: 42,
    checkedAt: null,
    error: null,
  },
};
const executor: NonNullable<Transport["desktop"]> = {
  status: async () => structuredClone(status),
  configure: async () => ({ url: "", code: "" }),
  pairPoll: async () => true,
  pause: async () => {},
  autoStart: async () => {},
  stop: async () => {},
  diagnostics: async () => "",
  checkUpdate: async () => {},
  downloadUpdate: async () => {},
  subscribe: (fn) => {
    changed = fn;
    return () => {};
  },
};
Object.assign(window, {
  updateFixture: {
    set(phase: DesktopStatus["update"]["phase"]) {
      status.update.phase = phase;
      changed();
    },
  },
});
createRoot(document.getElementById("root")!).render(<ExecutorApp executor={executor} />);
