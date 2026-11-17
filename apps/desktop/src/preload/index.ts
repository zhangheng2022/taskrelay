import { contextBridge, ipcRenderer } from "electron";
import type { Transport } from "../../../../packages/contracts/src/index";
const invoke = (method: string, ...args: unknown[]) =>
  ipcRenderer.invoke(`taskrelay:${method}`, ...args);
const transport: NonNullable<Transport["desktop"]> = {
  status: () => invoke("status"),
  configure: (url) => invoke("configure", url),
  pairPoll: () => invoke("pairPoll"),
  pause: (value) => invoke("pause", value),
  autoStart: (value) => invoke("autoStart", value),
  stop: () => invoke("stop"),
  diagnostics: () => invoke("diagnostics"),
  checkUpdate: () => invoke("checkUpdate"),
  downloadUpdate: (version) => invoke("downloadUpdate", version),
  subscribe: (fn) => {
    const listener = () => fn();
    ipcRenderer.on("taskrelay:changed", listener);
    return () => ipcRenderer.removeListener("taskrelay:changed", listener);
  },
};
contextBridge.exposeInMainWorld("taskrelay", transport);
