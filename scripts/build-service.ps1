# 使用 Windows 随附的 .NET Framework 编译 SCM 宿主和签名安装程序，无需用户安装运行时。
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
$native = Join-Path $root 'apps/desktop/windows-service'
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$packed = Join-Path $root 'apps/desktop/out/TaskRelay-win32-x64'
$make = Join-Path $root 'apps/desktop/out/make/squirrel.windows/x64'
$build = Join-Path $root 'out/service-build'
$hostExe = Join-Path $packed 'TaskRelay.Service.exe'
$setup = Join-Path $make 'TaskRelay.Service.Setup.exe'
$payload = Join-Path $build ('payload-' + [Guid]::NewGuid().ToString('N') + '.zip')
$null = New-Item -ItemType Directory -Path $build -Force
$sources = @(Get-ChildItem -LiteralPath $native -File -Filter '*.cs' | Select-Object -ExpandProperty FullName)
$references = @('/r:System.ServiceProcess.dll','/r:System.IO.Compression.dll','/r:Microsoft.CSharp.dll')
& $csc /nologo /optimize+ /platform:x64 /main:Host "/out:$hostExe" @references @sources
if ($LASTEXITCODE -ne 0) { throw 'SERVICE_HOST_BUILD_FAILED' }
try {
    & pwsh -NoProfile -File "$PSScriptRoot/windows-signature.ps1" -Action Sign -File $hostExe
    if ($LASTEXITCODE -ne 0) { throw 'SERVICE_HOST_SIGNING_FAILED' }
    [IO.Compression.ZipFile]::CreateFromDirectory($packed, $payload, [IO.Compression.CompressionLevel]::Fastest, $false)
    $manifest = Join-Path $native 'setup.manifest'
    & $csc /nologo /optimize+ /platform:x64 /main:Setup /target:winexe "/win32manifest:$manifest" "/out:$setup" "/resource:$payload,TaskRelay.Payload" @references @sources
    if ($LASTEXITCODE -ne 0) { throw 'SERVICE_SETUP_BUILD_FAILED' }
    & pwsh -NoProfile -File "$PSScriptRoot/windows-signature.ps1" -Action Sign -File $setup
    if ($LASTEXITCODE -ne 0) { throw 'SERVICE_SETUP_SIGNING_FAILED' }
} finally {
    if (Test-Path -LiteralPath $payload) { Remove-Item -LiteralPath $payload }
}
