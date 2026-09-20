<#
.SYNOPSIS
Installs, verifies, repairs, or uninstalls the CodeAtelier Windows Sandbox account and WFP fence.

.DESCRIPTION
This is the only elevated product entrypoint for persistent Sandbox machine
state. It creates one fixed low-privilege local account, protects its random
password with CurrentUser DPAPI, installs the account-SID WFP fence through the
fixed native manager, and writes a versioned state file with a restrictive ACL.

Install/Repair are transactional at the script level: a failure invokes the
same narrow recovery routine and reports any residual objects. Verify is read
only. Uninstall removes only the fixed WFP provider/sublayer, the account whose
SID matches recorded state, the welcome-screen registry value, and the state
directory. No operation scans or deletes unrelated users, filters, or folders.
#>

[CmdletBinding()]
param(
    [ValidateSet("Install", "Repair", "Verify", "Uninstall")]
    [string]$Mode = "Install",
    [string]$AccountName = "CodeAtelierSandbox",
    [ValidateRange(1024, 65535)]
    [int]$RelayPortV4 = 42871,
    [ValidateRange(1024, 65535)]
    [int]$RelayPortV6 = 42872,
    [string]$DataRoot = (Join-Path $env:ProgramData "CodeAtelier\Sandbox")
)

$ErrorActionPreference = "Stop"
$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$NetworkManager = Join-Path $RepositoryRoot "dist\native\windows-x64\codeatelier-sandbox-network.exe"
$StatePath = Join-Path $DataRoot "installation.json"
$AccountDescription = "CodeAtelier dedicated sandbox runtime account"
$WelcomeRegistry = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList"
$DpapiEntropy = [Text.Encoding]::UTF8.GetBytes("CodeAtelier.WindowsSandbox.Secret.v1")

function Assert-Administrator {
    $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
    if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Windows Sandbox 安装、修复和卸载必须在提升的 PowerShell 中运行。"
    }
}

function Assert-ContainedPath {
    param([string]$Path, [string]$Root)

    $ResolvedPath = [IO.Path]::GetFullPath($Path)
    $ResolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (-not $ResolvedPath.StartsWith($ResolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝操作产品 Sandbox 状态根之外的路径。"
    }
}

function Set-StateDirectoryAcl {
    param([string]$Path)

    $Acl = [Security.AccessControl.DirectorySecurity]::new()
    $Acl.SetAccessRuleProtection($true, $false)
    $Inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $Rights = [Security.AccessControl.FileSystemRights]::FullControl
    foreach ($Identity in @(
        [Security.Principal.WindowsIdentity]::GetCurrent().User,
        [Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
        [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
    )) {
        $Rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $Identity,
            $Rights,
            $Inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$Acl.AddAccessRule($Rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $Acl
}

function New-RandomPassword {
    $Random = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
    return "Ca1!$Random"
}

function Protect-Password {
    param([string]$Password)

    $PlainBytes = [Text.Encoding]::Unicode.GetBytes($Password)
    try {
        $Protected = [Security.Cryptography.ProtectedData]::Protect(
            $PlainBytes,
            $DpapiEntropy,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        return [Convert]::ToBase64String($Protected)
    }
    finally {
        [Array]::Clear($PlainBytes, 0, $PlainBytes.Length)
    }
}

function Read-InstallationState {
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
        throw "Sandbox installation state 不存在。"
    }
    $State = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    if ($State.version -ne 1 -or -not $State.accountSid -or -not $State.accountName) {
        throw "Sandbox installation state 版本或字段无效。"
    }
    return $State
}

function Invoke-NetworkManager {
    param([string[]]$Arguments)

    if (-not (Test-Path -LiteralPath $NetworkManager -PathType Leaf)) {
        throw "缺少原生 WFP manager；请先运行 pnpm sandbox:native:build。"
    }
    & $NetworkManager @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "原生 WFP manager 失败，退出码 $LASTEXITCODE。"
    }
}

function Set-WelcomeAccountHidden {
    New-Item -Path $WelcomeRegistry -Force | Out-Null
    New-ItemProperty -Path $WelcomeRegistry -Name $AccountName -PropertyType DWord -Value 0 -Force | Out-Null
}

function Remove-WelcomeAccountValue {
    if (Test-Path -LiteralPath $WelcomeRegistry) {
        Remove-ItemProperty -Path $WelcomeRegistry -Name $AccountName -ErrorAction SilentlyContinue
    }
}

function Test-Installation {
    $State = Read-InstallationState
    $Account = Get-LocalUser -Name $State.accountName -ErrorAction Stop
    if ($Account.SID.Value -ne $State.accountSid -or $Account.Description -ne $AccountDescription) {
        throw "专用账户身份与 installation state 不匹配。"
    }
    Invoke-NetworkManager -Arguments @("--wfp-persistent-verify")
    Write-Host "SANDBOX_INSTALL_VERIFY PASS version=1"
}

function Remove-Installation {
    Assert-Administrator
    $State = $null
    if (Test-Path -LiteralPath $StatePath -PathType Leaf) {
        $State = Read-InstallationState
    }

    if (Test-Path -LiteralPath $NetworkManager -PathType Leaf) {
        Invoke-NetworkManager -Arguments @("--wfp-persistent-remove")
    }
    Remove-WelcomeAccountValue

    if ($null -ne $State) {
        $Account = Get-LocalUser -Name $State.accountName -ErrorAction SilentlyContinue
        if ($null -ne $Account) {
            if ($Account.SID.Value -ne $State.accountSid -or $Account.Description -ne $AccountDescription) {
                throw "拒绝删除与 installation state 不匹配的本地账户。"
            }
            Remove-LocalUser -Name $State.accountName
        }
    }
    else {
        $Account = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
        if ($null -ne $Account) {
            if ($Account.Description -ne $AccountDescription) {
                throw "拒绝删除没有 installation state 且描述不匹配的同名账户。"
            }
            Remove-LocalUser -Name $AccountName
        }
    }

    $ProgramDataRoot = Join-Path $env:ProgramData "CodeAtelier"
    Assert-ContainedPath -Path $DataRoot -Root $ProgramDataRoot
    if (Test-Path -LiteralPath $DataRoot) {
        Remove-Item -LiteralPath $DataRoot -Recurse -Force
    }
    Write-Host "SANDBOX_INSTALL_REMOVE PASS"
}

function Install-Sandbox {
    Assert-Administrator
    if (-not (Test-Path -LiteralPath $NetworkManager -PathType Leaf)) {
        throw "缺少原生 WFP manager；请先运行 pnpm sandbox:native:build。"
    }

    $Existing = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
    if ($null -ne $Existing -and $Existing.Description -ne $AccountDescription) {
        throw "同名本地账户已存在且不属于 CodeAtelier，安装已安全停止。"
    }
    if ($null -ne $Existing -or (Test-Path -LiteralPath $StatePath)) {
        throw "检测到已有或不完整安装；请先运行 Repair 或恢复脚本。"
    }

    $Password = New-RandomPassword
    $SecurePassword = ConvertTo-SecureString $Password -AsPlainText -Force
    try {
        $Account = New-LocalUser -Name $AccountName -Password $SecurePassword -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -Description $AccountDescription
        Add-LocalGroupMember -SID "S-1-5-32-545" -Member $Account -ErrorAction SilentlyContinue
        Set-WelcomeAccountHidden

        New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
        Set-StateDirectoryAcl -Path $DataRoot
        $State = [ordered]@{
            version = 1
            accountName = $AccountName
            accountSid = $Account.SID.Value
            generationId = [guid]::NewGuid().ToString("D")
            relayPortV4 = $RelayPortV4
            relayPortV6 = $RelayPortV6
            protectedPassword = Protect-Password -Password $Password
            installedBySid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            installedAt = [DateTimeOffset]::UtcNow.ToString("O")
        }
        $TemporaryState = "$StatePath.tmp"
        $State | ConvertTo-Json | Set-Content -LiteralPath $TemporaryState -Encoding UTF8
        Move-Item -LiteralPath $TemporaryState -Destination $StatePath -Force

        Invoke-NetworkManager -Arguments @("--wfp-persistent-remove")
        Invoke-NetworkManager -Arguments @("--wfp-persistent-install", $AccountName, [string]$RelayPortV4, [string]$RelayPortV6)
        Test-Installation
        Write-Host "SANDBOX_INSTALL PASS version=1"
    }
    catch {
        try {
            Remove-Installation
        }
        catch {
            Write-Warning "自动回滚未能证明完整：$($_.Exception.Message)"
        }
        throw
    }
    finally {
        $Password = $null
        $SecurePassword = $null
    }
}

switch ($Mode) {
    "Install" { Install-Sandbox }
    "Repair" {
        Remove-Installation
        Install-Sandbox
    }
    "Verify" { Test-Installation }
    "Uninstall" { Remove-Installation }
}
