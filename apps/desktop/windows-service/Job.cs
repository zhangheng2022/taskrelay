// 服务停止或崩溃时，由 Windows 回收服务拥有的进程树。
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

internal sealed class Job : IDisposable
{
    [StructLayout(LayoutKind.Sequential)]
    struct Limits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int index, ref Limits value, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    private IntPtr handle;

    internal Job()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        var limits = new Limits { Flags = 0x2000 };
        if (handle == IntPtr.Zero || !SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf(typeof(Limits))))
        {
            Dispose();
            throw new InvalidOperationException("SERVICE_JOB_FAILED");
        }
    }

    internal void Add(Process process)
    {
        if (!AssignProcessToJobObject(handle, process.Handle)) throw new InvalidOperationException("SERVICE_JOB_ASSIGN_FAILED");
    }

    public void Dispose()
    {
        if (handle == IntPtr.Zero) return;
        CloseHandle(handle);
        handle = IntPtr.Zero;
    }
}
