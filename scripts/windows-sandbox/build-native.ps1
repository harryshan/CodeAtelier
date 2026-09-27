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
3. Compile with C++20, warnings, CFG, ASLR, DEP and release optimization; the
   network target defines CODEATELIER_PRODUCT_WFP_ONLY so experiment CLI modes
   are not part of the installed product executable.
4. Build and run the native installation-state parser regression without
   creating an account, ACL, or WFP rule.
5. Run the real Named Pipe duplex regression in a bounded child process so a
   synchronous read/write deadlock fails the build rather than hanging it.
6. Return a nonzero exit when a binary is missing, compilation fails, or a
   regression fails.
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
$NetworkSource = Join-Path $RepositoryRoot "native\windows-sandbox\network-fence-implementation.cpp"
$RunnerSource = Join-Path $RepositoryRoot "native\windows-sandbox\restricted-runner.cpp"
$StateParserTestSource = Join-Path $RepositoryRoot "tests\native\windows-sandbox-installation-state.cpp"
$NetworkOutput = Join-Path $OutputRoot "codeatelier-sandbox-network.exe"
$RunnerOutput = Join-Path $OutputRoot "codeatelier-sandbox-supervisor.exe"
$StateParserTestOutput = Join-Path $OutputRoot "codeatelier-sandbox-state-parser-test.exe"
$NetworkLibraries = "fwpuclnt.lib ws2_32.lib advapi32.lib ole32.lib"
$RunnerLibraries = "advapi32.lib userenv.lib user32.lib ole32.lib crypt32.lib"

function Invoke-MsvcBuild {
    param(
        [Parameter(Mandatory)]
        [string]$Source,
        [Parameter(Mandatory)]
        [string]$Output,
        [Parameter(Mandatory)]
        [string]$Libraries,
        [string]$Definitions = ""
    )

    $Object = [IO.Path]::ChangeExtension($Output, ".obj")
    $Command = "`"$VsDevCmd`" -arch=x64 -host_arch=x64 >nul && cl $CompilerFlags $Definitions `"$Source`" /Fo:`"$Object`" /Fe:`"$Output`" /link $LinkerFlags $Libraries"
    & $env:ComSpec /d /s /c $Command
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Output -PathType Leaf)) {
        throw "原生 Sandbox 构建失败：$([IO.Path]::GetFileName($Output))"
    }
}

Invoke-MsvcBuild -Source $NetworkSource -Output $NetworkOutput -Libraries $NetworkLibraries -Definitions "/DCODEATELIER_PRODUCT_WFP_ONLY"
Invoke-MsvcBuild -Source $RunnerSource -Output $RunnerOutput -Libraries $RunnerLibraries
Invoke-MsvcBuild -Source $StateParserTestSource -Output $StateParserTestOutput -Libraries $RunnerLibraries

& $StateParserTestOutput
if ($LASTEXITCODE -ne 0) {
    throw "原生 Sandbox 安装状态解析回归失败。"
}

$Probe = [Diagnostics.Process]::new()
$Probe.StartInfo.FileName = $StateParserTestOutput
$Probe.StartInfo.Arguments = "--runtime-duplex-probe"
$Probe.StartInfo.UseShellExecute = $false
$Probe.StartInfo.CreateNoWindow = $true
$Probe.StartInfo.RedirectStandardOutput = $true
$Probe.StartInfo.RedirectStandardError = $true

try {
    if (-not $Probe.Start()) {
        throw "无法启动原生 Runtime 双向管道回归。"
    }
    if (-not $Probe.WaitForExit(5000)) {
        $Probe.Kill($true)
        $Probe.WaitForExit()
        throw "原生 Runtime 双向管道回归超时。"
    }

    $ProbeOutput = $Probe.StandardOutput.ReadToEnd()
    $ProbeError = $Probe.StandardError.ReadToEnd()
    if ($Probe.ExitCode -ne 0 -or -not $ProbeOutput.Contains("SANDBOX_RUNTIME_DUPLEX_PROBE PASS")) {
        throw "原生 Runtime 双向管道回归失败：$ProbeError"
    }

    Write-Host $ProbeOutput.Trim()
}
finally {
    $Probe.Dispose()
}

Write-Host "SANDBOX_NATIVE_BUILD PASS output=$OutputRoot"
