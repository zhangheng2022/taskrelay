import { contextBridge, ipcRenderer } from "electron";
import type { Transport } from "../../../../packages/contracts/src/index";
const invoke = (method: string, ...args: unknown[]) =>
  ipcRenderer.invoke(`taskrelay:${method}`, ...args);
const transport: Transport = {
  request: (method, path, body) => invoke("request", { method, path, body }),
  desktop: {
    status: () => invoke("status"),
    configure: (url) => invoke("configure", url),
    pairPoll: () => invoke("pairPoll"),
    pause: (value) => invoke("pause", value),
    autoStart: (value) => invoke("autoStart", value),
    stop: () => invoke("stop"),
    diagnostics: () => invoke("diagnostics"),
    subscribe: (fn) => {
      const listener = () => fn();
      ipcRenderer.on("taskrelay:changed", listener);
      return () => ipcRenderer.removeListener("taskrelay:changed", listener);
    },
  },
};
contextBridge.exposeInMainWorld("taskrelay", transport);
