// 只修改固定的 TaskRelay 服务及其原启动任务。被提升的进程从不加载用户目录中的代码。
using System;
using System.Diagnostics;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using TimeoutException = System.TimeoutException;

internal static class InstallOperations
{
    internal static void RequireAdmin()
    {
        if (!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
            throw new InvalidOperationException("ADMIN_REQUIRED");
    }

    internal static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    internal static void Win(string exe, string arguments)
    {
        var system = Environment.GetFolderPath(Environment.SpecialFolder.System);
        using (var child = Process.Start(new ProcessStartInfo(Path.Combine(system, exe), arguments)
        {
            WorkingDirectory = system, UseShellExecute = false, CreateNoWindow = true
        }))
        {
            if (!child.WaitForExit(30000)) { child.Kill(); throw new TimeoutException("SERVICE_SETUP_TIMEOUT"); }
            if (child.ExitCode != 0) throw new InvalidOperationException("SERVICE_SETUP_COMMAND_FAILED");
        }
    }

    internal static void SetStartup(bool enabled)
    {
        RequireAdmin();
        if (Host.StartType() < 0) throw new InvalidOperationException("SERVICE_NOT_INSTALLED");
        Win("sc.exe", "config " + Host.Name + (enabled ? " start= delayed-auto" : " start= demand"));
    }

    internal static void WaitStopped()
    {
        using (var service = new ServiceController(Host.Name))
        {
            // The application drains work before installing. An installer never force-stops a live owner.
            if (service.Status != ServiceControllerStatus.Stopped)
                throw new InvalidOperationException("SERVICE_IS_RUNNING");
        }
    }

    internal static DirectorySecurity PrivateAcl(SecurityIdentifier service)
    {
        var security = new DirectorySecurity();
        security.SetOwner(Host.AdministratorSid);
        security.SetAccessRuleProtection(true, false);
        foreach (var sid in new[] { Host.AdministratorSid, Host.SystemSid, service })
            if (sid != null)
                security.AddAccessRule(new FileSystemAccessRule(sid,
                    sid.Equals(service) ? FileSystemRights.Modify : FileSystemRights.FullControl,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                    PropagationFlags.None, AccessControlType.Allow));
        return security;
    }

    internal static void CheckPrivateDirectory(string directory, SecurityIdentifier service)
    {
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("SERVICE_PATH_REPARSE_POINT");
        var access = Directory.GetAccessControl(directory);
        var owner = access.GetOwner(typeof(SecurityIdentifier));
        if (!Host.AdministratorSid.Equals(owner) && !Host.SystemSid.Equals(owner))
            throw new IOException("SERVICE_PATH_OWNER_INVALID");
        foreach (FileSystemAccessRule rule in access.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            if (rule.AccessControlType == AccessControlType.Allow &&
                !Host.AdministratorSid.Equals(rule.IdentityReference) &&
                !Host.SystemSid.Equals(rule.IdentityReference) &&
                !object.Equals(service, rule.IdentityReference))
                throw new IOException("SERVICE_PATH_ACL_INVALID");
    }
}
