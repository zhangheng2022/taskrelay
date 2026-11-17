/** Windows 服务配置与命令入口。普通桌面不能读取服务文件，安装器只取固定渠道的已签名产物。 */
import { execFile, spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { z } from "zod";
import certificate from "../../../../resources/signing/certificate-info.json";
import {
  SERVICE_UPDATE_PATH,
  servicePackagePath,
  serviceReleaseSchema,
  serviceSetupName,
  UPDATE_ORIGIN,
  type ServiceRelease,
} from "../../../../packages/contracts/src/updates";

const exec = promisify(execFile);
const serviceReply = z.union([
  z.object({ ok: z.literal(true), value: z.unknown().optional() }).strict(),
  z.object({ ok: z.literal(false), error: z.string().max(1000) }).strict(),
]);
const request = z.object({ method: z.string().max(45), input: z.unknown().optional() }).strict();
const serviceManifest = z.object({ release: serviceReleaseSchema.nullable() }).strict();
const senderKey = /^[a-z0-9+/]{43}=$/i;

export function readServiceEnvironment(env: Record<string, string | undefined>) {
  const key = env.TASKRELAY_SERVICE_KEY;
  const channel = env.TASKRELAY_SERVICE_CHANNEL;
  const directory = env.TASKRELAY_SERVICE_DATA;
  if (
    !key ||
    !senderKey.test(key) ||
    !channel ||
    !/^TaskRelay\.Executor\.Worker\.[a-f0-9]{32}$/.test(channel) ||
    !directory ||
    !path.win32.isAbsolute(directory)
  )
    throw Error("SERVICE_ENVIRONMENT_INVALID");
  delete env.TASKRELAY_SERVICE_KEY;
  delete env.TASKRELAY_SERVICE_CHANNEL;
  delete env.TASKRELAY_SERVICE_DATA;
  return { key, channel, directory };
}

export function serveServiceCommands(
  configuration: ReturnType<typeof readServiceEnvironment>,
  invoke: (method: string, input: unknown) => unknown,
  afterReply: (method: string) => void,
  socketPath = "\\\\.\\pipe\\" + configuration.channel,
) {
  const key = Buffer.from(configuration.key);
  return createServer((socket) => {
    socket.on("error", () => {});
    socket.setTimeout(6000, () => socket.destroy());
    let input = Buffer.alloc(0);
    let received = false;
    socket.on("data", (chunk) => {
      if (received) return;
      input = Buffer.concat([input, chunk]);
      if (input.length > 16384) return socket.destroy();
      if (input.at(-1) !== 10) return;
      received = true;
      socket.setTimeout(0);
      const separator = input.indexOf(32);
      const token = input.subarray(0, separator);
      if (token.length !== key.length || !timingSafeEqual(token, key)) return socket.destroy();
      void (async () => {
        let method = "";
        try {
          const parsed = request.parse(JSON.parse(input.subarray(separator + 1).toString()));
          method = parsed.method;
          const value = await invoke(method, parsed.input);
          socket.end(JSON.stringify({ ok: true, value }) + "\n", () => afterReply(method));
        } catch (error) {
          const reason = error instanceof Error ? error.message : "SERVICE_COMMAND_FAILED";
          socket.end(JSON.stringify({ ok: false, error: reason.slice(0, 1000) }) + "\n");
        }
      })().catch(() => socket.destroy());
    });
  }).listen(socketPath);
}

export async function fetchServiceRelease(fetcher = fetch): Promise<ServiceRelease | null> {
  const response = await fetcher(`${UPDATE_ORIGIN}${SERVICE_UPDATE_PATH}/latest.json`, {
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || !response.body) throw Error("无法检查开机服务版本，请稍后重试。");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(
    response.body as Parameters<typeof Readable.fromWeb>[0],
  )) {
    size += chunk.length;
    if (size > 16000) throw Error("SERVICE_MANIFEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return serviceManifest.parse(JSON.parse(Buffer.concat(chunks).toString())).release;
}

export async function downloadServiceRelease(
  release: ServiceRelease,
  file: string,
  fetcher = fetch,
) {
  const response = await fetcher(UPDATE_ORIGIN + servicePackagePath(release), {
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (
    response.status !== 200 ||
    Number(response.headers.get("content-length")) !== release.bytes ||
    !response.body
  ) {
    await response.body?.cancel();
    throw Error("SERVICE_DOWNLOAD_SIZE_INVALID");
  }
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (bytes > release.bytes) return done(Error("SERVICE_DOWNLOAD_SIZE_INVALID"));
        hash.update(chunk);
        done(null, chunk);
      },
    }),
    createWriteStream(file, { flags: "wx" }),
  );
  if (bytes !== release.bytes) throw Error("SERVICE_DOWNLOAD_SIZE_INVALID");
  if (hash.digest("hex") !== release.sha256) throw Error("SERVICE_DOWNLOAD_HASH_INVALID");
}

type ServiceInfo = { mode: "auto" | "manual"; running: boolean };
const commandTimeout = 55_000;
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const windowsOperations = {
  exists: existsSync,
  execute: async (file: string, args: string[], timeout: number) =>
    exec(file, args, { windowsHide: true, timeout }),
  spawn: (file: string) =>
    spawn(file, ["call"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }),
  download: downloadServiceRelease,
};
export class WindowsService {
  private readonly system = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  private readonly helper = path.join(
    process.env.ProgramW6432 ?? process.env.ProgramFiles ?? "C:\\Program Files",
    "TaskRelayService",
    "bin",
    "TaskRelay.Service.exe",
  );
  constructor(
    readonly supported: boolean,
    private readonly native = windowsOperations,
  ) {}

  async info(): Promise<ServiceInfo | null> {
    if (!this.supported) return null;
    if (!this.native.exists(this.helper)) {
      const registered = await this.native
        .execute(
          path.join(this.system, "reg.exe"),
          ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Services\\TaskRelayExecutor", "/v", "Start"],
          4000,
        )
        .then(
          () => true,
          () => false,
        );
      if (registered) throw Error("开机服务正在更新或安装不完整，请稍后重试。");
      return null;
    }
    const { stdout } = await this.native.execute(this.helper, ["info"], 6000);
    const result = stdout.trim();
    if (result === "absent") return null;
    if (result === "denied") throw Error("只有配置此服务的 Windows 账户可以管理执行器。");
    if (result === "auto online") return { mode: "auto", running: true };
    if (result === "auto offline") return { mode: "auto", running: false };
    if (result === "manual online") return { mode: "manual", running: true };
    if (result === "manual offline") return { mode: "manual", running: false };
    throw Error("SERVICE_STATUS_INVALID");
  }

  async start() {
    await this.native.execute(this.helper, ["start"], 15000);
  }

  async call(method: string, input?: unknown): Promise<unknown> {
    const message = JSON.stringify({ method, input });
    const value = await new Promise<string>((resolve, reject) => {
      const child = this.native.spawn(this.helper);
      let bytes = 0;
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => child.kill(), commandTimeout);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 262144) child.kill();
        else chunks.push(chunk);
      });
      child.stdin.on("error", reject);
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(chunks).toString());
        else reject(Error("后台服务未响应，请稍后重试。"));
      });
      child.stdin.end(message + "\n");
    });
    const reply = serviceReply.parse(JSON.parse(value));
    if (!reply.ok) throw Error(reply.error);
    return reply.value;
  }

  async prepareInstall(release: ServiceRelease, directory: string) {
    await mkdir(directory, { recursive: true });
    const stage = await mkdtemp(path.join(directory, "service-"));
    const file = path.join(stage, serviceSetupName);
    const cleanup = () => rm(stage, { recursive: true, force: true });
    try {
      await this.native.download(release, file);
      const { stdout } = await this.native.execute(
        path.join(this.system, "whoami.exe"),
        ["/user", "/fo", "csv", "/nh"],
        6000,
      );
      const sid = /,"(S-1-5-21-\d+-\d+-\d+-\d+)"\s*$/i.exec(stdout.trim())?.[1];
      if (!sid) throw Error("无法识别当前 Windows 账户。");
      return { run: () => this.elevated(file, sid, release.sha256), cleanup };
    } catch (error) {
      await cleanup().catch(() => {});
      throw error;
    }
  }

  setStartup(enabled: boolean) {
    return this.elevated(this.helper, enabled ? "enable" : "disable");
  }

  private async elevated(file: string, argument: string, sha256?: string) {
    // 保持只读句柄直到 UAC 后的进程返回，绑定已校验的同一文件；不提升 PowerShell。
    const code = `
$ErrorActionPreference='Stop'
$path=${quote(file)}
$locked=[IO.File]::Open($path,'Open','Read','Read')
try {
  $signature=Get-AuthenticodeSignature -LiteralPath $path
  if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) { exit 11 }
  $sha=[Security.Cryptography.SHA256]::Create()
  try { $fingerprint=[BitConverter]::ToString($sha.ComputeHash($signature.SignerCertificate.RawData)).Replace('-','') }
  finally { $sha.Dispose() }
  if ($fingerprint -ne ${quote(certificate.sha256)}) { exit 11 }
  ${sha256 ? `if ((Get-FileHash -InputStream $locked -Algorithm SHA256).Hash -ne ${quote(sha256)}) { exit 11 }` : ""}
  try { $child=Start-Process -FilePath $path -ArgumentList ${quote(argument)} -Verb RunAs -PassThru -Wait }
  catch {
    $problem=$_.Exception
    while ($problem) {
      if ($problem -is [ComponentModel.Win32Exception] -and $problem.NativeErrorCode -eq 1223) { exit 12 }
      $problem=$problem.InnerException
    }
    throw
  }
  if ($child.ExitCode -ne 0) { exit 13 }
} finally { $locked.Dispose() }
`;
    try {
      await this.native.execute(
        path.join(this.system, "WindowsPowerShell", "v1.0", "powershell.exe"),
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(code, "utf16le").toString("base64"),
        ],
        10 * 60_000,
      );
    } catch (error) {
      const status = (error as { code?: number }).code;
      if (status === 11) throw Error("安装包签名或文件不匹配，请重新检查更新。");
      if (status === 12) throw Error("SERVICE_UAC_CANCELLED");
      throw Error("Windows 服务配置失败，可以稍后重试。");
    }
  }
}
