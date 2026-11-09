# 签名证书生命周期：私密备份只写指定目录；构建仅临时导入用户证书库，记录所有权后清理。
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Create', 'Prepare', 'Seal', 'Cleanup', 'Trust', 'Check', 'Untrust')][string]$Action,
    [string]$PrivateRoot = 'C:\Users\96227\OneDrive\TaskRelay\signing',
    [string]$PfxDirectory,
    [string]$StateDirectory,
    [string]$PublicDirectory = (Join-Path $PSScriptRoot '../resources/signing'),
    [switch]$TestCertificate,
    [switch]$TrustBuildMachine,
    [switch]$Rotate
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-CertificateFingerprint($Certificate) {
    return $Certificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
}
function Get-PublicCertificate {
    $cert = [Security.Cryptography.X509Certificates.X509Certificate2]::new((Join-Path $PublicDirectory 'TaskRelay.cer'))
    $info = Get-Content -LiteralPath (Join-Path $PublicDirectory 'certificate-info.json') -Raw | ConvertFrom-Json
    if ((Get-CertificateFingerprint $cert) -ne $info.sha256 -or $cert.HasPrivateKey) { throw 'SIGNING_PUBLIC_CERTIFICATE_MISMATCH' }
    return $cert
}

if ($Action -eq 'Create') {
    if (Test-Path -LiteralPath $PrivateRoot) {
        if (-not $Rotate -and @(Get-ChildItem -LiteralPath $PrivateRoot -Force).Count -gt 0) { throw 'SIGNING_BACKUP_ALREADY_EXISTS' }
    }
    $created = $null
    $secure = $null
    try {
        $created = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=TaskRelay' -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(3) -CertStoreLocation 'Cert:\CurrentUser\My'
        $fingerprint = Get-CertificateFingerprint $created
        $destination = Join-Path $PrivateRoot $fingerprint
        $null = New-Item -ItemType Directory -Path $destination
        # 随机密码不通过参数、控制台或日志传递；只在用户指定的私密备份中保留。
        $random = [byte[]]::new(48)
        [Security.Cryptography.RandomNumberGenerator]::Fill($random)
        $secret = [Convert]::ToBase64String($random)
        $secure = [Security.SecureString]::new()
        foreach ($character in $secret.ToCharArray()) { $secure.AppendChar($character) }
        $null = Export-PfxCertificate -Cert $created -FilePath (Join-Path $destination 'TaskRelay.pfx') -Password $secure -CryptoAlgorithmOption AES256_SHA256
        $null = Export-Certificate -Cert $created -FilePath (Join-Path $destination 'TaskRelay.cer')
        [IO.File]::WriteAllText((Join-Path $destination 'pfx-password.txt'), $secret)
        $info = [ordered]@{
            schema = 1; type = 'self-signed'; subject = $created.Subject; sha256 = $fingerprint
            thumbprint = $created.Thumbprint; notBefore = $created.NotBefore.ToUniversalTime().ToString('o')
            notAfter = $created.NotAfter.ToUniversalTime().ToString('o'); purpose = 'code-signing'
            testOnly = [bool]$TestCertificate
        }
        $info | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination 'certificate-info.json') -Encoding utf8
        Write-Output "已创建签名备份：$destination"
    } finally {
        if ($created) { Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($created.Thumbprint)" -DeleteKey }
        if ($secure) { $secure.Dispose() }
        $secret = $null
    }
    exit
}

if ($Action -in @('Trust', 'Check', 'Untrust')) {
    $certificate = Get-PublicCertificate
    foreach ($store in @('Root', 'TrustedPublisher')) {
        $target = "Cert:\LocalMachine\$store\$($certificate.Thumbprint)"
        if ($Action -eq 'Trust' -and -not (Test-Path -LiteralPath $target)) {
            $null = Import-Certificate -FilePath (Join-Path $PublicDirectory 'TaskRelay.cer') -CertStoreLocation "Cert:\LocalMachine\$store"
        }
        if (Test-Path -LiteralPath $target) {
            if ((Get-CertificateFingerprint (Get-Item -LiteralPath $target)) -ne (Get-CertificateFingerprint $certificate)) { throw 'SIGNING_STORE_CERTIFICATE_MISMATCH' }
            if ($Action -eq 'Untrust') { Remove-Item -LiteralPath $target }
        } elseif ($Action -eq 'Check') { throw "SIGNING_TRUST_MISSING:$store" }
    }
    Write-Output "证书信任操作完成：$Action"
    exit
}

if (-not $StateDirectory) {
    if (-not $env:RUNNER_TEMP) { throw 'SIGNING_STATE_DIRECTORY_REQUIRED' }
    $StateDirectory = Join-Path $env:RUNNER_TEMP 'taskrelay-signing'
}
$StateDirectory = [IO.Path]::GetFullPath($StateDirectory)
$statePath = Join-Path $StateDirectory 'state.json'
if ($Action -in @('Seal', 'Cleanup')) {
    if (Test-Path -LiteralPath $statePath) {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ($state.thumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw 'SIGNING_STATE_INVALID' }
        foreach ($store in $state.ownedStores) {
            if ($store -notin @('CurrentUser\My', 'LocalMachine\Root', 'LocalMachine\TrustedPublisher')) { throw 'SIGNING_STATE_INVALID' }
            if ($Action -eq 'Seal' -and $store -ne 'CurrentUser\My') { continue }
            $target = "Cert:\$store\$($state.thumbprint)"
            if (Test-Path -LiteralPath $target) {
                if ($store -eq 'CurrentUser\My') { Remove-Item -LiteralPath $target -DeleteKey }
                else { Remove-Item -LiteralPath $target }
            }
        }
    }
    if ($Action -eq 'Seal') { exit }
    # 只删除本脚本创建的固定文件；不递归删除传入目录或私密备份。
    foreach ($name in @('state.json', 'TaskRelay.pfx', 'TaskRelay.cer', 'certificate-info.json')) {
        $target = Join-Path $StateDirectory $name
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target }
    }
    if ((Test-Path -LiteralPath $StateDirectory) -and @(Get-ChildItem -LiteralPath $StateDirectory -Force).Count -eq 0) { [IO.Directory]::Delete($StateDirectory) }
    exit
}

if (Test-Path -LiteralPath $StateDirectory) { throw 'SIGNING_STATE_ALREADY_EXISTS' }
if ($TrustBuildMachine -and ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted')) { throw 'SIGNING_TRUST_REQUIRES_HOSTED_RUNNER' }
$null = New-Item -ItemType Directory -Path $StateDirectory
$secure = [Security.SecureString]::new()
$created = $null
try {
    if ($TestCertificate) {
        if ($env:TASKRELAY_RELEASE_SIGNING -eq 'true') { throw 'SIGNING_TEST_CERTIFICATE_FORBIDDEN' }
        $created = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=TaskRelay CI Test' -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddDays(2) -CertStoreLocation 'Cert:\CurrentUser\My'
        $owned = @('CurrentUser\My')
        if ($TrustBuildMachine) { $owned += @('LocalMachine\Root', 'LocalMachine\TrustedPublisher') }
        $info = @{ schema = 1; type = 'self-signed'; sha256 = (Get-CertificateFingerprint $created); thumbprint = $created.Thumbprint; subject = $created.Subject; notBefore = $created.NotBefore.ToUniversalTime().ToString('o'); notAfter = $created.NotAfter.ToUniversalTime().ToString('o'); testOnly = $true }
        @{ thumbprint = $created.Thumbprint; ownedStores = $owned } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
        $null = Export-Certificate -Cert $created -FilePath (Join-Path $StateDirectory 'TaskRelay.cer')
    } else {
        $public = Get-PublicCertificate
        $info = Get-Content -LiteralPath (Join-Path $PublicDirectory 'certificate-info.json') -Raw | ConvertFrom-Json
        if ($info.testOnly) { throw 'SIGNING_TEST_CERTIFICATE_FORBIDDEN' }
        $pfxFile = Join-Path $StateDirectory 'TaskRelay.pfx'
        if ($PfxDirectory) {
            Copy-Item -LiteralPath (Join-Path $PfxDirectory 'TaskRelay.pfx') -Destination $pfxFile
            $secret = [IO.File]::ReadAllText((Join-Path $PfxDirectory 'pfx-password.txt'))
        } else {
            if (-not $env:TASKRELAY_SIGNING_PFX_BASE64 -or -not $env:TASKRELAY_SIGNING_PASSWORD) { throw 'SIGNING_SECRET_MISSING' }
            [IO.File]::WriteAllBytes($pfxFile, [Convert]::FromBase64String($env:TASKRELAY_SIGNING_PFX_BASE64))
            $secret = $env:TASKRELAY_SIGNING_PASSWORD
        }
        foreach ($character in $secret.ToCharArray()) { $secure.AppendChar($character) }
        $collection = Get-PfxData -FilePath $pfxFile -Password $secure
        if ($collection.EndEntityCertificates.Count -ne 1 -or (Get-CertificateFingerprint $collection.EndEntityCertificates[0]) -ne $info.sha256) { throw 'SIGNING_PFX_CERTIFICATE_MISMATCH' }
        $owned = @()
        $stores = @('CurrentUser\My')
        if ($TrustBuildMachine) { $stores += @('LocalMachine\Root', 'LocalMachine\TrustedPublisher') }
        foreach ($store in $stores) {
            if (Test-Path -LiteralPath "Cert:\$store\$($public.Thumbprint)") {
                if ($store -eq 'CurrentUser\My') { throw 'SIGNING_PRIVATE_KEY_ALREADY_PRESENT' }
            } else { $owned += $store }
        }
        @{ thumbprint = $public.Thumbprint; ownedStores = $owned } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
        $created = Import-PfxCertificate -FilePath $pfxFile -Password $secure -CertStoreLocation 'Cert:\CurrentUser\My'
        Copy-Item -LiteralPath (Join-Path $PublicDirectory 'TaskRelay.cer') -Destination (Join-Path $StateDirectory 'TaskRelay.cer')
    }
    if ($created.NotBefore -gt (Get-Date) -or $created.NotAfter -le (Get-Date) -or -not $created.HasPrivateKey -or @($created.EnhancedKeyUsageList.ObjectId) -notcontains '1.3.6.1.5.5.7.3.3') { throw 'SIGNING_CERTIFICATE_INVALID' }
    if ($created.NotAfter -lt (Get-Date).AddDays(90)) { Write-Warning '签名证书将在 90 天内到期，请先分发新公开证书再轮换。' }
    foreach ($store in @('LocalMachine\Root', 'LocalMachine\TrustedPublisher')) {
        if ($owned -contains $store) { $null = Import-Certificate -FilePath (Join-Path $StateDirectory 'TaskRelay.cer') -CertStoreLocation "Cert:\$store" }
    }
    $info | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $StateDirectory 'certificate-info.json') -Encoding utf8
    if ($env:GITHUB_ENV) {
        "TASKRELAY_SIGNING_DIRECTORY=$StateDirectory" | Add-Content -LiteralPath $env:GITHUB_ENV
    }
    Write-Output "签名证书已准备：$($info.sha256)"
} catch {
    $failureLine = $_.InvocationInfo.ScriptLineNumber
    $failureType = $_.Exception.GetType().Name
    if ($created -and (Test-Path -LiteralPath "Cert:\CurrentUser\My\$($created.Thumbprint)")) {
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($created.Thumbprint)" -DeleteKey
    }
    & $PSCommandPath -Action Cleanup -StateDirectory $StateDirectory
    # 不转发可能包含密钥输入的底层错误正文。
    throw "SIGNING_PREPARATION_FAILED:line=${failureLine}:$failureType"
} finally {
    $secure.Dispose()
    $secret = $null
    $temporaryPfx = Join-Path $StateDirectory 'TaskRelay.pfx'
    if (Test-Path -LiteralPath $temporaryPfx) { Remove-Item -LiteralPath $temporaryPfx }
}
