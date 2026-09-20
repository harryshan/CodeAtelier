# 本脚本验证 CodeAtelier 单一专用 Windows Sandbox 账户的最小文件边界，不接入产品运行时。
# 执行顺序：build 复用 restricted-token 原生探针；run 检查管理员上下文，创建随机临时本地账户；
# 为两个临时工作区安装共享账户写权限、不同 execution SID 和 root capability SID；以同一账户启动
# 两个并发 execution instance；bootstrap 从创建时为 process/thread/Job 安装 account+execution 私有 DACL，
# 再创建 WRITE_RESTRICTED token 和 Job。两个 Runtime 通过根内文件屏障保持同时存活，互相尝试危险的
# OpenProcess/OpenThread/OpenJobObject，再验证跨根读取、各自根写入和跨根写拒绝；finally 终止仍存活的
# 探针并只删除本次随机账户和已验证的运行目录。
# 密码只存在于当前 PowerShell 进程的内存和 SecureString 中，不进入 argv、环境、文件或输出。

[CmdletBinding()]
param(
    [ValidateSet("all", "build", "run")]
    [string]$Mode = "all"
)

$ErrorActionPreference = "Stop"

$experimentRoot = $PSScriptRoot
$repositoryRoot = (Resolve-Path (Join-Path $experimentRoot "..\..")).Path
$buildRoot = Join-Path $repositoryRoot ".local\windows-sandbox-user-demo"
$sharedProbeRoot = Join-Path $repositoryRoot ".local\windows-restricted-token-demo"
$sharedProbePath = Join-Path $sharedProbeRoot "restricted-token-demo.exe"
$sharedBuildScript = Join-Path $repositoryRoot "experiments\windows-restricted-token-demo\run-demo.ps1"

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "run 模式必须在提升的 PowerShell 中执行；build 模式不需要管理员权限。"
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

function New-CapabilitySidText {
    $parts = 1..4 | ForEach-Object { Get-Random -Minimum 100000 -Maximum 2147483647 }
    return "S-1-5-21-$($parts[0])-$($parts[1])-$($parts[2])-$($parts[3])"
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

function Set-ProbeDirectoryAcl {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [Security.Principal.SecurityIdentifier]$SandboxSid,
        [Parameter(Mandatory)]
        [Security.Principal.SecurityIdentifier[]]$CapabilitySid,
        [Parameter(Mandatory)]
        [Security.AccessControl.FileSystemRights]$SandboxRights,
        [Parameter(Mandatory)]
        [Security.AccessControl.FileSystemRights]$CapabilityRights
    )

    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)

    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-18")
    $administratorsSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")

    Add-AllowRule -Acl $acl -Identity $currentSid -Rights FullControl
    Add-AllowRule -Acl $acl -Identity $systemSid -Rights FullControl
    Add-AllowRule -Acl $acl -Identity $administratorsSid -Rights FullControl
    Add-AllowRule -Acl $acl -Identity $SandboxSid -Rights $SandboxRights
    foreach ($sid in $CapabilitySid) {
        Add-AllowRule -Acl $acl -Identity $sid -Rights $CapabilityRights
    }

    Set-Acl -LiteralPath $Path -AclObject $acl
}

function New-ProbePassword {
    $random = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
    return "Aa1!$random"
}

function Start-AccountProbe {
    param(
        [Parameter(Mandatory)]
        [string]$Executable,
        [Parameter(Mandatory)]
        [string]$UserName,
        [Parameter(Mandatory)]
        [Security.SecureString]$Password,
        [Parameter(Mandatory)]
        [string]$ExecutionSid,
        [Parameter(Mandatory)]
        [string]$RootCapabilitySid,
        [Parameter(Mandatory)]
        [string]$ReadPath,
        [Parameter(Mandatory)]
        [string]$SystemReadPath,
        [Parameter(Mandatory)]
        [string]$WriteRoot,
        [Parameter(Mandatory)]
        [string]$DenyRoot,
        [switch]$Concurrent
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.WorkingDirectory = $WriteRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.LoadUserProfile = $false
    $startInfo.Domain = "."
    $startInfo.UserName = $UserName
    $startInfo.Password = $Password.Copy()

    $launcherMode = if ($Concurrent) {
        "--dedicated-account-concurrent-launch"
    }
    else {
        "--dedicated-account-launch"
    }
    foreach ($argument in @(
            $launcherMode,
            $ExecutionSid,
            $RootCapabilitySid,
            $ReadPath,
            $SystemReadPath,
            $WriteRoot,
            $DenyRoot
        )) {
        [void]$startInfo.ArgumentList.Add($argument)
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "无法启动专用账户 bootstrap。"
    }

    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()

    return [pscustomobject]@{
        Process = $process
        StandardOutputTask = $stdoutTask
        StandardErrorTask = $stderrTask
    }
}

function Complete-AccountProbe {
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$RunningProbe
    )

    $RunningProbe.Process.WaitForExit()
    $stdout = $RunningProbe.StandardOutputTask.GetAwaiter().GetResult()
    $stderr = $RunningProbe.StandardErrorTask.GetAwaiter().GetResult()

    if ($stdout) {
        Write-Host $stdout.TrimEnd()
    }
    if ($stderr) {
        Write-Warning $stderr.TrimEnd()
    }
    if ($RunningProbe.Process.ExitCode -ne 0) {
        throw "专用账户探针失败，退出码 $($RunningProbe.Process.ExitCode)。"
    }

    $context = [regex]::Match(
        $stdout,
        'CONTEXT launcher-parent pid=\d+ userSid=(?<userSid>\S+) logonSid=(?<logonSid>\S+)'
    )
    if (-not $context.Success) {
        throw "探针输出缺少 launcher 身份证据。"
    }
    $identity = [regex]::Match(
        $stdout,
        'INFO executionSid=(?<executionSid>\S+) rootCapabilitySid=(?<rootCapabilitySid>\S+)'
    )
    if (-not $identity.Success) {
        throw "探针输出缺少 execution/root capability 身份证据。"
    }

    return [pscustomobject]@{
        UserSid = $context.Groups["userSid"].Value
        LogonSid = $context.Groups["logonSid"].Value
        ExecutionSid = $identity.Groups["executionSid"].Value
        RootCapabilitySid = $identity.Groups["rootCapabilitySid"].Value
        Output = $stdout
    }
}

function Build-Demo {
    & $sharedBuildScript -Mode build
    if ($LASTEXITCODE -ne 0) {
        throw "共享 restricted-token 探针构建失败，退出码 $LASTEXITCODE。"
    }
}

function Invoke-Demo {
    Assert-Administrator
    if (-not (Test-Path -LiteralPath $sharedProbePath -PathType Leaf)) {
        throw "探针不存在，请先使用 -Mode build 或 -Mode all。"
    }

    New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
    $runRoot = Join-Path $buildRoot ("run-" + [guid]::NewGuid().ToString("N"))
    Assert-PathContained -Path $runRoot -Root $buildRoot

    $accountName = "CAProbe" + [guid]::NewGuid().ToString("N").Substring(0, 8)
    $plainPassword = New-ProbePassword
    $securePassword = ConvertTo-SecureString $plainPassword -AsPlainText -Force
    $accountCreated = $false
    $runningA = $null
    $runningB = $null

    try {
        $account = New-LocalUser `
            -Name $accountName `
            -Password $securePassword `
            -AccountNeverExpires `
            -PasswordNeverExpires `
            -UserMayNotChangePassword `
            -Description "Disposable CodeAtelier sandbox boundary probe"
        $accountCreated = $true
        Add-LocalGroupMember -SID "S-1-5-32-545" -Member $account

        $sandboxSid = [Security.Principal.SecurityIdentifier]::new($account.SID.Value)
        $executionAText = New-CapabilitySidText
        $executionBText = New-CapabilitySidText
        $rootCapabilityAText = New-CapabilitySidText
        $rootCapabilityBText = New-CapabilitySidText
        $executionA = [Security.Principal.SecurityIdentifier]::new($executionAText)
        $executionB = [Security.Principal.SecurityIdentifier]::new($executionBText)
        $rootCapabilityA = [Security.Principal.SecurityIdentifier]::new($rootCapabilityAText)
        $rootCapabilityB = [Security.Principal.SecurityIdentifier]::new($rootCapabilityBText)

        $workspaceA = Join-Path $runRoot "workspace-a"
        $workspaceB = Join-Path $runRoot "workspace-b"
        New-Item -ItemType Directory -Path $runRoot, $workspaceA, $workspaceB | Out-Null
        Copy-Item -LiteralPath $sharedProbePath -Destination (Join-Path $runRoot "sandbox-user-probe.exe")
        Set-Content -LiteralPath (Join-Path $workspaceA "readable.txt") -Value "workspace-a"
        Set-Content -LiteralPath (Join-Path $workspaceB "readable.txt") -Value "workspace-b"
        Set-Content -LiteralPath (Join-Path $workspaceA "existing.txt") -Value "workspace-a-existing"
        Set-Content -LiteralPath (Join-Path $workspaceB "existing.txt") -Value "workspace-b-existing"

        Set-ProbeDirectoryAcl `
            -Path $runRoot `
            -SandboxSid $sandboxSid `
            -CapabilitySid @($executionA, $executionB) `
            -SandboxRights ReadAndExecute `
            -CapabilityRights ReadAndExecute
        Set-ProbeDirectoryAcl `
            -Path $workspaceA `
            -SandboxSid $sandboxSid `
            -CapabilitySid $rootCapabilityA `
            -SandboxRights Modify `
            -CapabilityRights Modify
        Set-ProbeDirectoryAcl `
            -Path $workspaceB `
            -SandboxSid $sandboxSid `
            -CapabilitySid $rootCapabilityB `
            -SandboxRights Modify `
            -CapabilityRights Modify

        $probeExecutable = Join-Path $runRoot "sandbox-user-probe.exe"
        $systemReadPath = Join-Path $env:SystemRoot "win.ini"
        $runningA = Start-AccountProbe `
            -Executable $probeExecutable `
            -UserName $accountName `
            -Password $securePassword `
            -ExecutionSid $executionAText `
            -RootCapabilitySid $rootCapabilityAText `
            -ReadPath (Join-Path $workspaceB "readable.txt") `
            -SystemReadPath $systemReadPath `
            -WriteRoot $workspaceA `
            -DenyRoot $workspaceB `
            -Concurrent
        $runningB = Start-AccountProbe `
            -Executable $probeExecutable `
            -UserName $accountName `
            -Password $securePassword `
            -ExecutionSid $executionBText `
            -RootCapabilitySid $rootCapabilityBText `
            -ReadPath (Join-Path $workspaceA "readable.txt") `
            -SystemReadPath $systemReadPath `
            -WriteRoot $workspaceB `
            -DenyRoot $workspaceA `
            -Concurrent

        $resultA = Complete-AccountProbe -RunningProbe $runningA
        $resultB = Complete-AccountProbe -RunningProbe $runningB

        if ($resultA.UserSid -ne $sandboxSid.Value -or $resultB.UserSid -ne $sandboxSid.Value) {
            throw "bootstrap 没有以预期的专用账户 SID 运行。"
        }
        if ($resultA.ExecutionSid -ne $executionAText -or $resultB.ExecutionSid -ne $executionBText) {
            throw "bootstrap 没有使用预期的 execution SID。"
        }
        if (
            $resultA.RootCapabilitySid -ne $rootCapabilityAText -or
            $resultB.RootCapabilitySid -ne $rootCapabilityBText
        ) {
            throw "bootstrap 没有使用预期的 root capability SID。"
        }
        foreach ($result in @($resultA, $resultB)) {
            if (-not $result.Output.Contains("PASS peer-process-dangerous-access-denied count=4")) {
                throw "探针缺少 peer process 拒绝证据。"
            }
            if (-not $result.Output.Contains("PASS peer-thread-dangerous-access-denied count=3")) {
                throw "探针缺少 peer thread 拒绝证据。"
            }
            if (-not $result.Output.Contains("PASS peer-job-dangerous-access-denied")) {
                throw "探针缺少 peer Job 拒绝证据。"
            }
            if (-not $result.Output.Contains("PASS concurrent-peer-object-isolation")) {
                throw "探针缺少并发对象隔离总结果。"
            }
        }

        foreach ($workspace in @($workspaceA, $workspaceB)) {
            foreach ($name in @("direct-write.txt", "nested-write.txt")) {
                if (-not (Test-Path -LiteralPath (Join-Path $workspace $name) -PathType Leaf)) {
                    throw "缺少预期写入：$(Join-Path $workspace $name)"
                }
            }
            if (Test-Path -LiteralPath (Join-Path $workspace "direct-denied.txt")) {
                throw "发现跨实例直接写入：$(Join-Path $workspace 'direct-denied.txt')"
            }
            if (Test-Path -LiteralPath (Join-Path $workspace "nested-denied.txt")) {
                throw "发现跨实例后代写入：$(Join-Path $workspace 'nested-denied.txt')"
            }
        }

        $logonSidReused = $resultA.LogonSid -eq $resultB.LogonSid
        Write-Host "DEMO PASS accountSid=$($sandboxSid.Value) distinctExecutionSids=yes logonSidReused=$($logonSidReused.ToString().ToLowerInvariant()) concurrent=yes peerProcessDenied=yes peerThreadDenied=yes peerJobDenied=yes crossRead=yes ownWrite=yes crossWriteDenied=yes nestedProcess=yes"
    }
    finally {
        $plainPassword = $null
        $securePassword = $null
        $cleanupFailures = [Collections.Generic.List[string]]::new()

        foreach ($runningProbe in @($runningA, $runningB)) {
            if ($null -eq $runningProbe) {
                continue
            }
            try {
                if (-not $runningProbe.Process.HasExited) {
                    $runningProbe.Process.Kill($true)
                    $runningProbe.Process.WaitForExit()
                }
                $runningProbe.Process.Dispose()
            }
            catch {
                $cleanupFailures.Add("并发探针进程清理失败：$($_.Exception.Message)")
            }
        }

        try {
            Assert-PathContained -Path $runRoot -Root $buildRoot
            if (Test-Path -LiteralPath $runRoot) {
                Remove-Item -LiteralPath $runRoot -Recurse -Force
            }
        }
        catch {
            $cleanupFailures.Add("运行目录清理失败：$($_.Exception.Message)")
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
            $cleanupFailures.Add("临时账户清理失败：$($_.Exception.Message)")
        }

        if ($cleanupFailures.Count -gt 0) {
            throw ($cleanupFailures -join [Environment]::NewLine)
        }
    }
}

if ($Mode -in @("all", "build")) {
    Build-Demo
}
if ($Mode -in @("all", "run")) {
    Invoke-Demo
}
