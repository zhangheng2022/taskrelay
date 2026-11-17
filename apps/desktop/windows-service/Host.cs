// Windows SCM 桥接。桌面用户与服务数据隔离；只有登记的账户能通过本机管道调用命名入口。
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;
using TimeoutException = System.TimeoutException;

internal static class Host
{
    internal const string Name = "TaskRelayExecutor";
    internal const string Settings = @"SOFTWARE\TaskRelay\ExecutorService";
    internal const string Channel = "TaskRelay.Executor.v1";
    internal static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "TaskRelayService");
    internal static readonly string Data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "TaskRelayService", "state");
    internal static readonly string Bin = Path.Combine(Root, "bin");
    internal static readonly Encoding Utf8 = new UTF8Encoding(false, true);
    internal static readonly SecurityIdentifier SystemSid = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
    internal static readonly SecurityIdentifier AdministratorSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);

    internal static SecurityIdentifier Owner()
    {
        using (var key = Registry.LocalMachine.OpenSubKey(Settings))
        {
            if (key == null) throw new InvalidOperationException("SERVICE_NOT_INSTALLED");
            return new SecurityIdentifier((string)key.GetValue("Owner"));
        }
    }

    internal static int StartType()
    {
        using (var key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\" + Name))
            return key == null ? -1 : (int)key.GetValue("Start", -1);
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr OpenSCManager(string machine, string database, uint access);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr OpenService(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool CloseServiceHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool QueryServiceStatusEx(IntPtr service, int level, byte[] buffer, int size, out int needed);

    internal static uint ServicePid()
    {
        var manager = OpenSCManager(null, null, 1);
        if (manager == IntPtr.Zero) return 0;
        try
        {
            var service = OpenService(manager, Name, 4);
            if (service == IntPtr.Zero) return 0;
            try
            {
                var result = new byte[36];
                int needed;
                return QueryServiceStatusEx(service, 0, result, result.Length, out needed)
                    ? BitConverter.ToUInt32(result, 28) : 0;
            }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }

    internal static string ReadLine(Stream stream, int limit, int timeout)
    {
        using (var buffer = new MemoryStream())
        {
            var block = new byte[4096];
            var watch = Stopwatch.StartNew();
            while (buffer.Length < limit)
            {
                int remaining = timeout - (int)watch.ElapsedMilliseconds;
                if (remaining <= 0) throw new TimeoutException("SERVICE_TIMEOUT");
                var read = stream.ReadAsync(block, 0, Math.Min(block.Length, limit - (int)buffer.Length));
                if (!read.Wait(remaining)) throw new TimeoutException("SERVICE_TIMEOUT");
                if (read.Result == 0) throw new IOException("SERVICE_CLOSED");
                var end = Array.IndexOf(block, (byte)10, 0, read.Result);
                buffer.Write(block, 0, end < 0 ? read.Result : end);
                if (end >= 0) return Utf8.GetString(buffer.ToArray());
            }
        }
        throw new IOException("SERVICE_MESSAGE_TOO_LARGE");
    }

    internal static void WriteLine(Stream stream, string message)
    {
        var bytes = Utf8.GetBytes(message + "\n");
        var write = stream.WriteAsync(bytes, 0, bytes.Length);
        if (!write.Wait(6000)) throw new TimeoutException("SERVICE_TIMEOUT");
    }

    internal static string Call(string request)
    {
        var expected = ServicePid();
        if (expected == 0) throw new IOException("SERVICE_OFFLINE");
        using (var pipe = new NamedPipeClientStream(".", Channel, PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize,
            PipeOptions.Asynchronous, TokenImpersonationLevel.Identification, HandleInheritability.None))
        {
            pipe.Connect(5000);
            uint pid;
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out pid) || pid != expected)
                throw new IOException("SERVICE_IDENTITY_MISMATCH");
            WriteLine(pipe, request);
            return ReadLine(pipe, 262144, 45000);
        }
    }

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "service")
            {
                ServiceBase.Run(new RelayService());
                return 0;
            }
            if (args.Length == 1 && args[0] == "info")
            {
                var mode = StartType();
                if (mode < 0) { Console.WriteLine("absent"); return 0; }
                if (!Owner().Equals(WindowsIdentity.GetCurrent().User)) { Console.WriteLine("denied"); return 0; }
                Console.WriteLine((mode == 2 ? "auto" : "manual") + " " + (ServicePid() > 0 ? "online" : "offline"));
                return 0;
            }
            if (args.Length == 1 && args[0] == "call")
            {
                Console.WriteLine(Call(ReadLine(Console.OpenStandardInput(), 16384, 6000)));
                return 0;
            }
            if (args.Length == 1 && args[0] == "start")
            {
                using (var service = new ServiceController(Name))
                    if (service.Status == ServiceControllerStatus.Stopped) service.Start();
                return 0;
            }
            if (args.Length == 1 && (args[0] == "enable" || args[0] == "disable"))
            {
                var enable = args[0] == "enable";
                InstallOperations.SetStartup(enable);
                return 0;
            }
        }
        catch { return 1; }
        return 2;
    }
}

internal sealed class RelayService : ServiceBase
{
    private volatile bool stopping;
    private Process child;
    private string channel;
    private string key;
    private readonly SemaphoreSlim slots = new SemaphoreSlim(12);
    private readonly object guard = new object();
    private NamedPipeServerStream listener;
    private Job job;

    internal RelayService()
    {
        ServiceName = Host.Name;
        CanShutdown = true;
        CanStop = true;
    }

    protected override void OnStart(string[] args)
    {
        var owner = Host.Owner();
        var bootSecret = new byte[32];
        using (var random = RandomNumberGenerator.Create()) random.GetBytes(bootSecret);
        channel = "TaskRelay.Executor.Worker." + Guid.NewGuid().ToString("N");
        key = Convert.ToBase64String(bootSecret);
        Array.Clear(bootSecret, 0, bootSecret.Length);
        var start = new ProcessStartInfo(Path.Combine(Host.Bin, "TaskRelay.exe"), "--taskrelay-service")
        {
            WorkingDirectory = Host.Bin, UseShellExecute = false, CreateNoWindow = true
        };
        start.EnvironmentVariables["TASKRELAY_SERVICE_CHANNEL"] = channel;
        start.EnvironmentVariables["TASKRELAY_SERVICE_KEY"] = key;
        start.EnvironmentVariables["TASKRELAY_SERVICE_DATA"] = Host.Data;
        job = new Job();
        try
        {
            child = Process.Start(start);
            job.Add(child);
        }
        catch
        {
            if (child != null && !child.HasExited) child.Kill();
            job.Dispose();
            throw;
        }
        new Thread(() => Listen(owner)) { IsBackground = true }.Start();
        new Thread(() =>
        {
            child.WaitForExit();
            if (!stopping && child.ExitCode != 0) Environment.Exit(1);
            if (!stopping) Stop();
        }) { IsBackground = true }.Start();
    }

    private void Listen(SecurityIdentifier owner)
    {
        var access = new PipeSecurity();
        access.SetAccessRuleProtection(true, false);
        access.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
        access.AddAccessRule(new PipeAccessRule(owner, PipeAccessRights.ReadWrite, AccessControlType.Allow));
        access.AddAccessRule(new PipeAccessRule(Host.AdministratorSid, PipeAccessRights.ReadWrite, AccessControlType.Allow));
        access.AddAccessRule(new PipeAccessRule(Host.SystemSid, PipeAccessRights.FullControl, AccessControlType.Allow));
        access.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
        while (!stopping)
        {
            NamedPipeServerStream pipe;
            try
            {
                lock (guard)
                {
                    if (stopping) return;
                    pipe = new NamedPipeServerStream(Host.Channel, PipeDirection.InOut, 16, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, access);
                    listener = pipe;
                }
                pipe.WaitForConnection();
            }
            catch
            {
                if (!stopping) Environment.Exit(1);
                return;
            }
            lock (guard) { if (listener == pipe) listener = null; }
            if (!slots.Wait(0)) { pipe.Dispose(); continue; }
            ThreadPool.QueueUserWorkItem(_ =>
            {
                using (pipe)
                {
                    try { Host.WriteLine(pipe, CallWorker(Host.ReadLine(pipe, 16384, 6000))); }
                    catch { }
                    finally { slots.Release(); }
                }
            });
        }
    }

    private string CallWorker(string request)
    {
        using (var pipe = new NamedPipeClientStream(".", channel, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification))
        {
            pipe.Connect(5000);
            uint pid;
            if (!Host.GetNamedPipeServerProcessId(pipe.SafePipeHandle, out pid) || pid != (uint)child.Id)
                throw new IOException("WORKER_IDENTITY_MISMATCH");
            // 每次请求独立认证，密钥只在服务账户的两个进程间传递。
            Host.WriteLine(pipe, key + " " + request);
            return Host.ReadLine(pipe, 262144, 45000);
        }
    }

    protected override void OnStop() { RequestAdditionalTime(60000); StopWorker(); }
    protected override void OnShutdown() { StopWorker(); }

    private void StopWorker()
    {
        lock (guard)
        {
            stopping = true;
            if (listener != null) listener.Dispose();
        }
        try
        {
            if (child != null && !child.HasExited)
            {
                try { CallWorker("{\"method\":\"quit\"}"); } catch { }
                child.WaitForExit(12000);
            }
        }
        finally { if (job != null) job.Dispose(); }
    }
}
