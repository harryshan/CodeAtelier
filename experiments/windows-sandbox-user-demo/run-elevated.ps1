# 本脚本是专用账户探针的最小 UAC 包装器，供非提升开发 shell 发起真实管理员验证。
# 它只接受 .local/windows-sandbox-user-demo 下的报告路径，调用同目录 run-demo.ps1 的 run 模式，
# 将不含账户密码的控制台证据写入报告，并以 0/1 返回整体结果。账户和 ACL 的创建、验证与清理由
# run-demo.ps1 负责；本包装器不扩大目标路径、不保留凭据，也不用于产品安装或运行时。

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ReportPath
)

$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$reportRoot = Join-Path $repositoryRoot ".local\windows-sandbox-user-demo"
$normalizedReportPath = [IO.Path]::GetFullPath($ReportPath)
$normalizedReportRoot = [IO.Path]::GetFullPath($reportRoot).TrimEnd('\') + '\'
if (-not $normalizedReportPath.StartsWith($normalizedReportRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝向验证根之外写报告：$normalizedReportPath"
}

New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
$lines = [Collections.Generic.List[string]]::new()

try {
    & (Join-Path $PSScriptRoot "run-demo.ps1") -Mode run *>&1 |
        ForEach-Object {
            $line = $_.ToString()
            $lines.Add($line)
            Write-Host $line
        }
    $lines | Set-Content -LiteralPath $normalizedReportPath -Encoding utf8NoBOM
    exit 0
}
catch {
    $lines.Add($_.ToString())
    $lines | Set-Content -LiteralPath $normalizedReportPath -Encoding utf8NoBOM
    Write-Error $_
    exit 1
}
