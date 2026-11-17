# 管理员为已配对的本机 Windows 账户登记开机任务。任务以该账户的普通权限执行。
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Enable', 'Remove')]
    [string]$Action,
    [Parameter(Mandatory)]
    [string]$Account
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '请以管理员身份打开 Windows PowerShell。'
}

$user = Get-LocalUser -Name $Account
$sid = $user.SID.Value
$taskName = "TaskRelay Executor Boot ($sid)"
$userName = "$env:COMPUTERNAME\$($user.Name)"
if ($Action -eq 'Remove') {
    $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\'
    if ($task.State -eq 'Running') {
        throw '请先在该账户的 TaskRelay 托盘中退出执行器，再删除开机任务。'
    }
    if ($PSCmdlet.ShouldProcess($taskName, '删除 TaskRelay 开机任务')) {
        Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false
    }
    return
}

$profile = (Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid").ProfileImagePath
$profile = [Environment]::ExpandEnvironmentVariables($profile)
$install = Join-Path $profile 'AppData\Local\TaskRelay'
$journal = Join-Path $profile 'AppData\Roaming\TaskRelay\taskrelay-v4.sqlite'
if (-not (Test-Path -LiteralPath (Join-Path $install 'Update.exe') -PathType Leaf) -or
    -not (Test-Path -LiteralPath $journal -PathType Leaf)) {
    throw '请先在指定账户中安装 TaskRelay，并完成设备配对。'
}
$task = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($task.State -eq 'Running') {
    throw '请先在该账户的 TaskRelay 托盘中退出执行器，再更新开机任务。'
}
if (-not $PSCmdlet.ShouldProcess($taskName, '登记 TaskRelay 开机任务')) { return }

# Squirrel 的 --processStartAndWait 等待调用者退出，不等待已启动的程序。
# 由计划任务保留监督进程，跟踪真正的执行器退出码；已准备好更新时重选 Squirrel 版本。
$launcher = @'
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'TaskRelay'
do {
    $versions = Get-Content -LiteralPath (Join-Path $root 'packages\RELEASES') | ForEach-Object {
        if ($_ -match '^[a-fA-F0-9]{40}\s+TaskRelay-(\d+\.\d+\.\d+)-full\.nupkg\s+\d+\s*$') {
            [version]$Matches[1]
        }
    }
    $latest = $versions | Sort-Object -Descending | Select-Object -First 1
    if ($null -eq $latest -or $latest -lt [version]'0.26.9') { exit 2 }
    $exe = Join-Path $root ('app-' + $latest + '\TaskRelay.exe')
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { exit 3 }
    $start = [Diagnostics.ProcessStartInfo]::new($exe, '--taskrelay-background')
    $start.WorkingDirectory = Split-Path -Parent $exe
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($start)
    try { $process.WaitForExit(); $code = $process.ExitCode }
    finally { $process.Dispose() }
    if ($code -eq 75) { Start-Sleep -Seconds 2 }
} while ($code -eq 75)
exit $code
'@

# 使用固定的 UTF-16 命令传给 Windows PowerShell，不拼接账户、路径或密码。
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launcher))
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskAction = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -NonInteractive -EncodedCommand $encoded"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 5 -RestartInterval ([TimeSpan]::FromMinutes(1)) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$password = Read-Host "输入 $userName 的 Windows 密码" -AsSecureString
try {
    # 密码仅作为 Task Scheduler API 的参数传入，不写入脚本、进程命令行或 TaskRelay 数据。
    $credential = [Net.NetworkCredential]::new('', $password)
    Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $taskAction -Trigger $trigger -Settings $settings `
        -User $userName -Password $credential.Password -RunLevel Limited -Force | Out-Null
} finally {
    $password.Dispose()
}
Write-Output "已登记 $taskName，下次开机启动。"
