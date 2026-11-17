// 签名的自包含安装包。服务程序和运行时来自内嵌产物，管理员进程不读取用户脚本或凭据。
using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Principal;
using System.ServiceProcess;
using System.Threading;
using Microsoft.Win32;

internal static class Setup
{
    private const string Payload = "TaskRelay.Payload";

    public static int Main(string[] args)
    {
        try
        {
            InstallOperations.RequireAdmin();
            if (args.Length != 1) return 2;
            var owner = new SecurityIdentifier(args[0]);
            if (owner.IsWellKnown(WellKnownSidType.LocalSystemSid) || owner.IsWellKnown(WellKnownSidType.LocalServiceSid) ||
                owner.IsWellKnown(WellKnownSidType.NetworkServiceSid))
                return 2;
            owner.Translate(typeof(NTAccount));
            using (var mutex = new Mutex(false, @"Global\TaskRelayServiceSetup"))
            {
                if (!mutex.WaitOne(0)) return 3;
                try { Install(owner); }
                finally { mutex.ReleaseMutex(); }
            }
            return 0;
        }
        catch (InvalidOperationException) { return 4; }
        catch { return 5; }
    }

    private static void Install(SecurityIdentifier owner)
    {
        var oldMode = Host.StartType();
        if (oldMode >= 0)
        {
            if (!Host.Owner().Equals(owner)) throw new InvalidOperationException("SERVICE_OWNER_MISMATCH");
            InstallOperations.WaitStopped();
        }
        Directory.CreateDirectory(Host.Root);
        if ((File.GetAttributes(Host.Root) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("SERVICE_PATH_REPARSE_POINT");
        var stage = Path.Combine(Host.Root, "stage-" + Guid.NewGuid().ToString("N"));
        var backup = Path.Combine(Host.Root, "previous-" + Guid.NewGuid().ToString("N"));
        dynamic oldTask = FindLegacyTask(owner);
        bool disabledLegacy = false, createdService = false, movedOld = false, movedNew = false;
        try
        {
            Extract(stage);
            var browser = Path.Combine(stage, "resources", "browser", "chrome-win64");
            InstallOperations.Win("icacls.exe", InstallOperations.Quote(browser) + " /grant *S-1-15-2-2:(OI)(CI)(RX) /T /Q");
            if (oldTask != null && (bool)oldTask.Enabled)
            {
                oldTask.Enabled = false;
                disabledLegacy = true;
            }
            if (oldTask != null && (int)oldTask.State == 4) throw new InvalidOperationException("LEGACY_TASK_IS_RUNNING");
            if (Directory.Exists(Host.Bin)) { Directory.Move(Host.Bin, backup); movedOld = true; }
            Directory.Move(stage, Host.Bin);
            movedNew = true;
            if (oldMode < 0)
            {
                var exe = InstallOperations.Quote(Path.Combine(Host.Bin, "TaskRelay.Service.exe")) + " service";
                InstallOperations.Win("sc.exe", "create " + Host.Name + " binPath= " + InstallOperations.Quote(exe) +
                    " obj= \"NT SERVICE\\" + Host.Name + "\" start= demand DisplayName= \"TaskRelay Executor\"");
                createdService = true;
                InstallOperations.Win("sc.exe", "sdset " + Host.Name + " " +
                    "D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;LCRP;;;" + owner.Value + ")");
                InstallOperations.Win("sc.exe", "failure " + Host.Name + " reset= 86400 actions= restart/10000/restart/30000/restart/60000");
                using (var settings = Registry.LocalMachine.CreateSubKey(Host.Settings))
                    settings.SetValue("Owner", owner.Value, RegistryValueKind.String);
                InstallOperations.SetStartup(true);
            }
            var serviceSid = (SecurityIdentifier)new NTAccount(@"NT SERVICE\" + Host.Name).Translate(typeof(SecurityIdentifier));
            var dataParent = Path.GetDirectoryName(Host.Data);
            if (!Directory.Exists(dataParent)) Directory.CreateDirectory(dataParent, InstallOperations.PrivateAcl(serviceSid));
            InstallOperations.CheckPrivateDirectory(dataParent, serviceSid);
            if (!Directory.Exists(Host.Data)) Directory.CreateDirectory(Host.Data, InstallOperations.PrivateAcl(serviceSid));
            InstallOperations.CheckPrivateDirectory(Host.Data, serviceSid);
            using (var service = new ServiceController(Host.Name))
            {
                service.Start();
                service.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(35));
            }
            var ready = false;
            var deadline = DateTime.UtcNow.AddSeconds(45);
            while (!ready && DateTime.UtcNow < deadline)
            {
                try { ready = Host.Call("{\"method\":\"status\"}").StartsWith("{\"ok\":true,"); }
                catch { Thread.Sleep(500); }
            }
            if (!ready) throw new InvalidOperationException("SERVICE_STARTUP_FAILED");
        }
        catch
        {
            // 回滚仍以 SCM 的实际状态为准，避免覆盖正在使用的安装目录。
            if (movedNew) Try(() =>
            {
                using (var service = new ServiceController(Host.Name))
                {
                    if (service.Status != ServiceControllerStatus.Stopped) service.Stop();
                    service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(70));
                }
            });
            if (createdService && Host.ServicePid() == 0)
                Try(() =>
                {
                    InstallOperations.Win("sc.exe", "delete " + Host.Name);
                    Registry.LocalMachine.DeleteSubKey(Host.Settings, false);
                });
            if (movedNew && Host.ServicePid() == 0)
            {
                Try(() => Directory.Move(Host.Bin, stage));
                if (movedOld) Try(() => Directory.Move(backup, Host.Bin));
            }
            if (disabledLegacy && Host.ServicePid() == 0) Try(() => { oldTask.Enabled = true; });
            if (oldMode >= 0 && Host.ServicePid() == 0 && Directory.Exists(Host.Bin))
                Try(() => { using (var service = new ServiceController(Host.Name)) service.Start(); });
            throw;
        }
        finally { if (Directory.Exists(stage)) Try(() => Directory.Delete(stage, true)); }
        if (movedOld && Directory.Exists(backup)) Try(() => Directory.Delete(backup, true));
    }

    private static dynamic FindLegacyTask(SecurityIdentifier owner)
    {
        var type = Type.GetTypeFromProgID("Schedule.Service", true);
        dynamic service = Activator.CreateInstance(type);
        service.Connect();
        dynamic root = service.GetFolder(@"\");
        try { return root.GetTask("TaskRelay Executor Boot (" + owner.Value + ")"); }
        catch (System.Runtime.InteropServices.COMException error)
        {
            if ((uint)error.ErrorCode != 0x80070002) throw;
            return null;
        }
    }

    private static void Extract(string stage)
    {
        Directory.CreateDirectory(stage);
        var prefix = stage + Path.DirectorySeparatorChar;
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(Payload))
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Read))
        {
            foreach (var entry in archive.Entries)
            {
                var target = Path.GetFullPath(Path.Combine(stage, entry.FullName));
                if (!target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new IOException("SERVICE_PAYLOAD_PATH_INVALID");
                if (entry.Name.Length == 0) Directory.CreateDirectory(target);
                else
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (var source = entry.Open())
                    using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                        source.CopyTo(output);
                }
            }
        }
    }

    private static void Try(Action action) { try { action(); } catch { } }
}
