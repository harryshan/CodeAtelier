<#
.SYNOPSIS
Validates the Git configuration projection planned for the Windows Sandbox.

.DESCRIPTION
This non-admin feasibility probe creates a repository, a private Runtime home,
and a Broker-owned read-only projection directory under the repository-local
ignored .local tree. It then runs the installed Git with a minimal environment
and verifies, in precedence order:

1. A synthetic system config is loaded.
2. Two projected global entry files and a matching includeIf are loaded through
   one GIT_CONFIG_GLOBAL aggregate file.
3. Repository local and worktree config remain enabled.
4. A decoy private-home .gitconfig is not discovered.
5. `git config --global` cannot create its lock file in the read-only projection.

The probe does not parse arbitrary host config or run credential helpers. It
only checks the core projection and precedence mechanism needed before product
implementation.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$buildRoot = Join-Path $repoRoot ".local\windows-git-config-demo"
$runRoot = Join-Path $buildRoot ("run-" + [guid]::NewGuid().ToString("N"))
$workspace = Join-Path $runRoot "workspace"
$privateHome = Join-Path $runRoot "private-home"
$projectionRoot = Join-Path $runRoot "broker-config-projection"
$gitPath = (Get-Command git -ErrorAction Stop).Source
$projectionOriginalAcl = $null

function Convert-ToGitPath {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    return [IO.Path]::GetFullPath($Path).Replace('\', '/')
}

function Write-Utf8File {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$Content
    )

    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Add-DirectoryRule {
    param(
        [Parameter(Mandatory)]
        [Security.AccessControl.DirectorySecurity]$Acl,
        [Parameter(Mandatory)]
        [Security.Principal.IdentityReference]$Identity,
        [Parameter(Mandatory)]
        [Security.AccessControl.FileSystemRights]$Rights,
        [Parameter(Mandatory)]
        [Security.AccessControl.AccessControlType]$Type
    )

    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $Identity,
        $Rights,
        $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        $Type
    )
    [void]$Acl.AddAccessRule($rule)
}

function Set-ProjectionReadOnly {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $script:projectionOriginalAcl = Get-Acl -LiteralPath $Path
    $acl = Get-Acl -LiteralPath $Path
    $writeRights = [Security.AccessControl.FileSystemRights]::CreateFiles -bor
        [Security.AccessControl.FileSystemRights]::CreateDirectories -bor
        [Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::Delete
    Add-DirectoryRule -Acl $acl -Identity $currentSid -Rights $writeRights -Type Deny
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Restore-ProjectionControl {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        return
    }
    if ($null -ne $script:projectionOriginalAcl) {
        Set-Acl -LiteralPath $Path -AclObject $script:projectionOriginalAcl
    }
}

function Invoke-IsolatedGit {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments,
        [Parameter(Mandatory)]
        [hashtable]$Environment
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $gitPath
    $startInfo.WorkingDirectory = $workspace
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.Environment.Clear()
    foreach ($entry in $Environment.GetEnumerator()) {
        $startInfo.Environment[$entry.Key] = [string]$entry.Value
    }
    foreach ($argument in $Arguments) {
        [void]$startInfo.ArgumentList.Add($argument)
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "无法启动 Git 探针。"
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        Stdout = $stdoutTask.GetAwaiter().GetResult()
        Stderr = $stderrTask.GetAwaiter().GetResult()
    }
}

New-Item -ItemType Directory -Force -Path $workspace, $privateHome, $projectionRoot | Out-Null

try {
    & $gitPath -C $workspace init --quiet
    if ($LASTEXITCODE -ne 0) { throw "无法初始化 Git 探针仓库。" }
    & $gitPath -C $workspace config extensions.worktreeConfig true
    & $gitPath -C $workspace config --local --add codeatelier.order local
    & $gitPath -C $workspace config --worktree --add codeatelier.order worktree
    if ($LASTEXITCODE -ne 0) { throw "无法创建 local/worktree Git 配置。" }

    $systemConfig = Join-Path $projectionRoot "system.cfg"
    $globalA = Join-Path $projectionRoot "global-a.cfg"
    $conditional = Join-Path $projectionRoot "conditional.cfg"
    $globalB = Join-Path $projectionRoot "global-b.cfg"
    $aggregate = Join-Path $projectionRoot "aggregate.cfg"
    Write-Utf8File -Path $systemConfig -Content "[codeatelier]`n    order = system`n"
    Write-Utf8File -Path $conditional -Content "[codeatelier]`n    order = conditional`n"
    Write-Utf8File -Path $globalA -Content @"
[codeatelier]
    order = global-a
[includeIf "gitdir/i:**/workspace/.git"]
    path = "$(Convert-ToGitPath $conditional)"
"@
    Write-Utf8File -Path $globalB -Content "[codeatelier]`n    order = global-b`n"
    Write-Utf8File -Path $aggregate -Content @"
[include]
    path = "$(Convert-ToGitPath $globalA)"
[include]
    path = "$(Convert-ToGitPath $globalB)"
"@
    Write-Utf8File -Path (Join-Path $privateHome ".gitconfig") `
        -Content "[codeatelier]`n    order = private-home-decoy`n"

    Set-ProjectionReadOnly -Path $projectionRoot
    $environment = @{
        SystemRoot = $env:SystemRoot
        WINDIR = $env:WINDIR
        TEMP = $privateHome
        TMP = $privateHome
        HOME = $privateHome
        USERPROFILE = $privateHome
        XDG_CONFIG_HOME = $privateHome
        GIT_CONFIG_SYSTEM = $systemConfig
        GIT_CONFIG_GLOBAL = $aggregate
        GIT_TERMINAL_PROMPT = "0"
        PATH = Split-Path -Parent $gitPath
    }

    $readResult = Invoke-IsolatedGit `
        -Arguments @("config", "--show-origin", "--get-all", "codeatelier.order") `
        -Environment $environment
    if ($readResult.ExitCode -ne 0) {
        throw "Git 配置读取失败：$($readResult.Stderr.Trim())"
    }
    $values = @(
        $readResult.Stdout -split "`r?`n" |
            Where-Object { $_ } |
            ForEach-Object {
                if ($_ -notmatch "`t(?<value>[^`t]+)$") {
                    throw "无法解析 Git --show-origin 输出：$_"
                }
                $Matches.value
            }
    )
    $expected = @("system", "global-a", "conditional", "global-b", "local", "worktree")
    if (($values -join "|") -ne ($expected -join "|")) {
        throw "Git 配置顺序不符合预期：$($values -join ',')；origin=$($readResult.Stdout.Trim())"
    }

    $writeResult = Invoke-IsolatedGit `
        -Arguments @("config", "--global", "codeatelier.write", "denied") `
        -Environment $environment
    if ($writeResult.ExitCode -eq 0) {
        throw "只读 global config projection 被 Git 意外写入。"
    }

    Write-Host "GIT_CONFIG_DEMO PASS order=$($values -join ',') privateHomeDecoyIgnored=yes globalWriteDenied=yes"
}
finally {
    Restore-ProjectionControl -Path $projectionRoot
    if (Test-Path -LiteralPath $runRoot) {
        Remove-Item -LiteralPath $runRoot -Recurse -Force
    }
}
