<#
.SYNOPSIS
Builds the reviewed native Windows Sandbox boundary executables.

.DESCRIPTION
This script locates MSVC through vswhere and compiles the WFP fence manager and
restricted-token runner into dist/native/windows-x64. It never installs an
account, ACL, WFP rule, service, or scheduled task. The output directory is a
packaging artifact and can be removed by a normal clean build.

1. Resolve the repository and fixed source/output paths.
2. Enter the x64 MSVC environment without relying on the caller PATH.
3. Compile with C++20, warnings, CFG, ASLR, DEP and release optimization.
4. Return a nonzero exit when either binary is missing or the compiler fails.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$OutputRoot = Join-Path $RepositoryRoot "dist\native\windows-x64"
$VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"

if (-not (Test-Path -LiteralPath $VsWhere -PathType Leaf)) {
    throw "找不到 vswhere.exe；请安装带 MSVC x64 工具链的 Visual Studio Build Tools。"
}

$Installation = & $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $Installation) {
    throw "找不到可用的 MSVC x64 工具链。"
}

$VsDevCmd = Join-Path $Installation "Common7\Tools\VsDevCmd.bat"
if (-not (Test-Path -LiteralPath $VsDevCmd -PathType Leaf)) {
    throw "Visual Studio 安装缺少 VsDevCmd.bat。"
}

New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

$CompilerFlags = "/nologo /std:c++20 /EHsc /W4 /O2 /guard:cf /DUNICODE /D_UNICODE /utf-8"
$LinkerFlags = "/guard:cf /DYNAMICBASE /NXCOMPAT"
$NetworkSource = Join-Path $RepositoryRoot "native\windows-sandbox\network-fence.cpp"
$RunnerSource = Join-Path $RepositoryRoot "native\windows-sandbox\restricted-runner.cpp"
$NetworkOutput = Join-Path $OutputRoot "codeatelier-sandbox-network.exe"
$RunnerOutput = Join-Path $OutputRoot "codeatelier-sandbox-supervisor.exe"
$NetworkLibraries = "fwpuclnt.lib ws2_32.lib advapi32.lib ole32.lib"
$RunnerLibraries = "advapi32.lib userenv.lib ole32.lib crypt32.lib"

function Invoke-MsvcBuild {
    param(
        [Parameter(Mandatory)]
        [string]$Source,
        [Parameter(Mandatory)]
        [string]$Output,
        [Parameter(Mandatory)]
        [string]$Libraries
    )

    $Object = [IO.Path]::ChangeExtension($Output, ".obj")
    $Command = "`"$VsDevCmd`" -arch=x64 -host_arch=x64 >nul && cl $CompilerFlags `"$Source`" /Fo:`"$Object`" /Fe:`"$Output`" /link $LinkerFlags $Libraries"
    & $env:ComSpec /d /s /c $Command
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Output -PathType Leaf)) {
        throw "原生 Sandbox 构建失败：$([IO.Path]::GetFileName($Output))"
    }
}

Invoke-MsvcBuild -Source $NetworkSource -Output $NetworkOutput -Libraries $NetworkLibraries
Invoke-MsvcBuild -Source $RunnerSource -Output $RunnerOutput -Libraries $RunnerLibraries

Write-Host "SANDBOX_NATIVE_BUILD PASS output=$OutputRoot"
