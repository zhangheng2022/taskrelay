import { PROTOCOL_VERSION } from "../../../../packages/contracts/src/index";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  shell,
  protocol,
  net as electronNet,
  powerMonitor,
  dialog,
  utilityProcess,
  autoUpdater,
  Notification,
  safeStorage,
} from "electron";
import squirrelStartup from "electron-squirrel-startup";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { hostname } from "node:os";
import { z } from "zod";
import { Journal } from "./journal";
import { convertJournal } from "./convert-journal";
import { Cloud } from "./cloud";
import { OwnedBrowser } from "./browser";
import { ProtectedStateFiles } from "./protected-state";
import { prepareExtension } from "./extension";
import { ExecutorHost } from "./executor-host";
import { DesktopUpdater } from "./updater";
import { RunnerPoller } from "./runner-poller";
import { appUserModelId, loginSettings } from "./login";
import {
  newerVersion,
  releaseSchema,
  type ServiceRelease,
} from "../../../../packages/contracts/src/updates";
import { cloudUrlSchema } from "../shared/ipc";
import type { DesktopStatus } from "../../../../packages/contracts/src/index";
import { packagedSmoke } from "./smoke";
import { DesktopControl, tryAcquireExecutor } from "./desktop-control";
import {
  fetchServiceRelease,
  readServiceEnvironment,
  serveServiceCommands,
  WindowsService,
} from "./windows-service";
import { transitionService } from "./service-transition";
// Main 运行现有执行链路，后台模式不创建窗口或托盘；同用户的桌面进程可转发命名控制。
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;
const serviceMode = process.argv.includes("--taskrelay-service");
const background = serviceMode || process.argv.includes("--taskrelay-background");
const serviceEnvironment = serviceMode ? readServiceEnvironment(process.env) : null;
if (serviceEnvironment) app.setPath("userData", serviceEnvironment.directory);
const windowsService = new WindowsService(
  process.platform === "win32" &&
    process.arch === "x64" &&
    app.isPackaged &&
    existsSync(path.resolve(process.execPath, "../../Update.exe")),
);
protocol.registerSchemesAsPrivileged([
  {
    scheme: "taskrelay",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
let window: BrowserWindow | null = null,
  tray: Tray | null = null,
  quitting = false,
  online = false,
  lastError: string | null = null;
let journal: Journal,
  cloud: Cloud,
  host: ExecutorHost,
  pairing: { id: string; pollToken: string } | null = null;
let poller: RunnerPoller;
let updater: DesktopUpdater;
let login: ReturnType<typeof loginSettings>;
let control: DesktopControl | undefined;
let ownership: ReturnType<typeof tryAcquireExecutor>;
let serviceController = false;
let serviceAccessError = "";
let serviceRelease: ServiceRelease | null = null;
let serviceCheckedAt: string | null = null;
let serviceStatus: DesktopStatus | null = null;
let switching = false;
let retired = false;
let drainForService = false;
function loginLaunchPath() {
  const stub = path.resolve(process.execPath, "../../TaskRelay.exe");
  return app.isPackaged &&
    existsSync(path.resolve(process.execPath, "../../Update.exe")) &&
    existsSync(stub)
    ? stub
    : app.getPath("exe");
}
function updateBusy() {
  return (
    quitting ||
    poller.unsettled ||
    !host.idleForUpdate ||
    journal.pending().length > 0 ||
    journal.incomplete().length > 0
  );
}
function status(): Omit<DesktopStatus, "autoStart"> {
  return {
    update: updater.status,
    paired: cloud.paired,
    cloudUrl: cloud.url,
    paused: journal.get<boolean>("paused") ?? false,
    online: cloud.online,
    activeRunId: host.active,
    version: app.getVersion(),
    error: lastError,
  };
}
function notify() {
  window?.webContents.send("taskrelay:changed");
}
function show() {
  if (background) return;
  if (window) {
    window.show();
    window.focus();
  } else createWindow();
}
function createWindow() {
  window = new BrowserWindow({
    width: 520,
    height: 680,
    minWidth: 420,
    minHeight: 600,
    title: ownership ? "TaskRelay 执行器" : "TaskRelay 执行器 · 后台控制",
    backgroundColor: "#f7f8f6",
    show: false,
    autoHideMenuBar: true,
    icon: path.join(
      app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "../../../../resources"),
      "icon.png",
    ),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  if (!ownership) window.on("page-title-updated", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const origin = MAIN_WINDOW_VITE_DEV_SERVER_URL
      ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin
      : "taskrelay://app";
    if (!url.startsWith(`${origin}/`)) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.on("closed", () => {
    window = null;
  });
  window.once("ready-to-show", () => window?.show());
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL)
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL).catch(windowLoadFailed);
  else void window.loadURL("taskrelay://app/index.html").catch(windowLoadFailed);
}
function windowLoadFailed() {
  lastError = "WINDOW_LOAD_FAILED";
  dialog.showErrorBox("TaskRelay 界面加载失败", "请重新打开执行器或检查安装完整性。");
}
function backgroundFailed() {
  lastError = "EXECUTOR_BACKGROUND_FAILED";
  notify();
}
const commands = {
  status,
  drainForService(input: unknown) {
    drainForService = z.boolean().parse(input);
    notify();
  },
  idleForService: () => !updateBusy() && !updater.blocksClaims,
  async configure(input: unknown) {
    if (host.active || poller.unsettled || updater.blocksClaims)
      throw new Error("STOP_RUN_BEFORE_PAIRING");
    const url = cloudUrlSchema.parse(input);
    journal.set("cloudUrl", url);
    journal.set("token", null);
    const result = await cloud.request<{
      id: string;
      pollToken: string;
      url: string;
      code: string;
    }>("POST", "/api/pair/start", { name: hostname(), protocolVersion: PROTOCOL_VERSION }, true);
    if (new URL(result.url).origin !== url) throw new Error("PAIRING_URL_MISMATCH");
    pairing = { id: result.id, pollToken: result.pollToken };
    notify();
    return { url: result.url, code: result.code };
  },
  async pairPoll() {
    if (!pairing) return cloud.paired;
    const result = await cloud.request<{ approved: boolean; token?: string }>(
      "POST",
      "/api/pair/poll",
      pairing,
      true,
    );
    if (result.approved && result.token) {
      cloud.storeToken(result.token);
      pairing = null;
      online = true;
      notify();
      if (serviceMode) void poll().catch(backgroundFailed);
      return true;
    }
    return false;
  },
  pause(v: unknown) {
    journal.set("paused", z.boolean().parse(v));
    notify();
  },
  togglePause() {
    commands.pause(!journal.get<boolean>("paused"));
  },
  stop: () => host.stop(true),
  checkUpdate: () => updater.check(true),
  async downloadUpdate(input: unknown) {
    const version = releaseSchema.shape.version.parse(input);
    if (updater.status.release?.version === version) await updater.check(true);
  },
  diagnostics: () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    state: { online, active: host.active, paused: status().paused },
    ...journal.diagnostic(),
  }),
  quit: prepareQuit,
};
function runCommand(method: string, input: unknown) {
  if (!Object.hasOwn(commands, method)) throw Error("EXECUTOR_COMMAND_REJECTED");
  if (quitting) throw Error("执行器正在退出。");
  return commands[method as keyof typeof commands](input);
}
async function invoke(method: string, input?: unknown) {
  if (serviceController) {
    if (serviceAccessError) throw Error(serviceAccessError);
    return windowsService.call(method, input);
  }
  return ownership ? runCommand(method, input) : control!.call(method, input);
}
async function desktopStatus(): Promise<DesktopStatus> {
  if (!serviceController) {
    const current = (await invoke("status")) as ReturnType<typeof status>;
    return {
      ...current,
      autoStart: false,
      boot: windowsService.supported ? "not-installed" : "unavailable",
    };
  }
  if (switching && serviceStatus) return serviceStatus;
  const info = await windowsService.info().catch(() => null);
  const current = info?.running
    ? ((await invoke("status").catch(() => null)) as ReturnType<typeof status> | null)
    : null;
  if (!current)
    return {
      update: { phase: "unsupported", release: null, progress: null, error: null, checkedAt: null },
      paired: false,
      cloudUrl: "",
      paused: false,
      online: false,
      activeRunId: null,
      version: app.getVersion(),
      autoStart: info?.mode === "auto",
      boot: "offline",
      error: serviceAccessError || "无法连接开机服务，可以重试。",
    };
  const autoStart = info?.mode === "auto";
  const boot = !current.paired ? "pairing" : autoStart ? "enabled" : "disabled";
  return (serviceStatus = {
    ...current,
    autoStart,
    boot,
    serviceRelease,
    update: {
      phase: serviceCheckedAt && !serviceRelease ? "current" : "idle",
      release: null,
      progress: null,
      error: null,
      checkedAt: serviceCheckedAt,
    },
  });
}
async function checkServiceUpdate() {
  if (switching) return;
  if (!serviceController) return invoke("checkUpdate");
  const current = (await invoke("status")) as ReturnType<typeof status>;
  const release = await fetchServiceRelease();
  serviceRelease = release && newerVersion(release.version, current.version) ? release : null;
  serviceCheckedAt = new Date().toISOString();
  notify();
}
async function waitForService() {
  for (let i = 0; i < 40; i++) {
    const info = await windowsService.info();
    if (info?.running && (await windowsService.call("status").catch(() => null))) return;
    await delay(500);
  }
  throw Error("开机服务还没有就绪，请等待后重试。");
}
function retireLocal() {
  if (!ownership) return;
  retired = true;
  cloud.close();
  updater.stop();
  journal.close();
  control?.close();
  control = undefined;
  ownership.close();
  ownership = null;
}
async function openPairing(input: unknown) {
  const url = cloudUrlSchema.parse(input);
  const result = (await invoke("configure", url)) as Awaited<ReturnType<typeof commands.configure>>;
  if (new URL(result.url).origin !== url) throw Error("PAIRING_URL_MISMATCH");
  await shell.openExternal(result.url);
  return result;
}
async function configureStartup(enabled: boolean, upgrade = false) {
  if (!windowsService.supported || switching) {
    if (!enabled && !upgrade) return;
    throw Error("这台设备无法配置开机服务。");
  }
  switching = true;
  const wasService = serviceController;
  let previousPause = true;
  try {
    await transitionService({
      enabled,
      upgrade,
      info: () => windowsService.info(),
      startup: (value) => windowsService.setStartup(value),
      start: () => windowsService.start(),
      currentVersion: async () => ((await invoke("status")) as ReturnType<typeof status>).version,
      release: async () => (upgrade ? serviceRelease : fetchServiceRelease()),
      prepare: (release) =>
        windowsService.prepareInstall(
          release,
          path.join(app.getPath("userData"), "service-updates"),
        ),
      drain: async () => {
        await invoke("drainForService", true);
      },
      waitUntilIdle: async () => {
        while (!(await invoke("idleForService"))) {
          if (quitting) throw Error("已取消开机服务配置。");
          await delay(1500);
        }
      },
      stopPrevious: async () => {
        if (!wasService)
          previousPause = ((await invoke("status")) as ReturnType<typeof status>).paused;
        if (!wasService && ownership) return false;
        await invoke("quit");
        // 旧开机计划任务先等子进程退出，才可由管理员停用。
        await delay(1400);
        return true;
      },
      adopt: async () => {
        retireLocal();
        serviceController = true;
        if (!wasService) login.setEnabled(false);
        serviceRelease = null;
        await waitForService();
        if (!wasService) await invoke("pause", previousPause);
      },
      restore: async (stopped) => {
        if (!stopped) await invoke("drainForService", false).catch(() => {});
        else if (wasService) await windowsService.start().catch(() => {});
        else {
          app.relaunch();
          finishQuit();
        }
      },
    });
  } finally {
    switching = false;
    notify();
  }
}
function registerIpc() {
  const handle = (name: string, fn: (input: unknown) => unknown) =>
    ipcMain.handle(`taskrelay:${name}`, (event, input) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("IPC_SENDER_REJECTED");
      return fn(input);
    });
  handle("status", desktopStatus);
  handle("configure", openPairing);
  for (const method of ["pairPoll", "pause", "stop", "downloadUpdate"] as const)
    handle(method, (input) => invoke(method, input));
  handle("checkUpdate", checkServiceUpdate);
  handle("autoStart", (input) => configureStartup(z.boolean().parse(input)));
  handle("updateService", () => configureStartup(true, true));
  handle("diagnostics", async () => {
    const result = await dialog.showSaveDialog(window!, {
      defaultPath: `TaskRelay-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return "已取消导出";
    await writeFile(result.filePath, JSON.stringify(await invoke("diagnostics"), null, 2));
    return `诊断已保存：${result.filePath}`;
  });
}
async function poll() {
  if (!retired) await poller.poll();
}
async function prepareQuit() {
  if (updater?.status.phase === "installing") throw Error("执行器正在安装更新。");
  quitting = true;
  try {
    await host?.stop(true);
    // 浏览器立即停止。仅等已送到云端的领取消解；回传可以由 journal 在下次启动时继续。
    await poller?.waitForClaim();
  } catch {
    quitting = false;
    lastError = "PROCESS_CLEANUP_FAILED";
    throw Error(lastError);
  }
  cloud?.close();
  updater?.stop();
}
function finishQuit() {
  try {
    if (!retired) journal?.close();
    control?.close();
    tray?.destroy();
  } finally {
    app.exit(0);
  }
}
async function quit() {
  if (quitting) return;
  if (switching) throw Error("正在配置开机服务，请等待配置完成。");
  if (serviceController) {
    const info = await windowsService.info().catch(() => null);
    if (info?.running) await invoke("quit");
  } else if (control) {
    if (ownership) await invoke("quit");
    else {
      // 后台进程可能已经退出。没有持锁者时，桌面控制窗口可以直接退出。
      ownership = tryAcquireExecutor(app.getPath("userData"));
      if (!ownership) await invoke("quit");
    }
  }
  quitting = true;
  finishQuit();
}
function attachDesktop(root: string) {
  login = loginSettings(app, loginLaunchPath());
  const rendererRoot = path.resolve(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
  protocol.handle("taskrelay", (request) => {
    const u = new URL(request.url);
    if (u.host !== "app") return new Response(null, { status: 403 });
    const target = path.resolve(rendererRoot, "." + decodeURIComponent(u.pathname));
    if (!target.startsWith(rendererRoot + path.sep)) return new Response(null, { status: 403 });
    return electronNet.fetch(pathToFileURL(target).toString());
  });
  registerIpc();
  tray = new Tray(nativeImage.createFromPath(path.join(root, "icon.png")));
  tray.setToolTip("TaskRelay");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 TaskRelay", click: show },
      {
        label: "暂停 / 继续领取",
        click: () => void invoke("togglePause").catch(desktopCommandFailed),
      },
      { type: "separator" },
      {
        label: "检查版本更新",
        click: () => {
          show();
          void checkServiceUpdate().catch(desktopCommandFailed);
        },
      },
      { label: "退出 TaskRelay", click: () => void quit().catch(desktopCommandFailed) },
    ]),
  );
  tray.on("double-click", show);
  show();
}
function desktopCommandFailed(error: unknown) {
  if (!background)
    dialog.showErrorBox(
      "TaskRelay",
      error instanceof Error ? error.message : "执行器操作失败，请重试。",
    );
}
if (squirrelStartup || (!background && !app.requestSingleInstanceLock())) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (tray) show();
  });
  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      void quit().catch(desktopCommandFailed);
    }
  });
  app.on("window-all-closed", () => {});
  void app
    .whenReady()
    .then(async () => {
      if (process.argv.includes("--taskrelay-convert-storage")) {
        try {
          const directory = app.getPath("userData");
          ownership = tryAcquireExecutor(directory);
          if (!ownership || background) throw Error("EXECUTOR_ALREADY_RUNNING");
          convertJournal(directory);
          app.exit(0);
        } catch {
          app.exit(1);
        }
        return;
      }
      // Resolve Windows filesystem virtualization before native child-process launches.
      // A redirected path can be readable by fs while CreateProcess rejects it.
      const root = realpathSync.native(
        app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "../../../../resources"),
      );
      const smokeIndex = process.argv.indexOf("--taskrelay-smoke");
      if (smokeIndex >= 0) {
        const output = process.argv[smokeIndex + 1];
        if (!output || !path.isAbsolute(output)) {
          app.exit(1);
          return;
        }
        try {
          app.exit(
            (await packagedSmoke(root, path.join(__dirname, "executor.cjs"), output)) ? 0 : 1,
          );
        } catch (e) {
          await writeFile(
            output,
            JSON.stringify({ passed: false, error: (e as Error).message }, null, 2),
          );
          app.exit(1);
        }
        return;
      }
      const userData = app.getPath("userData");
      if (
        background &&
        !serviceMode &&
        windowsService.supported &&
        (await windowsService.info().catch(() => true))
      ) {
        app.exit(0);
        return;
      }
      if (!background && windowsService.supported) {
        const service = await windowsService.info().catch((error: Error) => {
          serviceAccessError = error.message;
          return null;
        });
        if (service || serviceAccessError) {
          serviceController = true;
          if (service && !service.running) await windowsService.start().catch(() => {});
          attachDesktop(root);
          void checkServiceUpdate().catch(() => {});
          return;
        }
      }
      ownership = tryAcquireExecutor(userData);
      if (background) {
        // 用户恰好在开机任务前进入桌面时，等待前台退出再接管。
        while (!ownership) {
          await delay(3000);
          if (quitting) return;
          ownership = tryAcquireExecutor(userData);
        }
        app.setAppUserModelId(appUserModelId);
      }
      control = new DesktopControl(userData);
      if (!ownership) {
        attachDesktop(root);
        return;
      }
      const extensionPath = await prepareExtension(
        path.join(root, "stagehand-extension"),
        path.join(userData, "runtime-extensions"),
      );
      journal = new Journal(userData);
      // 首次安装若中断交接，完成授权也要等用户主动继续领取。
      if (serviceMode && journal.get<boolean>("paused") === null) journal.set("paused", true);
      cloud = new Cloud(journal);
      if (
        serviceMode &&
        (!safeStorage.isEncryptionAvailable() ||
          safeStorage.decryptString(safeStorage.encryptString("taskrelay-service")) !==
            "taskrelay-service")
      )
        throw Error("SERVICE_OS_ENCRYPTION_UNAVAILABLE");
      if (background && !serviceMode) cloud.verifyBackgroundPairing();
      const browser = new OwnedBrowser(
        path.join(root, "browser"),
        path.join(userData, "profiles"),
        journal,
        extensionPath,
        serviceMode,
      );
      host = new ExecutorHost(
        cloud,
        journal,
        browser,
        path.join(__dirname, "executor.cjs"),
        extensionPath,
        notify,
        (...args) => utilityProcess.fork(...args),
        new ProtectedStateFiles(path.join(userData, "pending-browser-states"), safeStorage),
      );
      await host.recover();
      poller = new RunnerPoller(cloud, host, journal, {
        quitting: () => quitting,
        blocksClaims: () => updater.blocksClaims || drainForService,
        installing: () => updater.status.phase === "installing",
        result: (connected, error) => {
          online = connected;
          lastError = error;
        },
        settled: () => {
          notify();
          updater.tryInstall();
        },
      });
      updater = new DesktopUpdater({
        version: app.getVersion(),
        supported:
          process.platform === "win32" &&
          process.arch === "x64" &&
          app.isPackaged &&
          path.basename(path.dirname(process.execPath)) === `app-${app.getVersion()}` &&
          existsSync(path.resolve(process.execPath, "../../Update.exe")),
        directory: path.join(userData, "updates"),
        native: autoUpdater,
        busy: updateBusy,
        changed: notify,
        available: (release) => {
          if (background) return;
          tray?.setToolTip(`TaskRelay · 发现新版本 ${release.version}`);
          if (Notification.isSupported()) {
            const notification = new Notification({
              title: "TaskRelay 有新版本",
              body: `${release.version} 已可用，正在自动下载，任务结束后安装并重启。`,
            });
            notification.on("click", show);
            notification.show();
          }
        },
        restart: () => {
          // The updater has rechecked quiescence. Do not call host.stop() here.
          quitting = true;
          updater.stop();
          cloud.close();
          journal.close();
          tray?.destroy();
          if (background)
            app.exit(75); // 计划任务启动器重新选择已安装的新版本。
          else autoUpdater.quitAndInstall();
        },
      });
      control.serve(runCommand, backgroundFailed, (method) => {
        if (method === "quit") finishQuit();
      });
      if (serviceEnvironment) {
        const server = serveServiceCommands(serviceEnvironment, runCommand, (method) => {
          if (method === "quit") finishQuit();
        });
        server.on("error", () => app.exit(1));
      }
      powerMonitor.on("suspend", () => {
        void host.stop(true).catch(() => {});
      });
      powerMonitor.on("resume", () => {
        void updater.check().catch(backgroundFailed);
        void poll().catch(backgroundFailed);
      });
      if (!background) attachDesktop(root);
      cloud.watch((event) => {
        if (event === "open" || event === "update") void updater.check().catch(backgroundFailed);
        if (event === "update") return;
        void host.refreshControl().catch(() => {});
        void poll().catch(backgroundFailed);
      });
      setInterval(() => void poll().catch(backgroundFailed), 60000);
      updater.start();
      setInterval(() => {
        if (updater.status.phase === "waiting") {
          void poll().catch(backgroundFailed);
          updater.tryInstall();
        }
      }, 5000);
      void poll().catch(backgroundFailed);
    })
    .catch((error) => {
      const reason = /^[A-Z_]+$/.test(error.message)
        ? error.message
        : "请检查安装完整性，并重新安装 TaskRelay。";
      if (background) process.stderr.write(`TaskRelay: ${reason}\n`);
      else dialog.showErrorBox("TaskRelay 启动失败", reason);
      app.exit(1);
    });
}
