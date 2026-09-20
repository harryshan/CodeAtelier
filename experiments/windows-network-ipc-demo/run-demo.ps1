<#
.SYNOPSIS
Builds and runs the Windows network and Broker IPC feasibility probes.

.DESCRIPTION
The script locates MSVC, builds network_ipc_demo.cpp into the repository-local
ignored .local directory, then runs the named-pipe identity probe, the dynamic
WFP APP_ID probe, or the dedicated-user WFP fence probe. WFP modes need elevated
BFE policy access and use only loopback TCP listeners. Dynamic filters are removed
when the controller process exits. The dedicated-user mode creates and precisely
cleans up one random local account; its password stays in this PowerShell process.
#>

[CmdletBinding()]
param(
    [ValidateSet("all", "build", "ipc", "wfp", "wfp-user")]
    [string]$Mode = "all"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$buildRoot = Join-Path $repoRoot ".local\windows-network-ipc-demo"
$sourcePath = Join-Path $PSScriptRoot "network_ipc_demo.cpp"
$executablePath = Join-Path $buildRoot "network_ipc_demo.exe"

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "wfp-user 模式必须在提升的 PowerShell 中执行。"
    }
}

function Assert-PathContained {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$Root
    )

    $normalizedPath = [IO.Path]::GetFullPath($Path)
    $normalizedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (-not $normalizedPath.StartsWith($normalizedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝操作验证根之外的路径：$normalizedPath"
    }
}

function Add-AllowRule {
    param(
        [Parameter(Mandatory)]
        [Security.AccessControl.DirectorySecurity]$Acl,
        [Parameter(Mandatory)]
        [Security.Principal.IdentityReference]$Identity,
        [Parameter(Mandatory)]
        [Security.AccessControl.FileSystemRights]$Rights
    )

    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $Identity,
        $Rights,
        $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$Acl.AddAccessRule($rule)
}

function Set-UserFenceDirectoryAcl {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [Security.Principal.SecurityIdentifier]$SandboxSid
    )

    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    Add-AllowRule -Acl $acl -Identity ([Security.Principal.WindowsIdentity]::GetCurrent().User) -Rights FullControl
    Add-AllowRule -Acl $acl -Identity ([Security.Principal.SecurityIdentifier]::new("S-1-5-18")) -Rights FullControl
    Add-AllowRule -Acl $acl -Identity ([Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")) -Rights FullControl
    Add-AllowRule -Acl $acl -Identity $SandboxSid -Rights ReadAndExecute
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function New-ProbePassword {
    $random = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
    return "Aa1!$random"
}

function Start-ProbeProcess {
    param(
        [Parameter(Mandatory)]
        [string]$Executable,
        [Parameter(Mandatory)]
        [string[]]$Arguments,
        [Parameter(Mandatory)]
        [string]$WorkingDirectory,
        [string]$UserName,
        [Security.SecureString]$Password
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $Arguments) {
        [void]$startInfo.ArgumentList.Add($argument)
    }
    if ($UserName) {
        $startInfo.LoadUserProfile = $false
        $startInfo.Domain = "."
        $startInfo.UserName = $UserName
        $startInfo.Password = $Password.Copy()
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "无法启动网络探针进程。"
    }
    return [pscustomobject]@{
        Process = $process
        StandardOutputTask = $process.StandardOutput.ReadToEndAsync()
        StandardErrorTask = $process.StandardError.ReadToEndAsync()
    }
}

function Complete-ProbeProcess {
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$RunningProcess,
        [Parameter(Mandatory)]
        [int]$ExpectedExitCode,
        [int]$TimeoutMilliseconds = 10000
    )

    if (-not $RunningProcess.Process.WaitForExit($TimeoutMilliseconds)) {
        $RunningProcess.Process.Kill($true)
        throw "网络探针进程超时。"
    }
    $stdout = $RunningProcess.StandardOutputTask.GetAwaiter().GetResult()
    $stderr = $RunningProcess.StandardErrorTask.GetAwaiter().GetResult()
    if ($stdout) {
        Write-Host $stdout.TrimEnd()
    }
    if ($stderr) {
        Write-Warning $stderr.TrimEnd()
    }
    if ($RunningProcess.Process.ExitCode -ne $ExpectedExitCode) {
        throw "网络探针退出码为 $($RunningProcess.Process.ExitCode)，预期 $ExpectedExitCode。"
    }
    return $stdout
}

function Invoke-NetworkClientProbe {
    param(
        [Parameter(Mandatory)]
        [string]$Executable,
        [Parameter(Mandatory)]
        [ValidateSet("--network-client", "--network-client-v6")]
        [string]$ClientMode,
        [Parameter(Mandatory)]
        [int]$Port,
        [Parameter(Mandatory)]
        [string]$WorkingDirectory,
        [Parameter(Mandatory)]
        [int]$ExpectedExitCode,
        [string]$UserName,
        [Security.SecureString]$Password,
        [switch]$RestrictedTree
    )

    $clientArguments = if ($RestrictedTree) {
        @("--restricted-network-launch", $ClientMode, "$Port")
    }
    else {
        @($ClientMode, "$Port")
    }
    $client = Start-ProbeProcess `
        -Executable $Executable `
        -Arguments $clientArguments `
        -WorkingDirectory $WorkingDirectory `
        -UserName $UserName `
        -Password $Password
    try {
        [void](Complete-ProbeProcess -RunningProcess $client -ExpectedExitCode $ExpectedExitCode)
    }
    finally {
        $client.Process.Dispose()
    }
}

function Find-VsDevCmd {
    $installer = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
        throw "找不到 vswhere.exe；需要安装带 MSVC 的 Visual Studio Build Tools。"
    }

    $installation = & $installer -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $installation) {
        throw "找不到包含 MSVC x64 工具链的 Visual Studio 安装。"
    }
    return Join-Path $installation "Common7\Tools\VsDevCmd.bat"
}

function Build-Demo {
    New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
    $vsDevCmd = Find-VsDevCmd
    $compile = @(
        "call `"$vsDevCmd`" -no_logo -arch=x64 -host_arch=x64",
        "cl /nologo /std:c++20 /W4 /WX /EHsc /DUNICODE /D_UNICODE `"$sourcePath`" /Fo:`"$buildRoot\network_ipc_demo.obj`" /Fe:`"$executablePath`" /link Advapi32.lib Ole32.lib Fwpuclnt.lib Rpcrt4.lib Ws2_32.lib"
    ) -join " && "

    & $env:ComSpec /d /s /c $compile
    if ($LASTEXITCODE -ne 0) {
        throw "MSVC 编译失败，退出码 $LASTEXITCODE。"
    }
    Write-Host "BUILD PASS executable=$executablePath"
}

function Invoke-Probe {
    param(
        [Parameter(Mandatory)]
        [ValidateSet("ipc", "wfp")]
        [string]$Probe
    )

    if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
        throw "探针不存在，请先使用 -Mode build 或 -Mode all。"
    }
    & $executablePath "--$Probe"
    if ($LASTEXITCODE -ne 0) {
        throw "$Probe 探针失败或当前权限不支持，退出码 $LASTEXITCODE。"
    }
}

function Invoke-WfpUserProbe {
    Assert-Administrator
    if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
        throw "探针不存在，请先使用 -Mode build 或 -Mode all。"
    }

    New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
    $runRoot = Join-Path $buildRoot ("user-run-" + [guid]::NewGuid().ToString("N"))
    Assert-PathContained -Path $runRoot -Root $buildRoot
    $accountName = "CAWfp" + [guid]::NewGuid().ToString("N").Substring(0, 8)
    $plainPassword = New-ProbePassword
    $securePassword = ConvertTo-SecureString $plainPassword -AsPlainText -Force
    $accountCreated = $false
    $controller = $null
    $cleanupV4Listener = $null
    $cleanupV6Listener = $null

    try {
        $account = New-LocalUser `
            -Name $accountName `
            -Password $securePassword `
            -AccountNeverExpires `
            -PasswordNeverExpires `
            -UserMayNotChangePassword `
            -Description "Disposable CodeAtelier WFP user probe"
        $accountCreated = $true
        Add-LocalGroupMember -SID "S-1-5-32-545" -Member $account

        $sandboxSid = [Security.Principal.SecurityIdentifier]::new($account.SID.Value)
        $controlDirectory = Join-Path $runRoot "control"
        New-Item -ItemType Directory -Path $runRoot, $controlDirectory | Out-Null
        Copy-Item -LiteralPath $executablePath -Destination (Join-Path $runRoot "network-user-probe.exe")
        Set-UserFenceDirectoryAcl -Path $runRoot -SandboxSid $sandboxSid

        $probeExecutable = Join-Path $runRoot "network-user-probe.exe"
        $qualifiedAccountName = "$env:COMPUTERNAME\$accountName"
        $controller = Start-ProbeProcess `
            -Executable $probeExecutable `
            -Arguments @("--wfp-user-controller", $qualifiedAccountName, $controlDirectory) `
            -WorkingDirectory $runRoot

        $readyPath = Join-Path $controlDirectory "ports.ready"
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) {
            if ($controller.Process.HasExited) {
                [void](Complete-ProbeProcess -RunningProcess $controller -ExpectedExitCode 0)
                throw "WFP user controller 在发布端口前退出。"
            }
            if ([DateTime]::UtcNow -ge $deadline) {
                throw "等待 WFP user controller 发布端口超时。"
            }
            Start-Sleep -Milliseconds 100
        }

        $ports = @(Get-Content -LiteralPath $readyPath)
        if ($ports.Count -ne 4) {
            throw "WFP user controller 端口文件格式无效。"
        }
        $allowedV4Port = [int]$ports[0]
        $deniedV4Port = [int]$ports[1]
        $allowedV6Port = [int]$ports[2]
        $deniedV6Port = [int]$ports[3]

        Invoke-NetworkClientProbe -Executable $probeExecutable -ClientMode "--network-client" `
            -Port $deniedV4Port -WorkingDirectory $runRoot -ExpectedExitCode 0
        Invoke-NetworkClientProbe -Executable $probeExecutable -ClientMode "--network-client-v6" `
            -Port $deniedV6Port -WorkingDirectory $runRoot -ExpectedExitCode 0

        Invoke-NetworkClientProbe -Executable $probeExecutable -ClientMode "--network-client" `
            -Port $allowedV4Port -WorkingDirectory $runRoot -ExpectedExitCode 0 `
            -UserName $accountName -Password $securePassword
        Invoke-NetworkClientProbe -Executable $probeExecutable -ClientMode "--network-client-v6" `
            -Port $allowedV6Port -WorkingDirectory $runRoot -ExpectedExitCode 0 `
            -UserName $accountName -Password $securePassword
        Invoke-NetworkClientProbe -Executable $probeExecutable -ClientMode "--network-client" `
            -Port $deniedV4Port -WorkingDirectory $runRoot -ExpectedExitCode 20 `
            -UserName $accountName -Password $securePassword
        Invoke-NetworkClientProbe -Executable $probeExecutable -ClientMode "--network-client-v6" `
            -Port $deniedV6Port -WorkingDirectory $runRoot -ExpectedExitCode 20 `
            -UserName $accountName -Password $securePassword

        Invoke-NetworkClientProbe -Executable $probeExecutable -ClientMode "--network-client" `
            -Port $allowedV4Port -WorkingDirectory $runRoot -ExpectedExitCode 0 `
            -UserName $accountName -Password $securePassword -RestrictedTree
        Invoke-NetworkClientProbe -Executable $probeExecutable -ClientMode "--network-client-v6" `
            -Port $allowedV6Port -WorkingDirectory $runRoot -ExpectedExitCode 0 `
            -UserName $accountName -Password $securePassword -RestrictedTree
        Invoke-NetworkClientProbe -Executable $probeExecutable -ClientMode "--network-client" `
            -Port $deniedV4Port -WorkingDirectory $runRoot -ExpectedExitCode 20 `
            -UserName $accountName -Password $securePassword -RestrictedTree
        Invoke-NetworkClientProbe -Executable $probeExecutable -ClientMode "--network-client-v6" `
            -Port $deniedV6Port -WorkingDirectory $runRoot -ExpectedExitCode 20 `
            -UserName $accountName -Password $securePassword -RestrictedTree

        Set-Content -LiteralPath (Join-Path $controlDirectory "done.txt") -Value "done"
        [void](Complete-ProbeProcess -RunningProcess $controller -ExpectedExitCode 0)
        $controller.Process.Dispose()
        $controller = $null

        $cleanupV4Listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
        $cleanupV4Listener.Start()
        $cleanupV4Port = ([Net.IPEndPoint]$cleanupV4Listener.LocalEndpoint).Port

        $cleanupV6Listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::IPv6Loopback, 0)
        $cleanupV6Listener.Server.DualMode = $false
        $cleanupV6Listener.Start()
        $cleanupV6Port = ([Net.IPEndPoint]$cleanupV6Listener.LocalEndpoint).Port

        Invoke-NetworkClientProbe -Executable $probeExecutable -ClientMode "--network-client" `
            -Port $cleanupV4Port -WorkingDirectory $runRoot -ExpectedExitCode 0 `
            -UserName $accountName -Password $securePassword
        Invoke-NetworkClientProbe -Executable $probeExecutable -ClientMode "--network-client-v6" `
            -Port $cleanupV6Port -WorkingDirectory $runRoot -ExpectedExitCode 0 `
            -UserName $accountName -Password $securePassword

        $cleanupV4Listener.Stop()
        $cleanupV4Listener = $null
        $cleanupV6Listener.Stop()
        $cleanupV6Listener = $null

        Write-Host "WFP_USER_DEMO PASS accountSid=$($sandboxSid.Value) hostUnaffected=yes ipv4=yes ipv6=yes allowedLoopbackPort=yes otherLoopbackPortBlocked=yes restrictedDescendant=yes dynamicCleanupVerified=yes"
    }
    finally {
        $plainPassword = $null
        $securePassword = $null
        $cleanupFailures = [Collections.Generic.List[string]]::new()

        if ($null -ne $cleanupV4Listener) {
            $cleanupV4Listener.Stop()
        }
        if ($null -ne $cleanupV6Listener) {
            $cleanupV6Listener.Stop()
        }

        if ($null -ne $controller) {
            try {
                if (-not $controller.Process.HasExited) {
                    try {
                        Set-Content -LiteralPath (Join-Path $runRoot "control\done.txt") -Value "cleanup"
                    }
                    catch {
                        Write-Warning "无法写入 controller 清理标记，将直接终止：$($_.Exception.Message)"
                    }
                    if (-not $controller.Process.WaitForExit(3000)) {
                        $controller.Process.Kill($true)
                        $controller.Process.WaitForExit()
                    }
                }
                $controller.Process.Dispose()
            }
            catch {
                $cleanupFailures.Add("WFP controller 清理失败：$($_.Exception.Message)")
            }
        }

        try {
            Assert-PathContained -Path $runRoot -Root $buildRoot
            if (Test-Path -LiteralPath $runRoot) {
                Remove-Item -LiteralPath $runRoot -Recurse -Force
            }
        }
        catch {
            $cleanupFailures.Add("WFP 探针目录清理失败：$($_.Exception.Message)")
        }

        try {
            if ($accountCreated) {
                $existingAccount = Get-LocalUser -Name $accountName -ErrorAction SilentlyContinue
                if ($null -ne $existingAccount) {
                    Remove-LocalUser -Name $accountName
                }
            }
        }
        catch {
            $cleanupFailures.Add("WFP 临时账户清理失败：$($_.Exception.Message)")
        }

        if ($cleanupFailures.Count -gt 0) {
            throw ($cleanupFailures -join [Environment]::NewLine)
        }
    }
}

if ($Mode -in @("all", "build")) {
    Build-Demo
}
if ($Mode -in @("all", "ipc")) {
    Invoke-Probe -Probe ipc
}
if ($Mode -in @("all", "wfp")) {
    Invoke-Probe -Probe wfp
}
if ($Mode -eq "wfp-user") {
    Invoke-WfpUserProbe
}
