# 文件作用：从 PowerShell 手动编译并刷新前三题评测环境，可继续运行预测和评分。
# 代码结构：解析仅准备选项、编译后端、转换 WSL 路径，再交给 Python 执行刷新与运行。
param(
    [switch]$PrepareOnly,
    [string]$Distribution = 'Ubuntu-26.04'
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $projectRoot
try {
    & pnpm eval:build
    if ($LASTEXITCODE -ne 0) { throw 'Evaluation build failed.' }

    $linuxRoot = & wsl -d $Distribution -u root -- wslpath -a $projectRoot
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve repository path in WSL.' }
    $linuxRoot = $linuxRoot.Trim()
    $pythonArguments = @("$linuxRoot/scripts/swebench/refresh_run.py", '--root', $linuxRoot)
    if ($PrepareOnly) { $pythonArguments += '--prepare-only' }
    & wsl -d $Distribution -u root -- "$linuxRoot/.local/swebench-venv/bin/python" @pythonArguments
    if ($LASTEXITCODE -ne 0) { throw 'Refresh/evaluation failed; see the stage output and preserved artifacts.' }
}
finally {
    Pop-Location
}
