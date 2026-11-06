# Windows 交付脚本与工作流使用同一固定版本分析器；任何启用规则命中都阻止发布。
$ErrorActionPreference = 'Stop'
$analyzerVersion = '1.25.0'
if (-not (Get-Module -ListAvailable PSScriptAnalyzer | Where-Object Version -EQ $analyzerVersion)) {
    Install-Module PSScriptAnalyzer -RequiredVersion $analyzerVersion -Scope CurrentUser -Repository PSGallery -Force
}
Import-Module PSScriptAnalyzer -RequiredVersion $analyzerVersion
$scriptPaths = git ls-files --cached --others --exclude-standard -- '*.ps1' '*.psm1'
if ($LASTEXITCODE -ne 0) { throw '无法读取 PowerShell 文件清单' }
$findings = @($scriptPaths | ForEach-Object {
    Invoke-ScriptAnalyzer -Path $_ -Settings './scripts/PSScriptAnalyzerSettings.psd1'
})
if ($findings.Count -gt 0) {
    $findings | Format-Table -AutoSize
    throw 'POWERSHELL_ANALYSIS_FAILED'
}
Write-Output 'PowerShell 规则检查通过'
