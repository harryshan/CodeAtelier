# Windows Sandbox Repair 的离线 PowerShell 夹具，由 windows-sandbox-repair.test.ts 调用。
# 1. 从安装器 AST 加载真实函数与 Mode 分流，不执行安装器的机器路径初始化。
# 2. 用内存账户、临时 state 和受控系统操作替身覆盖成功、身份拒绝及阶段故障。
# 3. 输出账户身份、持久状态及操作顺序；绝不调用真实账户、ACL、WFP 或 Supervisor。
param([string]$Installer, [string]$Directory, [string]$Scenario)

$ErrorActionPreference = 'Stop'
$Tokens = $null
$ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count -gt 0) {
    throw 'Invalid installer syntax'
}
foreach ($Function in $Ast.FindAll({ param($Node)
    $Node -is [System.Management.Automation.Language.FunctionDefinitionAst]
}, $false)) {
    . ([scriptblock]::Create($Function.Extent.Text))
}
$Dispatch = $Ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.SwitchStatementAst] }

$Mode = 'Repair'
$AccountName = 'CodeAtelierSandbox'
$AccountDescription = 'CodeAtelier dedicated sandbox runtime account'
$OriginalSid = 'S-1-5-21-1-2-3-1061'
$script:Account = [pscustomobject]@{
    SID = [pscustomobject]@{ Value = $OriginalSid }
    Description = $AccountDescription
}
$script:Operations = [Collections.Generic.List[string]]::new()
$DataRoot = $Directory
$InstalledBinaryRoot = Join-Path $Directory 'bin'
$InstalledRuntimeRoot = Join-Path $Directory 'runtime'
$StatePath = Join-Path $Directory 'installation.state'
$RelayPortV4 = 42871
$RelayPortV6 = 42872
$RelayPortV4ExplicitlySet = $false
$RelayPortV6ExplicitlySet = $false
$Supervisor = Join-Path $InstalledBinaryRoot 'supervisor.exe'
$NetworkManager = Join-Path $InstalledBinaryRoot 'network.exe'
$RuntimeNode = Join-Path $InstalledRuntimeRoot 'node.exe'
$RuntimeEntry = Join-Path $InstalledRuntimeRoot 'entry.mjs'
$RuntimeWorker = Join-Path $InstalledRuntimeRoot 'worker.mjs'
$RuntimeSubagentWorker = Join-Path $InstalledRuntimeRoot 'subagent.mjs'
$BuildNetworkManager = Join-Path $Directory 'source-network.exe'
$BuildSupervisor = Join-Path $Directory 'source-supervisor.exe'
$BuildRuntimeEntry = Join-Path $Directory 'source-entry.mjs'
$BuildRuntimeWorker = Join-Path $Directory 'source-worker.mjs'
$BuildRuntimeSubagentWorker = Join-Path $Directory 'source-subagent.mjs'
$Digest = 'a' * 64

$InitialState = [ordered]@{
    version = '5'
    accountName = $AccountName
    accountSid = $OriginalSid
    installedBySid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    protectedPassword = 'fixture-protected-password'
    generationId = 'previous-generation'
    relayPortV4 = '43971'
    relayPortV6 = '43972'
}
switch ($Scenario) {
    'missing-account' { $script:Account = $null }
    'sid-mismatch' { $script:Account.SID.Value = 'S-1-5-21-1-2-3-1062' }
    'name-mismatch' { $InitialState.accountName = 'UnrelatedAccount' }
    'description-mismatch' { $script:Account.Description = 'Unrelated account' }
    'installer-mismatch' { $InitialState.installedBySid = 'S-1-5-21-1-2-3-9999' }
    'missing-credential' { $InitialState.protectedPassword = '' }
    'invalid-port' { $InitialState.relayPortV4 = '65536' }
    'explicit-ports' {
        $RelayPortV4ExplicitlySet = $true
        $RelayPortV6ExplicitlySet = $true
        $RelayPortV4 = 44071
        $RelayPortV6 = 44072
    }
    'legacy' {
        $InitialState.version = '1'
        $InitialState.Remove('relayPortV4')
        $InitialState.Remove('relayPortV6')
    }
}
$InitialState.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" } | Set-Content -LiteralPath $StatePath
$OriginalState = Get-Content -LiteralPath $StatePath -Raw
if ($Scenario -eq 'missing-state') {
    Remove-Item -LiteralPath $StatePath
}
if ($Scenario -in @('fresh-install', 'fresh-copy-failure')) {
    $Mode = 'Install'
    $script:Account = $null
    Remove-Item -LiteralPath $StatePath
}
foreach ($Source in @($BuildNetworkManager, $BuildSupervisor)) {
    Set-Content -LiteralPath $Source -Value 'fixture'
}

# 替换所有机器副作用边界。意外进入卸载仍只修改夹具内存，让回归能够报告 SID 丢失。
function Assert-Administrator {}

function Get-LocalUser {
    param($Name, $ErrorAction)

    return $script:Account
}

function New-LocalUser {
    param($Name, $Password, [switch]$AccountNeverExpires, [switch]$PasswordNeverExpires, [switch]$UserMayNotChangePassword, $Description)

    $script:Operations.Add('create-account')
    $script:Account = [pscustomobject]@{
        SID = [pscustomobject]@{ Value = 'S-1-5-21-1-2-3-9999' }
        Description = $Description
    }
    return $script:Account
}

function Remove-Installation {
    $script:Operations.Add('remove-installation')
    $script:Account = $null
    if (Test-Path -LiteralPath $StatePath) {
        Remove-Item -LiteralPath $StatePath
    }
}

function Add-LocalGroupMember { param($SID, $Member, $ErrorAction) }

function Set-WelcomeAccountHidden {}

function Set-StateDirectoryAcl { param($Path, $SandboxAccountSid) }

function Set-BinaryDirectoryAcl { param($Path, $SandboxAccountSid) }

function Resolve-RuntimeNode { return 'fixture-node.exe' }

function Read-RuntimeBuildManifest {
    if ($Scenario -eq 'manifest-failure') {
        throw 'manifest-failure'
    }
    return @{
        entry = @{ sha256 = $Digest }
        worker = @{ sha256 = $Digest }
        subagentWorker = @{ sha256 = $Digest }
    }
}

function New-RandomPassword { return 'fixture-password' }

function Protect-Password {
    param($Password)

    return 'new-protected-password'
}

function Get-LowerSha256 {
    param($Path)

    return $Digest
}

function Copy-Item {
    param($LiteralPath, $Destination)

    $script:Operations.Add('copy')
    if ($Scenario -in @('copy-failure', 'fresh-copy-failure')) {
        throw $Scenario
    }
}

function Invoke-Supervisor {
    param($Arguments)

    $script:Operations.Add($Arguments[0])
    if ($Scenario -eq 'terminate-failure' -and $Arguments[0] -eq '--terminate-account-processes') {
        throw 'terminate-failure'
    }
    if ($Scenario -eq 'revoke-failure' -and $Arguments[0] -eq '--revoke-journal') {
        throw 'revoke-failure'
    }
}

function Invoke-NetworkManager {
    param($Arguments)

    $script:Operations.Add($Arguments[0])
    if ($Scenario -eq 'network-failure') {
        throw 'network-failure'
    }
}

function Test-Installation {
    $script:Operations.Add('verify')
    if ($Scenario -in @('verify-failure', 'retry')) {
        throw 'verify-failure'
    }
}

function Write-Host { param($Object) }

function Write-Warning { param($Message) }

$Failure = $null
try {
    . ([scriptblock]::Create($Dispatch.Extent.Text))
}
catch {
    $Failure = $_.Exception.Message
}
$FirstFailure = $Failure
if ($Scenario -eq 'retry') {
    $Scenario = 'success'
    $Failure = $null
    try {
        . ([scriptblock]::Create($Dispatch.Extent.Text))
    }
    catch {
        $Failure = $_.Exception.Message
    }
}
$FinalState = $null
$StateUnchanged = $false
if (Test-Path -LiteralPath $StatePath) {
    $FinalState = Read-InstallationState
    $StateUnchanged = (Get-Content -LiteralPath $StatePath -Raw) -eq $OriginalState
}
@{
    error = $Failure
    firstError = $FirstFailure
    sid = $script:Account.SID.Value
    state = $FinalState
    stateUnchanged = $StateUnchanged
    operations = @($script:Operations.ToArray())
} | ConvertTo-Json -Depth 5 -Compress
