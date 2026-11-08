# 仅在 GitHub 托管 Windows 验收机安装候选，从系统入口启动，再核验实际进程与 ASAR。
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'INSTALL_SMOKE_REQUIRES_GITHUB_HOSTED_RUNNER'
}
$workspacePath = (Resolve-Path '.').Path
$version = (Get-Content -LiteralPath 'apps/desktop/package.json' -Raw | ConvertFrom-Json).version
$setupPath = Join-Path $workspacePath 'apps/desktop/out/make/squirrel.windows/x64/TaskRelay Setup.exe'
$installRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'TaskRelay'))
$installedExe = Join-Path $installRoot "app-$version/TaskRelay.exe"
# 父进程退出会连带结束子进程；枚举后 PID 已消失属于收尾完成，仍存活时的停止错误继续阻止验收。
function Stop-InstalledTaskRelay {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param()
    if (-not $PSCmdlet.ShouldProcess($installedExe, '停止候选安装进程')) { return }
    Get-CimInstance Win32_Process -Filter "Name='TaskRelay.exe'" | Where-Object ExecutablePath -EQ $installedExe | ForEach-Object {
        $candidateId = $_.ProcessId
        try { Stop-Process -Id $candidateId -Force -ErrorAction Stop }
        catch {
            if (Get-Process -Id $candidateId -ErrorAction SilentlyContinue) { throw }
        }
    }
    $stopDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while (Get-CimInstance Win32_Process -Filter "Name='TaskRelay.exe'" | Where-Object ExecutablePath -EQ $installedExe) {
        if ([DateTime]::UtcNow -ge $stopDeadline) { throw 'INSTALLED_PROCESSES_STILL_RUNNING' }
        Start-Sleep -Milliseconds 100
    }
}
$builtAsar = Join-Path $workspacePath 'apps/desktop/out/TaskRelay-win32-x64/resources/app.asar'
$setup = Start-Process -FilePath $setupPath -ArgumentList '--silent' -PassThru -Wait -WindowStyle Hidden
if ($setup.ExitCode -ne 0) { throw 'INSTALLER_FAILED' }
if (-not (Test-Path -LiteralPath $installedExe)) { throw 'INSTALLED_EXECUTABLE_MISSING' }
$shortcutRoots = @((Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs'), [Environment]::GetFolderPath('Desktop'))
$links = @($shortcutRoots | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*TaskRelay*.lnk' -Recurse -File })
$shortcutShell = New-Object -ComObject WScript.Shell
$entry = $links | Where-Object {
    $target = [IO.Path]::GetFullPath($shortcutShell.CreateShortcut($_.FullName).TargetPath)
    $target.StartsWith($installRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
} | Select-Object -First 1
if (-not $entry) { throw 'SYSTEM_SHORTCUT_MISSING' }
# 全新 Runner 尚未配对；仅关闭本次安装路径的进程，确保下一次由系统入口创建。
Stop-InstalledTaskRelay
Start-Process -FilePath $entry.FullName -WindowStyle Hidden
$deadline = [DateTime]::UtcNow.AddSeconds(45)
$launched = $null
while ([DateTime]::UtcNow -lt $deadline) {
    $launched = Get-CimInstance Win32_Process -Filter "Name='TaskRelay.exe'" | Where-Object {
        $_.ExecutablePath -eq $installedExe -and $_.CommandLine -notmatch '--type='
    } | Select-Object -First 1
    if ($launched) { break }
    Start-Sleep -Milliseconds 500
}
if (-not $launched) { throw 'SYSTEM_ENTRY_DID_NOT_START_INSTALLED_APP' }
$installedAsar = Join-Path (Split-Path $installedExe) 'resources/app.asar'
$installedHash = (Get-FileHash -LiteralPath $installedAsar -Algorithm SHA256).Hash.ToLowerInvariant()
if ($installedHash -ne (Get-FileHash -LiteralPath $builtAsar -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'INSTALLED_ASAR_MISMATCH' }
$entryEvidence = @{
    version = $version; shortcut = $entry.FullName; executablePath = $launched.ExecutablePath
    processId = $launched.ProcessId; installedAsarPath = $installedAsar; asarSha256 = $installedHash
    checkedAt = [DateTime]::UtcNow.ToString('o'); runner = $env:RUNNER_ENVIRONMENT
}
Stop-InstalledTaskRelay
& node scripts/smoke.mjs $installedExe 'out/installed-smoke.json'
if ($LASTEXITCODE -ne 0) { throw 'INSTALLED_SMOKE_FAILED' }
$entryEvidence | ConvertTo-Json | Set-Content -LiteralPath 'out/system-entry.json' -Encoding utf8
Write-Output "已验证 Windows 系统入口及安装版本 $version"
