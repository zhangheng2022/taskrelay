import { spawn, execFile, type ChildProcess } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { Journal } from "./journal";
const exec = promisify(execFile);
/** 按 Profile 启动并回收应用自有 Chromium，记录进程所有权并配置代理、调试与下载边界。
 * launch/close 共享生命周期状态，避免停止期间的异步启动重新留下浏览器进程。
 */
export class OwnedBrowser {
  private child: ChildProcess | null = null;
  private generation = 0;
  private launching: Promise<{ cdpUrl: string }> | null = null;
  private closing: Promise<void> | null = null;
  private debuggerUrl:string|null=null;
  constructor(
    private directory: string,
    private profiles: string,
    private journal: Journal,
    private extensionPath?: string,
  ) {}
  async recover() {
    const record = this.journal.get<{
      pid: number;
      profile: string;
      executable: string;
    }>("ownedBrowser");
    if (!record) return;
    const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
    // PID alone is not ownership. Check both executable and exact profile argument before cleanup.
    const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(record.pid)}'; if($p -and $p.ExecutablePath -eq ${quote(record.executable)} -and $p.CommandLine.Contains(${quote("--user-data-dir=" + record.profile)})){ & taskkill.exe /PID ${Number(record.pid)} /T /F | Out-Null; $remaining=Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(record.pid)}'; if($remaining -and $remaining.ExecutablePath -eq ${quote(record.executable)} -and $remaining.CommandLine.Contains(${quote("--user-data-dir=" + record.profile)})){ throw 'BROWSER_RECOVERY_FAILED' } }`;
    await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 15000 },
    );
    this.journal.set("ownedBrowser", null);
  }
  launch(accountId: string, proxyPort: number): Promise<{ cdpUrl: string }> {
    if (this.child || this.launching || this.closing)
      return Promise.reject(new Error("BROWSER_ALREADY_RUNNING"));
    const generation = ++this.generation;
    const guard = () => {
      if (generation !== this.generation) throw new Error("BROWSER_START_CANCELLED");
    };
    const pending = this.launchOwned(accountId, proxyPort, guard);
    this.launching = pending;
    void pending.finally(() => {
      if (this.launching === pending) this.launching = null;
    }).catch(() => {});
    return pending;
  }
  private async launchOwned(accountId: string, proxyPort: number, guard: () => void) {
    if (
      !/^[a-zA-Z0-9_-]{1,110}$/.test(accountId) ||
      !Number.isInteger(proxyPort) ||
      proxyPort < 1 ||
      proxyPort > 65535
    )
      throw new Error("BROWSER_ARGUMENT_INVALID");
    const manifest = JSON.parse(
      await readFile(path.join(this.directory, "manifest.json"), "utf8"),
    );
    guard();
    const executable = path.join(this.directory, manifest.executable);
    const actual = createHash("sha256")
      .update(await readFile(executable))
      .digest("hex");
    guard();
    if (actual !== manifest.executableSha256)
      throw new Error("BROWSER_INTEGRITY_FAILED");
    const profile = path.join(this.profiles, accountId);
    await mkdir(profile, { recursive: true });
    guard();
    const extensionManifest = JSON.parse(
      await readFile(
        path.join(this.directory, "../stagehand-extension/manifest.json"),
        "utf8",
      ),
    );
    guard();
    if (!extensionManifest.key) throw new Error("EXTENSION_IDENTITY_REQUIRED");
    const extensionId = createHash("sha256")
      .update(Buffer.from(extensionManifest.key, "base64"))
      .digest("hex")
      .slice(0, 32)
      .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
    const port = await new Promise<number>((resolve, reject) => {
      const s = net.createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    guard();
    const args = [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--enable-unsafe-extension-debugging",
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      "--proxy-bypass-list=<-loopback>",
      "--window-size=1280,800",
      "about:blank",
    ];
    args.unshift(`--remote-allow-origins=chrome-extension://${extensionId}`);
    // 在浏览器启动时加载本轮内容寻址的扩展，避免 SDK 先发现 Profile 中的旧版。
    // 路径只来自 Main 校验过的自有资源，站点 Cookie 和 Profile 继续保留。
    if(this.extensionPath)args.unshift(`--load-extension=${this.extensionPath}`,`--disable-extensions-except=${this.extensionPath}`);
    args[args.findIndex((a) => a.startsWith("--proxy-bypass-list="))] =
      `--proxy-bypass-list=<-loopback>;127.0.0.1:${port}`;
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child = child;
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    this.journal.set("ownedBrowser", { pid: child.pid, profile, executable });
    guard();
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      guard();
      if (child.exitCode !== null) throw new Error("BROWSER_START_FAILED");
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(1000),
        });
        if (r.ok) {
          const info = (await r.json()) as { webSocketDebuggerUrl: string };
          this.debuggerUrl=info.webSocketDebuggerUrl;
          await this.browserCommand(info.webSocketDebuggerUrl,'Browser.setDownloadBehavior',{behavior:'deny'});
          guard();
          return { cdpUrl: `http://127.0.0.1:${port}` };
        }
      } catch {
        /* startup */
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    await this.closeChild();
    throw new Error("BROWSER_START_TIMEOUT");
  }
  private async browserCommand(url:string,method:string,params:Record<string,unknown>={}) {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("DOWNLOAD_POLICY_TIMEOUT"));
      }, 4000);
      socket.onopen = () =>
        socket.send(
          JSON.stringify({
            id: 1,
            method,
            params,
          }),
        );
      socket.onmessage = (event) => {
        try {
          const reply = JSON.parse(String(event.data));
          if (reply.id === 1) {
            clearTimeout(timer);
            socket.close();
            reply.error
              ? reject(new Error("DOWNLOAD_POLICY_FAILED"))
              : resolve();
          }
        } catch {
          clearTimeout(timer);
          socket.close();
          reject(new Error("CDP_RESPONSE_INVALID"));
        }
      };
      socket.onerror = () => {
        clearTimeout(timer);
        socket.close();
        reject(new Error("CDP_CONNECTION_FAILED"));
      };
      if(method==='Browser.close')socket.onclose=()=>{clearTimeout(timer);resolve();};
    });
  }
  close(graceful=false): Promise<void> {
    if (this.closing) return this.closing;
    ++this.generation;
    const pending = this.launching;
    this.closing = (async () => {
      // Invalidate before waiting: an in-flight launch can no longer spawn or succeed.
      await pending?.catch(() => {});
      await this.closeChild(graceful);
    })().finally(() => { this.closing = null; });
    return this.closing;
  }
  private async closeChild(graceful=false) {
    const child = this.child;
    if (!child) return;
    if(graceful&&child.exitCode===null&&this.debuggerUrl){
      await this.browserCommand(this.debuggerUrl,'Browser.close').catch(()=>{});
      if(child.exitCode===null)await new Promise<void>(resolve=>{const timer=setTimeout(done,3000);function done(){clearTimeout(timer);child!.off('exit',done);resolve();}child.once('exit',done);});
    }
    if (child.exitCode === null && child.pid) {
      await exec("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 15000,
      }).catch((error) => {
        if (child.exitCode === null) throw error;
      });
      if (child.exitCode === null)
        await Promise.race([
          new Promise<void>((r) => child.once("exit", () => r())),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("BROWSER_EXIT_TIMEOUT")), 5000),
          ),
        ]);
    }
    this.child = null;
    this.debuggerUrl=null;
    this.journal.set("ownedBrowser", null);
  }
}
