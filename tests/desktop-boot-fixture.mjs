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
  setAppUserModelId: () => send("appId"),
  getLoginItemSettings: () => ({ launchItems: [] }),
  setLoginItemSettings: (settings) => send("login", settings),
  exit: (code) => process.send({ type: "exit" }, () => process.exit(code)),
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
let service, serviceMock;
if (mode === "service-ui") {
  let cancelled = true;
  let paired = false;
  let version = "0.27.0";
  let release = "0.27.0";
  const adapter = new (class {
    supported = true;
    async info() {
      return service ?? null;
    }
    async setStartup(enabled) {
      service.mode = enabled ? "auto" : "manual";
    }
    async start() {
      service.running = true;
    }
    async prepareInstall(selected) {
      return {
        run: async () => {
          if (cancelled) {
            cancelled = false;
            throw Error("SERVICE_UAC_CANCELLED");
          }
          service = { mode: service?.mode ?? "auto", running: true };
          version = selected.version;
          release = "0.27.1";
        },
        cleanup: async () => {},
      };
    }
    async call(method, input) {
      if (method === "quit") {
        service.running = false;
        return;
      }
      if (method === "status")
        return {
          paired,
          version,
          cloudUrl: "https://127.0.0.1:1",
          paused: true,
          online: paired,
          activeRunId: null,
          error: null,
        };
      if (method === "configure") return { url: input + "/pair", code: "123456" };
      if (method === "pairPoll") {
        paired = true;
        return true;
      }
      if (method === "idleForService") return true;
    }
  })();
  globalThis.executorServiceFixture = {
    WindowsService: class {
      constructor() {
        return adapter;
      }
    },
    fetchServiceRelease: async () => ({ version: release }),
    readServiceEnvironment: () => {
      throw Error("UNEXPECTED_SERVICE_MODE");
    },
    serveServiceCommands: () => {
      throw Error("UNEXPECTED_SERVICE_MODE");
    },
  };
  const file = path.join(profile, "service-fixture.cjs");
  await writeFile(
    file,
    Object.keys(globalThis.executorServiceFixture)
      .map((name) => `exports.${name}=globalThis.executorServiceFixture.${name};`)
      .join(""),
  );
  serviceMock = pathToFileURL(file).href;
}
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron")
      return { url: fixtureUrl, format: "commonjs", shortCircuit: true };
    if (specifier === "./windows-service" && serviceMock)
      return { url: serviceMock, format: "commonjs", shortCircuit: true };
    return next(specifier === "original-fs" ? "node:fs" : specifier, context);
  },
});
let claims = 0;
let holdReadiness = false;
globalThis.fetch = async (input) => {
  const url = new URL(input);
  let body = {};
  if (holdReadiness && url.pathname === "/api/device/readiness") {
    send("pendingReadiness");
    return new Promise(() => {});
  }
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
    if (method === "resume" || method === "holdReadiness") {
      holdReadiness = method === "holdReadiness";
      electron.powerMonitor.emit("resume");
      return;
    }
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
