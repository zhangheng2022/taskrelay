/** 分进程加载真实 Main；替换 Electron 窗口、DPAPI、utilityProcess 与云端。 */
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "./ui-fixtures.ts";

const [profile, resources, mode] = process.argv.slice(2);
if (mode === "background") process.argv.push("--taskrelay-background");
const handlers = new Map();
const send = (type, data) => process.send({ type, data });
const events = () => new EventEmitter();
const app = Object.assign(events(), {
  isPackaged: true,
  getVersion: () => "0.26.9",
  getPath: (name) => (name === "exe" ? process.execPath : profile),
  whenReady: async () => {},
  requestSingleInstanceLock: () => true,
  setAppUserModelId: () => {},
  getLoginItemSettings: () => ({ launchItems: [] }),
  setLoginItemSettings: (settings) => send("login", settings),
  exit: (code) => process.exit(code),
});
const frame = {};
const webContents = Object.assign(events(), {
  mainFrame: frame,
  session: { setPermissionRequestHandler() {} },
  send() {},
  setWindowOpenHandler() {},
});
class BrowserWindow extends EventEmitter {
  webContents = webContents;
  constructor({ title }) {
    super();
    send("window", title);
  }
  async loadURL() {}
  show() {}
  focus() {}
}
let trayMenu = [];
class Tray extends EventEmitter {
  setToolTip() {}
  setContextMenu(menu) {
    trayMenu = menu;
  }
  destroy() {}
}

const electron = {
  app,
  BrowserWindow,
  Tray,
  ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
  Menu: { buildFromTemplate: (menu) => menu },
  nativeImage: { createFromPath() {} },
  net: {},
  shell: { openExternal: async (url) => send("external", url) },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  powerMonitor: events(),
  dialog: {
    showErrorBox: (_title, error) => send("error", error),
    showSaveDialog: async () => ({ filePath: path.join(profile, "diagnostics.json") }),
  },
  utilityProcess: {
    fork: () =>
      Object.assign(events(), {
        postMessage: (m) => send("utility", m.type),
        kill() {
          this.emit("exit");
          return true;
        },
      }),
  },
  autoUpdater: events(),
  Notification: {},
  safeStorage: {
    decryptString: (bytes) => bytes.toString(),
    encryptString: (token) => Buffer.from(token),
    isEncryptionAvailable: () => true,
  },
};
Object.assign(globalThis, {
  executorElectronFixture: electron,
  __dirname: resources,
  MAIN_WINDOW_VITE_DEV_SERVER_URL: undefined,
  MAIN_WINDOW_VITE_NAME: "main_window",
});
process.resourcesPath = resources;
const mock = path.join(profile, `electron-${process.pid}.cjs`);
await writeFile(
  mock,
  Object.keys(electron)
    .map((name) => `exports.${name}=globalThis.executorElectronFixture.${name};`)
    .join(""),
);
const fixtureUrl = pathToFileURL(mock).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron")
      return { url: fixtureUrl, format: "commonjs", shortCircuit: true };
    return next(specifier === "original-fs" ? "node:fs" : specifier, context);
  },
});
let claims = 0;
globalThis.fetch = async (input) => {
  const url = new URL(input);
  let body = {};
  if (url.pathname === "/api/runner/claim") {
    send("claim");
    body = {
      run:
        claims++ === 0
          ? {
              ...run,
              status: "running",
              leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
            }
          : null,
    };
  }
  if (url.pathname === "/api/pair/start")
    body = { id: "pair-id", pollToken: "pair-token", code: "123456", url: url.origin + "/pair" };
  if (url.pathname === "/api/pair/poll") body = { approved: true, token: "fixture-token" };
  return Response.json(body);
};
async function handleMessage({ id, method, input }) {
  try {
    if (method === "quit") {
      trayMenu.find((item) => item.label === "退出 TaskRelay").click();
      return;
    }
    if (method === "trayPause") {
      trayMenu.find((item) => item.label === "暂停 / 继续领取").click();
      return;
    }
    const value = await handlers.get(`taskrelay:${method}`)(
      { sender: webContents, senderFrame: frame },
      input,
    );
    send(id, { value });
  } catch (error) {
    send(id, { error: error.message });
  }
}
process.on("message", (message) => void handleMessage(message));
await import("../apps/desktop/src/main/index.ts");
