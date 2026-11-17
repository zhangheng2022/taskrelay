# Authenticode 生产适配：明确指定证书、SHA-256 和时间戳；检查结果不包含私钥或密码。
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Sign', 'Inspect', 'Report')][string]$Action,
    [string]$File,
    [string]$SigningDirectory = $env:TASKRELAY_SIGNING_DIRECTORY,
    [switch]$Installed,
    [string]$Output = 'out/signatures.json'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $SigningDirectory) { throw 'SIGNING_CERTIFICATE_REQUIRED' }
$certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new((Join-Path $SigningDirectory 'TaskRelay.cer'))
$info = Get-Content -LiteralPath (Join-Path $SigningDirectory 'certificate-info.json') -Raw | ConvertFrom-Json
$fingerprint = $certificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
if ($fingerprint -ne $info.sha256 -or $certificate.HasPrivateKey) { throw 'SIGNING_CERTIFICATE_MISMATCH' }
$signTool = Join-Path $repoRoot 'node_modules/@electron/windows-sign/vendor/signtool.exe'
if (-not (Test-Path -LiteralPath $signTool)) { throw 'SIGNTOOL_MISSING' }

function Get-SignatureEvidence([string]$Path, [string]$Role) {
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or -not $signature.TimeStamperCertificate) { throw "SIGNATURE_INVALID:$Role" }
    $signer = $signature.SignerCertificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
    if ($signer -ne $fingerprint) { throw "SIGNATURE_CERTIFICATE_MISMATCH:$Role" }
    # /tw 将缺失时间戳作为警告返回；非零退出一律失败，不依赖本地化输出。
    $null = & $signTool verify /pa /all /tw $Path 2>&1
    if ($LASTEXITCODE -ne 0) { throw "SIGNATURE_VERIFICATION_FAILED:$Role" }
    return [ordered]@{
        role = $Role; sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        certificateSha256 = $signer; status = 'Valid'; trusted = $true; timestamped = $true
        timestampCertificateSha256 = $signature.TimeStamperCertificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
    }
}

if ($Action -eq 'Sign') {
    if ($certificate.NotBefore -gt (Get-Date) -or $certificate.NotAfter -le (Get-Date)) { throw 'SIGNING_CERTIFICATE_EXPIRED' }
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $null = & $signTool sign /sha1 $certificate.Thumbprint /s My /fd SHA256 /tr 'http://timestamp.digicert.com' /td SHA256 /d TaskRelay $File 2>&1
        if ($LASTEXITCODE -eq 0) { break }
        if ($attempt -lt 3) { Start-Sleep -Seconds $attempt }
    }
    if ($LASTEXITCODE -ne 0) { throw 'SIGNING_OR_TIMESTAMP_FAILED' }
    # 本机打包不擅自安装根信任；最终 Report 在明确建立信任的验收机执行严格 /pa 验证。
    $signature = Get-AuthenticodeSignature -LiteralPath $File
    if (-not $signature.SignerCertificate -or -not $signature.TimeStamperCertificate -or $signature.Status -notin @('Valid', 'NotTrusted', 'UnknownError') -or $signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) { throw 'SIGNING_OR_TIMESTAMP_FAILED' }
    exit
}
if ($Action -eq 'Inspect') {
    Get-SignatureEvidence $File 'inspection' | ConvertTo-Json
    exit
}

$version = (Get-Content -LiteralPath (Join-Path $repoRoot 'apps/desktop/package.json') -Raw | ConvertFrom-Json).version
$makeDirectory = Join-Path $repoRoot 'apps/desktop/out/make/squirrel.windows/x64'
$packageFile = Join-Path $makeDirectory "TaskRelay-$version-full.nupkg"
$setupFile = Join-Path $makeDirectory 'TaskRelay Setup.exe'
$appFile = Join-Path $repoRoot 'apps/desktop/out/TaskRelay-win32-x64/TaskRelay.exe'
$evidence = @(Get-SignatureEvidence $setupFile 'setup'; Get-SignatureEvidence $appFile 'packaged-app')
# 只提取待验签入口，路径来自固定白名单，不解压任意归档路径。
$archive = [IO.Compression.ZipFile]::OpenRead($packageFile)
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ('taskrelay-signature-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $temporaryDirectory
try {
    foreach ($entryName in @('TaskRelay.exe', 'TaskRelay_ExecutionStub.exe', 'squirrel.exe')) {
        $entries = @($archive.Entries | Where-Object { $_.FullName -eq "lib/net45/$entryName" })
        if ($entries.Count -ne 1) { throw "SIGNATURE_PACKAGE_ENTRY_MISSING:$entryName" }
        $target = Join-Path $temporaryDirectory $entryName
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $target)
        $role = switch ($entryName) { 'TaskRelay.exe' { 'package-app' }; 'TaskRelay_ExecutionStub.exe' { 'package-stub' }; 'squirrel.exe' { 'package-updater' } }
        $evidence += Get-SignatureEvidence $target $role
    }
} finally {
    $archive.Dispose()
    foreach ($entryName in @('TaskRelay.exe', 'TaskRelay_ExecutionStub.exe', 'squirrel.exe')) {
        $target = Join-Path $temporaryDirectory $entryName
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target }
    }
    [IO.Directory]::Delete($temporaryDirectory)
}
if ($Installed) {
    $installedReport = Get-Content -LiteralPath (Join-Path $repoRoot 'out/installed-smoke.json') -Raw | ConvertFrom-Json
    $installRoot = Split-Path (Split-Path $installedReport.executablePath)
    $evidence += Get-SignatureEvidence $installedReport.executablePath 'installed-app'
    $evidence += Get-SignatureEvidence (Join-Path $installRoot 'Update.exe') 'installed-updater'
    $evidence += Get-SignatureEvidence (Join-Path $installRoot 'TaskRelay.exe') 'installed-stub'
}
$report = [ordered]@{
    schema = 1; type = 'self-signed'; testOnly = $info.testOnly; certificateSha256 = $fingerprint
    subject = $certificate.Subject; notBefore = $certificate.NotBefore.ToUniversalTime().ToString('o'); notAfter = $certificate.NotAfter.ToUniversalTime().ToString('o')
    version = $version; checkedAt = [DateTime]::UtcNow.ToString('o'); files = $evidence
    packageSha256 = (Get-FileHash -LiteralPath $packageFile -Algorithm SHA256).Hash.ToLowerInvariant()
}
$null = New-Item -ItemType Directory -Path (Split-Path ([IO.Path]::GetFullPath($Output))) -Force
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Output -Encoding utf8
Write-Output "签名验证完成：$($evidence.Count) 个入口"
