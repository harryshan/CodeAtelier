<#
.SYNOPSIS
Installs, verifies, repairs, or uninstalls the CodeAtelier Windows Sandbox account and WFP fence.

.DESCRIPTION
This is the only elevated product entrypoint for persistent Sandbox machine
state. It creates one fixed low-privilege local account, protects its random
password with CurrentUser DPAPI, installs deny-logon rights and the account-SID
WFP fence, copies the native binaries plus a fixed Node 24 or 26/Agent Runtime bundle
into protected ProgramData directories, and writes a versioned state file with
a restrictive ACL and hashes for every executable Runtime artifact.

Install rolls back a newly created account on failure. Repair keeps the existing
account SID and DPAPI credential, drains processes/grants before replacing files,
and retains state on failure for a later retry; it is not an atomic rollback of
all installed artifacts. Verify is read only. Uninstall removes only the fixed
WFP provider/sublayer, the account whose SID matches recorded state, the welcome-screen registry value, and the state
directory. No operation scans or deletes unrelated users, filters, or folders.

1. Source and v4 manifest helpers validate entry/compaction/subagent files, hashes and the Node 24 baseline; v5 installed state no longer includes a read Worker.
2. Resolve-RuntimeNode resolves version-manager shims to process.execPath before copying; Assert-RuntimeNodeVersion accepts Node 24/26 for source and installed verification.
3. Read-RepairState validates recorded account/installer identity and relay settings before any repair writes.
4. Install-Sandbox shares artifact installation between fresh Install and in-place Repair; only fresh Install creates an account or rolls it back.
5. The Mode switch dispatches maintenance; explicit Uninstall/recover remain destructive account removal operations.
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
    [string]$DataRoot = (Join-Path $env:ProgramData "CodeAtelier\Sandbox"),
    [string]$RuntimeNodePath = $env:CODEATELIER_SANDBOX_RUNTIME_NODE
)

$ErrorActionPreference = "Stop"
$RelayPortV4ExplicitlySet = $PSBoundParameters.ContainsKey("RelayPortV4")
$RelayPortV6ExplicitlySet = $PSBoundParameters.ContainsKey("RelayPortV6")
$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$BuildNetworkManager = Join-Path $RepositoryRoot "dist\native\windows-x64\codeatelier-sandbox-network.exe"
$BuildSupervisor = Join-Path $RepositoryRoot "dist\native\windows-x64\codeatelier-sandbox-supervisor.exe"
$BuildRuntimeRoot = Join-Path $RepositoryRoot "dist\runtime\windows-x64"
$BuildRuntimeManifest = Join-Path $BuildRuntimeRoot "runtime.manifest.json"
$BuildRuntimeEntry = Join-Path $BuildRuntimeRoot "agent-runtime.mjs"
$BuildRuntimeWorker = Join-Path $BuildRuntimeRoot "compaction-worker.mjs"
$BuildRuntimeSubagentWorker = Join-Path $BuildRuntimeRoot "subagent-worker.mjs"
$InstalledBinaryRoot = Join-Path $DataRoot "bin"
$InstalledRuntimeRoot = Join-Path $DataRoot "runtime"
$NetworkManager = Join-Path $InstalledBinaryRoot "codeatelier-sandbox-network.exe"
$Supervisor = Join-Path $InstalledBinaryRoot "codeatelier-sandbox-supervisor.exe"
$RuntimeNode = Join-Path $InstalledRuntimeRoot "node.exe"
$RuntimeEntry = Join-Path $InstalledRuntimeRoot "agent-runtime.mjs"
$RuntimeWorker = Join-Path $InstalledRuntimeRoot "compaction-worker.mjs"
$RuntimeSubagentWorker = Join-Path $InstalledRuntimeRoot "subagent-worker.mjs"
$StatePath = Join-Path $DataRoot "installation.state"
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
    param(
        [string]$Path,
        [Security.Principal.SecurityIdentifier]$SandboxAccountSid
    )

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
    $SandboxTraverseRule = [Security.AccessControl.FileSystemAccessRule]::new(
        $SandboxAccountSid,
        [Security.AccessControl.FileSystemRights]::ReadAndExecute,
        [Security.AccessControl.InheritanceFlags]::None,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$Acl.AddAccessRule($SandboxTraverseRule)
    Set-Acl -LiteralPath $Path -AclObject $Acl
}

function Set-BinaryDirectoryAcl {
    param(
        [string]$Path,
        [Security.Principal.SecurityIdentifier]$SandboxAccountSid
    )

    Set-StateDirectoryAcl -Path $Path -SandboxAccountSid $SandboxAccountSid
    $Acl = Get-Acl -LiteralPath $Path
    $Rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $SandboxAccountSid,
        [Security.AccessControl.FileSystemRights]::ReadAndExecute,
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$Acl.AddAccessRule($Rule)
    Set-Acl -LiteralPath $Path -AclObject $Acl
}

function Get-LowerSha256 {
    param([Parameter(Mandatory)][string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-RegularSourceFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    $Item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $Item.PSIsContainer -and -not ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        return
    }
    throw "$Label 必须是非 reparse 的普通文件。"
}

function Assert-ExactPropertyNames {
    param(
        [Parameter(Mandatory)]$Object,
        [Parameter(Mandatory)][string[]]$Expected,
        [Parameter(Mandatory)][string]$Label
    )

    $ActualNames = @($Object.PSObject.Properties.Name | Sort-Object)
    $ExpectedNames = @($Expected | Sort-Object)
    if ($ActualNames.Count -ne $ExpectedNames.Count -or (Compare-Object $ActualNames $ExpectedNames)) {
        throw "$Label 字段无效。"
    }
}

function Read-RuntimeBuildManifest {
    if (-not (Test-Path -LiteralPath $BuildRuntimeManifest -PathType Leaf)) {
        throw "缺少 Agent Runtime bundle；请先运行 pnpm sandbox:runtime:build。"
    }

    try {
        $Manifest = Get-Content -LiteralPath $BuildRuntimeManifest -Raw | ConvertFrom-Json
    }
    catch {
        throw "Agent Runtime build manifest 不是合法 JSON。"
    }
    Assert-ExactPropertyNames -Object $Manifest -Expected @("version", "nodeMajor", "entry", "worker", "subagentWorker") -Label "Agent Runtime build manifest"
    Assert-ExactPropertyNames -Object $Manifest.entry -Expected @("file", "sha256") -Label "Agent Runtime entry manifest"
    Assert-ExactPropertyNames -Object $Manifest.worker -Expected @("file", "sha256") -Label "Agent Runtime worker manifest"
    Assert-ExactPropertyNames -Object $Manifest.subagentWorker -Expected @("file", "sha256") -Label "Agent Runtime subagent worker manifest"
    if (
        $Manifest.version -ne 4 -or
        $Manifest.nodeMajor -ne 24 -or
        $Manifest.entry.file -ne "agent-runtime.mjs" -or
        $Manifest.worker.file -ne "compaction-worker.mjs" -or
        $Manifest.subagentWorker.file -ne "subagent-worker.mjs" -or
        $Manifest.entry.sha256 -notmatch '^[a-f0-9]{64}$' -or
        $Manifest.worker.sha256 -notmatch '^[a-f0-9]{64}$' -or
        $Manifest.subagentWorker.sha256 -notmatch '^[a-f0-9]{64}$' -or
        -not (Test-Path -LiteralPath $BuildRuntimeEntry -PathType Leaf) -or
        -not (Test-Path -LiteralPath $BuildRuntimeWorker -PathType Leaf) -or
        -not (Test-Path -LiteralPath $BuildRuntimeSubagentWorker -PathType Leaf) -or
        (Get-LowerSha256 -Path $BuildRuntimeEntry) -ne $Manifest.entry.sha256 -or
        (Get-LowerSha256 -Path $BuildRuntimeWorker) -ne $Manifest.worker.sha256 -or
        (Get-LowerSha256 -Path $BuildRuntimeSubagentWorker) -ne $Manifest.subagentWorker.sha256
    ) {
        throw "Agent Runtime bundle 与 build manifest 不匹配。"
    }
    Assert-RegularSourceFile -Path $BuildRuntimeEntry -Label "Agent Runtime entry"
    Assert-RegularSourceFile -Path $BuildRuntimeWorker -Label "Agent Runtime worker"
    Assert-RegularSourceFile -Path $BuildRuntimeSubagentWorker -Label "Agent Runtime subagent worker"

    return $Manifest
}

function Assert-RuntimeNodeVersion {
    param([string]$Version, [int]$ExitCode)

    if ($ExitCode -ne 0 -or $Version -notmatch '^v(24|26)\.\d+\.\d+$') {
        throw "Agent Runtime 必须使用固定的 Node.js 24 或 26 executable。"
    }
}

function Resolve-RuntimeNode {
    $Candidate = $RuntimeNodePath
    if (-not $Candidate) {
        $Command = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
        $Candidate = $Command.Source
    }
    $Resolved = (Resolve-Path -LiteralPath $Candidate -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $Resolved -PathType Leaf)) {
        throw "Agent Runtime Node executable 不存在。"
    }
    Assert-RegularSourceFile -Path $Resolved -Label "Agent Runtime Node executable"

    $Version = & $Resolved --version
    Assert-RuntimeNodeVersion -Version $Version -ExitCode $LASTEXITCODE

    # PATH may contain an nvm shim which only works with the host user's profile.
    # Copy the actual interpreter, then require it to identify itself directly.
    $Executable = & $Resolved -p 'process.execPath'
    if ($LASTEXITCODE -ne 0 -or $Executable -isnot [string] -or
        -not [IO.Path]::IsPathRooted($Executable) -or
        [IO.Path]::GetFullPath($Executable) -ine $Executable -or
        [IO.Path]::GetExtension($Executable) -ine '.exe') {
        throw "Agent Runtime Node executable 无法解析为独立 Node.js 24 或 26。"
    }
    $Executable = (Resolve-Path -LiteralPath $Executable -ErrorAction Stop).Path
    Assert-RegularSourceFile -Path $Executable -Label "Agent Runtime Node executable"
    $Version = & $Executable --version
    Assert-RuntimeNodeVersion -Version $Version -ExitCode $LASTEXITCODE
    $Self = & $Executable -p 'process.execPath'
    if ($LASTEXITCODE -ne 0 -or $Self -isnot [string] -or
        -not [string]::Equals($Self, $Executable, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Agent Runtime Node executable 必须直接运行 Node.js 24 或 26。"
    }

    return $Executable
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
    param([switch]$RequireCurrent)

    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
        throw "Sandbox installation state 不存在。"
    }
    $Values = @{}
    foreach ($Line in Get-Content -LiteralPath $StatePath) {
        $Separator = $Line.IndexOf('=')
        if ($Separator -lt 1) {
            throw "Sandbox installation state 包含非法行。"
        }
        $Key = $Line.Substring(0, $Separator)
        if ($Values.ContainsKey($Key)) {
            throw "Sandbox installation state 包含重复字段。"
        }
        $Values[$Key] = $Line.Substring($Separator + 1)
    }
    $State = [pscustomobject]$Values
    if ($State.version -notin @("1", "2", "3", "4", "5") -or -not $State.accountSid -or -not $State.accountName) {
        throw "Sandbox installation state 版本或字段无效。"
    }
    if (
        $RequireCurrent -and
        ($State.version -ne "5" -or
            $State.runtimeNodeSha256 -notmatch '^[a-f0-9]{64}$' -or
            $State.runtimeEntrySha256 -notmatch '^[a-f0-9]{64}$' -or
            $State.runtimeWorkerSha256 -notmatch '^[a-f0-9]{64}$' -or
            $State.runtimeSubagentWorkerSha256 -notmatch '^[a-f0-9]{64}$')
    ) {
        throw "Sandbox installation state 缺少当前 Agent Runtime 摘要；请运行 Repair。"
    }
    return $State
}

function Invoke-NetworkManager {
    param([string[]]$Arguments)

    if (-not (Test-Path -LiteralPath $NetworkManager -PathType Leaf) -or -not (Test-Path -LiteralPath $Supervisor -PathType Leaf)) {
        throw "受保护安装目录缺少原生 WFP manager 或 supervisor。"
    }
    & $NetworkManager @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "原生 WFP manager 失败，退出码 $LASTEXITCODE。"
    }
}

function Invoke-Supervisor {
    param([string[]]$Arguments)

    if (-not (Test-Path -LiteralPath $Supervisor -PathType Leaf)) {
        throw "缺少原生 Sandbox supervisor；不能安全清理 ACL journal。"
    }
    & $Supervisor @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "原生 Sandbox supervisor 失败，退出码 $LASTEXITCODE。"
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
    $State = Read-InstallationState -RequireCurrent
    $Account = Get-LocalUser -Name $State.accountName -ErrorAction Stop
    if ($Account.SID.Value -ne $State.accountSid -or $Account.Description -ne $AccountDescription) {
        throw "专用账户身份与 installation state 不匹配。"
    }
    foreach ($Artifact in @(
        @{ Path = $Supervisor; StateKey = "supervisorSha256" },
        @{ Path = $NetworkManager; StateKey = "networkSha256" },
        @{ Path = $RuntimeNode; StateKey = "runtimeNodeSha256" },
        @{ Path = $RuntimeEntry; StateKey = "runtimeEntrySha256" },
        @{ Path = $RuntimeWorker; StateKey = "runtimeWorkerSha256" },
        @{ Path = $RuntimeSubagentWorker; StateKey = "runtimeSubagentWorkerSha256" }
    )) {
        $ExpectedHash = $State.PSObject.Properties[$Artifact.StateKey].Value
        if (
            $ExpectedHash -notmatch '^[a-f0-9]{64}$' -or
            -not (Test-Path -LiteralPath $Artifact.Path -PathType Leaf) -or
            (Get-LowerSha256 -Path $Artifact.Path) -ne $ExpectedHash
        ) {
            throw "受保护 Sandbox 二进制或 Agent Runtime 摘要不匹配。"
        }
    }
    $InstalledNodeVersion = & $RuntimeNode --version
    Assert-RuntimeNodeVersion -Version $InstalledNodeVersion -ExitCode $LASTEXITCODE
    Invoke-NetworkManager -Arguments @(
        "--wfp-persistent-verify",
        $State.accountName,
        $State.relayPortV4,
        $State.relayPortV6
    )
    Invoke-Supervisor -Arguments @("--self-check", $StatePath, $NetworkManager)
    Write-Host "SANDBOX_INSTALL_VERIFY PASS version=5"
}

function Remove-Installation {
    Assert-Administrator
    $State = $null
    if (Test-Path -LiteralPath $StatePath -PathType Leaf) {
        $State = Read-InstallationState
        Invoke-Supervisor -Arguments @("--terminate-account-processes", $StatePath, $NetworkManager)
        Invoke-Supervisor -Arguments @("--revoke-journal", $StatePath, $NetworkManager)
        Invoke-Supervisor -Arguments @("--remove-account-rights", $StatePath, $NetworkManager)
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

function Read-RepairState {
    param($Account)

    $State = Read-InstallationState
    if (
        $null -eq $Account -or
        $State.accountName -ne $AccountName -or
        $State.accountSid -ne $Account.SID.Value -or
        $Account.Description -ne $AccountDescription
    ) {
        throw "Repair 拒绝身份缺失或不匹配的账户；不会删除或重新创建账户。"
    }
    if (
        $State.installedBySid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
        -not $State.protectedPassword -or
        -not $State.generationId
    ) {
        throw "Repair 需要原安装用户、已保存的凭据和 generation；请保留 installation state 排查，不会自动重建账户。"
    }
    if ($State.version -ne "1") {
        foreach ($Port in @($State.relayPortV4, $State.relayPortV6)) {
            if ($Port -notmatch '^\d{4,5}$' -or [int]$Port -lt 1024 -or [int]$Port -gt 65535) {
                throw "Repair 拒绝无效的已安装 relay 端口。"
            }
        }
    }
    return $State
}

function Install-Sandbox {
    param([switch]$Repair)

    Assert-Administrator
    if ($AccountName -notmatch '^[A-Za-z0-9_.-]{1,64}$') {
        throw "Sandbox 账户名只允许 1～64 个 ASCII 字母、数字、点、下划线或连字符。"
    }
    if (-not (Test-Path -LiteralPath $BuildNetworkManager -PathType Leaf) -or -not (Test-Path -LiteralPath $BuildSupervisor -PathType Leaf)) {
        throw "缺少原生 WFP manager；请先运行 pnpm sandbox:native:build。"
    }
    $RuntimeBuild = Read-RuntimeBuildManifest
    $SourceRuntimeNode = Resolve-RuntimeNode

    $Existing = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
    if ($null -ne $Existing -and $Existing.Description -ne $AccountDescription) {
        throw "同名本地账户已存在且不属于 CodeAtelier，安装已安全停止。"
    }
    $PreviousState = $null
    if ($Repair) {
        $PreviousState = Read-RepairState -Account $Existing
        if ($PreviousState.version -ne "1") {
            if (-not $RelayPortV4ExplicitlySet) {
                $RelayPortV4 = [int]$PreviousState.relayPortV4
            }
            if (-not $RelayPortV6ExplicitlySet) {
                $RelayPortV6 = [int]$PreviousState.relayPortV6
            }
        }
    }
    elseif ($null -ne $Existing -or (Test-Path -LiteralPath $StatePath)) {
        throw "检测到已有或不完整安装；请先运行 Repair 或恢复脚本。"
    }

    $Password = $null
    $SecurePassword = $null
    $CreatedAccount = $false
    try {
        if ($Repair) {
            Write-Host "SANDBOX_REPAIR START account=preserved"
            # 旧 Supervisor 在清理前验证原安装用户、SID 和 DPAPI 凭据；失败不得覆盖 state 或遗留 journal。
            Invoke-Supervisor -Arguments @("--terminate-account-processes", $StatePath, $NetworkManager)
            Invoke-Supervisor -Arguments @("--revoke-journal", $StatePath, $NetworkManager)
            $Account = $Existing
            $ProtectedPassword = $PreviousState.protectedPassword
        }
        else {
            $Password = New-RandomPassword
            $SecurePassword = ConvertTo-SecureString $Password -AsPlainText -Force
            $Account = New-LocalUser -Name $AccountName -Password $SecurePassword -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -Description $AccountDescription
            $CreatedAccount = $true
            $ProtectedPassword = Protect-Password -Password $Password
        }
        Add-LocalGroupMember -SID "S-1-5-32-545" -Member $Account -ErrorAction SilentlyContinue
        Set-WelcomeAccountHidden

        New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
        Set-StateDirectoryAcl -Path $DataRoot -SandboxAccountSid $Account.SID
        foreach ($RuntimeDirectoryName in @("grants", "instances", "projections")) {
            $RuntimeDirectory = Join-Path $DataRoot $RuntimeDirectoryName
            New-Item -ItemType Directory -Force -Path $RuntimeDirectory | Out-Null
            Set-StateDirectoryAcl -Path $RuntimeDirectory -SandboxAccountSid $Account.SID
        }
        New-Item -ItemType Directory -Force -Path $InstalledBinaryRoot | Out-Null
        Set-BinaryDirectoryAcl -Path $InstalledBinaryRoot -SandboxAccountSid $Account.SID
        New-Item -ItemType Directory -Force -Path $InstalledRuntimeRoot | Out-Null
        Set-BinaryDirectoryAcl -Path $InstalledRuntimeRoot -SandboxAccountSid $Account.SID
        Copy-Item -LiteralPath $BuildNetworkManager -Destination $NetworkManager
        Copy-Item -LiteralPath $BuildSupervisor -Destination $Supervisor
        Copy-Item -LiteralPath $SourceRuntimeNode -Destination $RuntimeNode
        Copy-Item -LiteralPath $BuildRuntimeEntry -Destination $RuntimeEntry
        Copy-Item -LiteralPath $BuildRuntimeWorker -Destination $RuntimeWorker
        Copy-Item -LiteralPath $BuildRuntimeSubagentWorker -Destination $RuntimeSubagentWorker
        if (
            (Get-LowerSha256 -Path $RuntimeEntry) -ne $RuntimeBuild.entry.sha256 -or
            (Get-LowerSha256 -Path $RuntimeWorker) -ne $RuntimeBuild.worker.sha256 -or
            (Get-LowerSha256 -Path $RuntimeSubagentWorker) -ne $RuntimeBuild.subagentWorker.sha256
        ) {
            throw "安装后的 Agent Runtime bundle 与已验证 build manifest 不匹配。"
        }
        $State = [ordered]@{
            version = "5"
            accountName = $AccountName
            accountSid = $Account.SID.Value
            generationId = [guid]::NewGuid().ToString("D")
            relayPortV4 = [string]$RelayPortV4
            relayPortV6 = [string]$RelayPortV6
            protectedPassword = $ProtectedPassword
            installedBySid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            installedAt = [DateTimeOffset]::UtcNow.ToString("O")
            supervisorSha256 = Get-LowerSha256 -Path $Supervisor
            networkSha256 = Get-LowerSha256 -Path $NetworkManager
            runtimeNodeSha256 = Get-LowerSha256 -Path $RuntimeNode
            runtimeEntrySha256 = Get-LowerSha256 -Path $RuntimeEntry
            runtimeWorkerSha256 = Get-LowerSha256 -Path $RuntimeWorker
            runtimeSubagentWorkerSha256 = Get-LowerSha256 -Path $RuntimeSubagentWorker
        }
        $TemporaryState = "$StatePath.tmp"
        $State.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" } | Set-Content -LiteralPath $TemporaryState -Encoding utf8NoBOM
        Move-Item -LiteralPath $TemporaryState -Destination $StatePath -Force

        Invoke-NetworkManager -Arguments @("--wfp-persistent-remove")
        Invoke-NetworkManager -Arguments @("--wfp-persistent-install", $AccountName, [string]$RelayPortV4, [string]$RelayPortV6)
        Invoke-Supervisor -Arguments @("--install-account-rights", $StatePath, $NetworkManager)
        Test-Installation
        if ($Repair) {
            Write-Host "SANDBOX_REPAIR PASS version=5 account=preserved"
        }
        else {
            Write-Host "SANDBOX_INSTALL PASS version=5"
        }
    }
    catch {
        if ($Repair) {
            # 不能借失败清理删除旧账户，否则工作区 owner/ACE 又会指向失效 SID。
            Write-Warning "SANDBOX_REPAIR FAILED：已保留账户和 installation state；安装文件可能部分更新，请修正原因后重试 Repair 并运行 Verify。"
        }
        elseif ($CreatedAccount) {
            try {
                Remove-Installation
            }
            catch {
                Write-Warning "自动回滚未能证明完整：$($_.Exception.Message)"
            }
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
    "Repair" { Install-Sandbox -Repair }
    "Verify" { Test-Installation }
    "Uninstall" { Remove-Installation }
}
