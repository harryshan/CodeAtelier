<#
.SYNOPSIS
Recovers only known CodeAtelier Windows Sandbox persistent objects after a failed install or uninstall.

.DESCRIPTION
The script is an emergency wrapper around install.ps1 Uninstall. It requires
elevation, uses the recorded account SID before deleting an account, removes
only the fixed CodeAtelier WFP provider/sublayer, and confines recursive state
directory removal to ProgramData\CodeAtelier. Repeated execution is safe.

Use this script if the normal installer reports an incomplete rollback. It does
not alter unrelated firewall policy, local accounts, workspaces, Git state, or
host network configuration.
#>

[CmdletBinding()]
param(
    [string]$AccountName = "CodeAtelierSandbox",
    [string]$DataRoot = (Join-Path $env:ProgramData "CodeAtelier\Sandbox")
)

$ErrorActionPreference = "Stop"
$Installer = Join-Path $PSScriptRoot "install.ps1"

& $Installer -Mode Uninstall -AccountName $AccountName -DataRoot $DataRoot
if ($LASTEXITCODE -ne 0) {
    throw "Sandbox 恢复脚本失败，退出码 $LASTEXITCODE。"
}

Write-Host "SANDBOX_RECOVERY PASS"

