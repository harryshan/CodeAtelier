# 构建 WinFsp 原生 overlay helper，供工作区管理器和人工 Windows 验证使用。
# 1. 接收显式 SDK 目录，定位 MSVC；不下载/安装驱动或修改 Sandbox。
# 2. 编译 Store、Local 基线/目录依赖/代次/回收/发布及执行租约、Git PoC lower、回调和入口，链接系统 SQLite/BCrypt 与固定 SDK。
# 3. 使用 WinFsp delay-load，从已安装的官方 WinFsp 运行时加载 DLL；保留许可证。
# 4. -VerifyReparse 可选构建并运行纯解析回归，不需要创建符号链接权限或挂载。
# 5. -VerifyImport 使用独占 .local 夹具验证 Local 目录事务、重开身份、故障回滚；不挂载或更改安装态。
# 6. -BuildDirectoryProbe 只编译 Win32 小缓冲枚举探针，由手动挂载脚本运行。
# 仅写 dist/native/win32-x64 与可选 .local 测试产物；非默认 build/check 入口。
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Sdk, [switch]$VerifyReparse, [switch]$VerifyImport, [switch]$BuildDirectoryProbe)

$ErrorActionPreference = 'Stop'
$Repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Sdk = (Resolve-Path -LiteralPath $Sdk).Path
$VsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$Installation = & $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $Installation) { throw 'MSVC x64 toolchain missing' }
$DevCmd = Join-Path $Installation 'Common7\Tools\VsDevCmd.bat'
$Output = Join-Path $Repository 'dist\native\win32-x64'
New-Item -ItemType Directory -Force -Path $Output | Out-Null
$Sources = @('store.cpp', 'changes.cpp', 'directory.cpp', 'epochs.cpp', 'acknowledgement.cpp', 'collection.cpp', 'publish.cpp', 'publication-lease.cpp', 'git-lower.cpp', 'reparse.cpp', 'filesystem.cpp', 'main.cpp') | ForEach-Object { '"' + (Join-Path $Repository "native\winfsp-overlay\$_") + '"' }
$Command = "`"$DevCmd`" -arch=x64 -host_arch=x64 >nul && cl /nologo /std:c++20 /EHsc /W4 /O2 /guard:cf /DUNICODE /D_UNICODE /DNOMINMAX /utf-8 /I`"$Sdk\inc`" $($Sources -join ' ') /Fe:`"$Output\codeatelier-overlay.exe`" /Fo:`"$Output\\`" /link /guard:cf /DYNAMICBASE /NXCOMPAT /DELAYLOAD:winfsp-x64.dll `"$Sdk\lib\winfsp-x64.lib`" delayimp.lib advapi32.lib ole32.lib winsqlite3.lib bcrypt.lib"
& $env:ComSpec /d /s /c $Command
if ($LASTEXITCODE -ne 0) { throw 'WinFsp overlay build failed' }
Copy-Item -LiteralPath (Join-Path $Sdk 'License.txt') -Destination (Join-Path $Output 'WINFSP-LICENSE.txt')
Write-Host "OVERLAY_BUILD PASS $Output"
if ($VerifyReparse) {
    $TestOutput = Join-Path $Repository '.local\winfsp-native-test'
    New-Item -ItemType Directory -Force -Path $TestOutput | Out-Null
    $TestSources = @('store.cpp', 'changes.cpp', 'directory.cpp', 'epochs.cpp', 'git-lower.cpp', 'reparse.cpp', 'reparse-test.cpp') | ForEach-Object { '"' + (Join-Path $Repository "native\winfsp-overlay\$_") + '"' }
    $TestCommand = "`"$DevCmd`" -arch=x64 -host_arch=x64 >nul && cl /nologo /std:c++20 /EHsc /W4 /O2 /DUNICODE /D_UNICODE /DNOMINMAX /utf-8 /I`"$Sdk\inc`" $($TestSources -join ' ') /Fe:`"$TestOutput\reparse-test.exe`" /Fo:`"$TestOutput\\`" /link /DELAYLOAD:winfsp-x64.dll `"$Sdk\lib\winfsp-x64.lib`" delayimp.lib advapi32.lib ole32.lib winsqlite3.lib bcrypt.lib"
    & $env:ComSpec /d /s /c $TestCommand
    if ($LASTEXITCODE -ne 0) { throw 'Reparse test build failed' }
    & (Join-Path $TestOutput 'reparse-test.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Reparse containment regression failed' }
}
if ($VerifyImport) {
    $TestOutput = Join-Path $Repository '.local\winfsp-native-test'
    New-Item -ItemType Directory -Force -Path $TestOutput | Out-Null
    $TestSources = @('store.cpp', 'changes.cpp', 'directory.cpp', 'epochs.cpp', 'git-lower.cpp', 'reparse.cpp', 'import-test.cpp') | ForEach-Object { '"' + (Join-Path $Repository "native\winfsp-overlay\$_") + '"' }
    $TestCommand = "`"$DevCmd`" -arch=x64 -host_arch=x64 >nul && cl /nologo /std:c++20 /EHsc /W4 /O2 /DUNICODE /D_UNICODE /DNOMINMAX /utf-8 /I`"$Sdk\inc`" $($TestSources -join ' ') /Fe:`"$TestOutput\import-test.exe`" /Fo:`"$TestOutput\\`" /link /DELAYLOAD:winfsp-x64.dll `"$Sdk\lib\winfsp-x64.lib`" delayimp.lib advapi32.lib ole32.lib winsqlite3.lib bcrypt.lib"
    & $env:ComSpec /d /s /c $TestCommand
    if ($LASTEXITCODE -ne 0) { throw 'Local import test build failed' }
    $Fixture = Join-Path $TestOutput ('import-' + [Guid]::NewGuid().ToString('N'))
    & (Join-Path $TestOutput 'import-test.exe') $Fixture
    if ($LASTEXITCODE -ne 0) { throw 'Local import regression failed' }
}
if ($BuildDirectoryProbe) {
    $TestOutput = Join-Path $Repository '.local\winfsp-native-test'
    New-Item -ItemType Directory -Force -Path $TestOutput | Out-Null
    $ProbeSource = Join-Path $Repository 'native\winfsp-overlay\directory-probe.cpp'
    $TestCommand = "`"$DevCmd`" -arch=x64 -host_arch=x64 >nul && cl /nologo /std:c++20 /EHsc /W4 /O2 /DUNICODE /D_UNICODE /DNOMINMAX /utf-8 `"$ProbeSource`" /Fe:`"$TestOutput\directory-probe.exe`" /Fo:`"$TestOutput\\`""
    & $env:ComSpec /d /s /c $TestCommand
    if ($LASTEXITCODE -ne 0) { throw 'Directory probe build failed' }
}
