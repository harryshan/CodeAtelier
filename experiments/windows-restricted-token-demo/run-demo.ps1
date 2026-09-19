# 本脚本构建并运行 CodeAtelier Windows restricted-token 最小探针，供开发者手动验证设计假设。
# 代码结构：参数控制 build/run；Resolve-VsDevCmd 定位 MSVC；Build-Demo 将二进制写入已忽略的 .local；
# Invoke-Demo 创建两个同属当前用户的临时目录和外部可读文件，运行原生 launcher，核对允许/拒绝结果，
# 最后只清理本脚本创建且已验证位于 .local 构建根下的临时目录。脚本不安装 WFP 或修改产品配置。

[CmdletBinding()]
param(
    [ValidateSet("all", "build", "run")]
    [string]$Mode = "all"
)

$ErrorActionPreference = "Stop"

$experimentRoot = $PSScriptRoot
$repositoryRoot = (Resolve-Path (Join-Path $experimentRoot "..\..")).Path
$buildRoot = Join-Path $repositoryRoot ".local\windows-restricted-token-demo"
$sourcePath = Join-Path $experimentRoot "restricted_token_demo.cpp"
$executablePath = Join-Path $buildRoot "restricted-token-demo.exe"

function Resolve-VsDevCmd {
    $candidates = Get-ChildItem `
        -Path "${env:ProgramFiles}\Microsoft Visual Studio\*\*\Common7\Tools\VsDevCmd.bat" `
        -File `
        -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending

    if ($candidates.Count -eq 0) {
        throw "未找到 Visual Studio C++ 工具链（VsDevCmd.bat）。"
    }

    return $candidates[0].FullName
}

function Build-Demo {
    New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null

    $vsDevCmd = Resolve-VsDevCmd
    $compile = @(
        "call `"$vsDevCmd`" -arch=x64 -host_arch=x64 >nul",
        "cl /nologo /std:c++20 /W4 /WX /EHsc /DUNICODE /D_UNICODE `"$sourcePath`" /Fo:`"$buildRoot\restricted_token_demo.obj`" /Fe:`"$executablePath`" /link Advapi32.lib Ole32.lib"
    ) -join " && "

    & $env:ComSpec /d /s /c $compile
    if ($LASTEXITCODE -ne 0) {
        throw "MSVC 编译失败，退出码 $LASTEXITCODE。"
    }

    Write-Host "BUILD PASS executable=$executablePath"
}

function Assert-PathContained {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$Root
    )

    $normalizedPath = [System.IO.Path]::GetFullPath($Path)
    $normalizedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (-not $normalizedPath.StartsWith($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝清理构建根之外的路径：$normalizedPath"
    }
}

function Invoke-Demo {
    if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
        throw "探针不存在，请先使用 -Mode build 或 -Mode all。"
    }

    $runRoot = Join-Path $buildRoot ("run-" + [guid]::NewGuid().ToString("N"))
    $writeRoot = Join-Path $runRoot "allowed"
    $denyRoot = Join-Path $runRoot "outside"
    $readPath = Join-Path $denyRoot "readable.txt"
    $systemReadPath = Join-Path $env:SystemRoot "win.ini"

    Assert-PathContained -Path $runRoot -Root $buildRoot
    if (-not (Test-Path -LiteralPath $systemReadPath -PathType Leaf)) {
        throw "缺少系统读取探针文件：$systemReadPath"
    }
    New-Item -ItemType Directory -Path $writeRoot, $denyRoot | Out-Null
    Set-Content -LiteralPath (Join-Path $writeRoot "existing.txt") -Value "created-before-acl" -Encoding utf8NoBOM
    Set-Content -LiteralPath $readPath -Value "current-user-readable" -Encoding utf8NoBOM

    try {
        Write-Host "RUN CONTEXT callerPid=$PID"
        & $executablePath --launch $readPath $systemReadPath $writeRoot $denyRoot
        $probeExitCode = $LASTEXITCODE
        if ($probeExitCode -ne 0) {
            throw "Restricted-token 探针失败，退出码 $probeExitCode。"
        }

        $expectedWrites = @(
            (Join-Path $writeRoot "existing.txt"),
            (Join-Path $writeRoot "direct-write.txt"),
            (Join-Path $writeRoot "nested-write.txt")
        )
        $forbiddenWrites = @(
            (Join-Path $denyRoot "direct-denied.txt"),
            (Join-Path $denyRoot "nested-denied.txt")
        )

        foreach ($path in $expectedWrites) {
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                throw "缺少预期写入：$path"
            }
        }
        foreach ($path in $forbiddenWrites) {
            if (Test-Path -LiteralPath $path) {
                throw "发现越界写入：$path"
            }
        }

        $existingContent = Get-Content -Raw -LiteralPath (Join-Path $writeRoot "existing.txt")
        if (-not $existingContent.Contains("restricted-append-ok")) {
            throw "安装根 ACE 前的已有文件没有被修改。"
        }

        Write-Host "DEMO PASS reads=2 allowedWrites=3 deniedWrites=2 nestedProcess=yes"
    }
    finally {
        Assert-PathContained -Path $runRoot -Root $buildRoot
        if (Test-Path -LiteralPath $runRoot) {
            Remove-Item -LiteralPath $runRoot -Recurse -Force
        }
    }
}

if ($Mode -in @("all", "build")) {
    Build-Demo
}
if ($Mode -in @("all", "run")) {
    Invoke-Demo
}
