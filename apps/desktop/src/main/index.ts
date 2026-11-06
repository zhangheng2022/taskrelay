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
import { z } from "zod";
import { Journal } from "./journal";
import { Cloud } from "./cloud";
import { OwnedBrowser } from "./browser";
import { ProtectedStateFiles } from "./protected-state";
import { prepareExtension } from "./extension";
import { ExecutorHost } from "./executor-host";
import { DesktopUpdater } from "./updater";
import { RunnerPoller } from "./runner-poller";
import { loginSettings } from "./login";
import { releaseSchema } from "../../../../packages/contracts/src/updates";
import { cloudUrlSchema } from "../shared/ipc";
import type { DesktopStatus } from "../../../../packages/contracts/src/index";
import { packagedSmoke } from "./smoke";
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;
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
let updatePrompt = false;
let login: ReturnType<typeof loginSettings>;
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
function status(): DesktopStatus {
  return {
    update: updater.status,
    paired: cloud.paired,
    cloudUrl: cloud.url,
    paused: journal.get<boolean>("paused") ?? false,
    online: cloud.online,
    activeRunId: host.active,
    version: app.getVersion(),
    autoStart: login.enabled(),
    error: lastError,
  };
}
function notify() {
  window?.webContents.send("taskrelay:changed");
}
function show() {
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
    title: "TaskRelay 执行器",
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
function registerIpc() {
  const handle = (name: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(`taskrelay:${name}`, async (event, ...args) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("IPC_SENDER_REJECTED");
      return fn(...args);
    });
  handle("status", () => status());
  handle("configure", async (input: unknown) => {
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
    }>(
      "POST",
      "/api/pair/start",
      { name: require("node:os").hostname(), protocolVersion: PROTOCOL_VERSION },
      true,
    );
    if (new URL(result.url).origin !== url) throw new Error("PAIRING_URL_MISMATCH");
    pairing = { id: result.id, pollToken: result.pollToken };
    await shell.openExternal(result.url);
    notify();
    return { url: result.url, code: result.code };
  });
  handle("pairPoll", async () => {
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
      return true;
    }
    return false;
  });
  handle("pause", (v: unknown) => {
    journal.set("paused", z.boolean().parse(v));
    notify();
  });
  handle("autoStart", (v: unknown) => {
    login.setEnabled(z.boolean().parse(v));
    notify();
  });
  handle("stop", () => host.stop(true));
  handle("checkUpdate", () => updater.check());
  handle("downloadUpdate", async (input: unknown) => {
    const version = releaseSchema.shape.version.parse(input);
    const update = updater.status;
    if (
      updatePrompt ||
      !["available", "error"].includes(update.phase) ||
      update.release?.version !== version
    )
      return;
    updatePrompt = true;
    try {
      const answer = await dialog.showMessageBox(window!, {
        type: "question",
        title: "更新 TaskRelay 执行器",
        message: `下载并安装 ${version}？`,
        detail:
          "确认后通过 Cloudflare 下载更新。下载完成后暂停领取新任务，等待当前任务（包括人工协助）和结果回传结束，再自动安装并重启。",
        buttons: ["暂不更新", "确认下载并安装"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response === 1) void updater.download(version).catch(() => {});
    } finally {
      updatePrompt = false;
    }
  });
  handle("diagnostics", async () => {
    const result = await dialog.showSaveDialog(window!, {
      defaultPath: `TaskRelay-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return "已取消导出";
    await writeFile(
      result.filePath,
      JSON.stringify(
        {
          version: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          state: { online, active: host.active, paused: status().paused },
          ...journal.diagnostic(),
        },
        null,
        2,
      ),
    );
    return `诊断已保存：${result.filePath}`;
  });
}
async function poll() {
  await poller.poll();
}
async function quit() {
  if (quitting) return;
  if (updater?.status.phase === "installing") {
    show();
    return;
  }
  quitting = true;
  cloud?.close();
  try {
    await host?.stop(true);
  } catch {
    quitting = false;
    lastError = "PROCESS_CLEANUP_FAILED";
    show();
    return;
  }
  journal?.close();
  updater?.stop();
  tray?.destroy();
  app.exit(0);
}
if (squirrelStartup || !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", show);
  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      void quit().catch(backgroundFailed);
    }
  });
  app.on("window-all-closed", () => {});
  void app
    .whenReady()
    .then(async () => {
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
      const extensionPath = await prepareExtension(
        path.join(root, "stagehand-extension"),
        path.join(userData, "runtime-extensions"),
      );
      journal = new Journal(userData);
      cloud = new Cloud(journal);
      const browser = new OwnedBrowser(
        path.join(root, "browser"),
        path.join(userData, "profiles"),
        journal,
        extensionPath,
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
        blocksClaims: () => updater.blocksClaims,
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
      login = loginSettings(app, loginLaunchPath());
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
          tray?.setToolTip(`TaskRelay · 发现新版本 ${release.version}`);
          if (Notification.isSupported()) {
            const notification = new Notification({
              title: "TaskRelay 有新版本",
              body: `${release.version} 已可用，点击查看并确认更新。`,
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
          autoUpdater.quitAndInstall();
        },
      });
      const rendererRoot = path.resolve(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
      protocol.handle("taskrelay", (request) => {
        const u = new URL(request.url);
        if (u.host !== "app") return new Response(null, { status: 403 });
        const target = path.resolve(rendererRoot, "." + decodeURIComponent(u.pathname));
        if (!target.startsWith(rendererRoot + path.sep)) return new Response(null, { status: 403 });
        return electronNet.fetch(pathToFileURL(target).toString());
      });
      registerIpc();
      const icon = nativeImage.createFromPath(path.join(root, "icon.png"));
      tray = new Tray(icon);
      tray.setToolTip("TaskRelay");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "打开 TaskRelay", click: show },
          {
            label: "暂停 / 继续领取",
            click: () => {
              journal.set("paused", !status().paused);
              notify();
            },
          },
          { type: "separator" },
          {
            label: "检查版本更新",
            click: () => {
              show();
              void updater.check().catch(backgroundFailed);
            },
          },
          { label: "退出 TaskRelay", click: () => void quit().catch(backgroundFailed) },
        ]),
      );
      tray.on("double-click", show);
      powerMonitor.on("suspend", () => {
        void host.stop(true).catch(() => {});
      });
      powerMonitor.on("resume", () => void poll().catch(backgroundFailed));
      createWindow();
      cloud.watch(() => {
        void host.refreshControl().catch(() => {});
        void poll().catch(backgroundFailed);
      });
      setInterval(() => void poll().catch(backgroundFailed), 60000);
      setTimeout(() => void updater.check().catch(backgroundFailed), 15000);
      setInterval(() => void updater.check().catch(backgroundFailed), 6 * 60 * 60 * 1000);
      setInterval(() => {
        if (updater.status.phase === "waiting") {
          void poll().catch(backgroundFailed);
          updater.tryInstall();
        }
      }, 5000);
      void poll().catch(backgroundFailed);
    })
    .catch((error) => {
      dialog.showErrorBox(
        "TaskRelay 启动失败",
        /^[A-Z_]+$/.test(error.message)
          ? error.message
          : "请检查安装完整性，并重新安装 TaskRelay。",
      );
      app.exit(1);
    });
}
