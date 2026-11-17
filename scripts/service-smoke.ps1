# 在独立 GitHub Windows 作业验证真实 SCM、账户、Session 0 和桌面控制通道。
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'SERVICE_SMOKE_REQUIRES_GITHUB_HOSTED_RUNNER'
}
$name = 'TaskRelayExecutor'
$setup = (Resolve-Path 'apps/desktop/out/make/squirrel.windows/x64/TaskRelay.Service.Setup.exe').Path
$helper = Join-Path $env:ProgramFiles 'TaskRelayService/bin/TaskRelay.Service.exe'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if (Get-Service -Name $name -ErrorAction SilentlyContinue) { throw 'SERVICE_SMOKE_HOST_NOT_CLEAN' }
function Invoke-RelayCall([string]$Method, $InputValue) {
    $line = @{method = $Method; input = $InputValue} | ConvertTo-Json -Compress
    $value = $line | & $helper call
    if ($LASTEXITCODE -ne 0) { throw 'SERVICE_SMOKE_CALL_FAILED' }
    $reply = $value | ConvertFrom-Json
    if ($reply.ok -ne $true) { throw 'SERVICE_SMOKE_COMMAND_REJECTED' }
    return $reply.value
}
function Install-RelayCandidate {
    $log = Join-Path (Resolve-Path 'out') 'service-setup-error.log'
    $process = Start-Process -FilePath $setup -ArgumentList $sid -WindowStyle Hidden -RedirectStandardError $log -PassThru -Wait
    if ($process.ExitCode -ne 0) {
        Get-Content -LiteralPath $log
        throw "SERVICE_INSTALLER_FAILED:$($process.ExitCode)"
    }
}
try {
    Install-RelayCandidate
    $service = Get-CimInstance Win32_Service -Filter "Name='TaskRelayExecutor'"
    if ($service.StartName -ne 'NT SERVICE\TaskRelayExecutor' -or
        $service.State -ne 'Running' -or $service.StartMode -ne 'Auto') {
        throw 'SERVICE_SMOKE_INVALID_IDENTITY'
    }
    if ((Get-Process -Id $service.ProcessId).SessionId -ne 0) { throw 'SERVICE_SMOKE_SESSION_INVALID' }
    $first = Invoke-RelayCall 'status' $null
    if ($first.paired) { throw 'SERVICE_SMOKE_PAIRING_NOT_ISOLATED' }
    Invoke-RelayCall 'pause' $true
    if ((Invoke-RelayCall 'status' $null).paused -ne $true) { throw 'SERVICE_SMOKE_CONTROL_FAILED' }
    & $helper disable
    if ($LASTEXITCODE -ne 0 -or ((& $helper info) -ne 'manual online')) { throw 'SERVICE_SMOKE_DISABLE_FAILED' }
    Invoke-RelayCall 'quit' $null
    (Get-Service -Name $name).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(40))
    Install-RelayCandidate
    if ((Invoke-RelayCall 'status' $null).paused -ne $true -or ((& $helper info) -ne 'manual online')) {
        throw 'SERVICE_SMOKE_UPGRADE_LOST_STATE'
    }
    @{
        passed = $true
        version = $first.version
        session = 0
        account = $service.StartName
        setupSha256 = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
        hostSha256 = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
    } | ConvertTo-Json | Set-Content -LiteralPath 'out/service-smoke.json' -Encoding utf8
} finally {
    if (Get-Service -Name $name -ErrorAction SilentlyContinue) {
        $null = & sc.exe stop $name
        $null = & sc.exe delete $name
    }
}
