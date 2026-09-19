<#
.SYNOPSIS
Builds and runs the Windows network and Broker IPC feasibility probes.

.DESCRIPTION
The script locates MSVC, builds network_ipc_demo.cpp into the repository-local
ignored .local directory, then runs either the named-pipe identity probe or the
dynamic WFP APP_ID probe. The WFP mode needs elevated BFE policy access and uses
only a loopback TCP listener. Its dynamic filter is removed when the process exits.
#>

[CmdletBinding()]
param(
    [ValidateSet("all", "build", "ipc", "wfp")]
    [string]$Mode = "all"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$buildRoot = Join-Path $repoRoot ".local\windows-network-ipc-demo"
$sourcePath = Join-Path $PSScriptRoot "network_ipc_demo.cpp"
$executablePath = Join-Path $buildRoot "network_ipc_demo.exe"

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

if ($Mode -in @("all", "build")) {
    Build-Demo
}
if ($Mode -in @("all", "ipc")) {
    Invoke-Probe -Probe ipc
}
if ($Mode -in @("all", "wfp")) {
    Invoke-Probe -Probe wfp
}
