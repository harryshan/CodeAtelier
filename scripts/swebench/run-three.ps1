# Windows 下手动运行前三题评测的入口，将构建后的后端交给 WSL 中的 refresh_run.py。
# 可选择只准备镜像，或继续生成补丁并评分。
#
# 1. 读取 PrepareOnly 和 Distribution，定位仓库并记住当前目录。
# 2. 运行 pnpm eval:build，编译失败就停止。
# 3. 用 wslpath 转换路径，准备 Python 命令及可选的 prepare-only 参数。
# 4. 在指定 WSL 发行版中执行，检查退出码，最后恢复原工作目录。
#
# PrepareOnly 也会构建和刷新 Docker 镜像；整个入口只由用户手动执行。

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

    # 直接传参数，避免 shell 再次拆分；路径使用正斜杠，避免 Windows 反斜杠转义。
    $wslInputPath = $projectRoot.Replace('\', '/')
    $linuxRoot = & wsl -d $Distribution -u root --exec wslpath -a $wslInputPath
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve repository path in WSL.' }
    $linuxRoot = $linuxRoot.Trim()
    $pythonArguments = @("$linuxRoot/scripts/swebench/refresh_run.py", '--root', $linuxRoot)
    if ($PrepareOnly) { $pythonArguments += '--prepare-only' }
    & wsl -d $Distribution -u root --exec "$linuxRoot/.local/swebench-venv/bin/python" @pythonArguments
    if ($LASTEXITCODE -ne 0) { throw 'Refresh/evaluation failed; see the stage output and preserved artifacts.' }
}
finally {
    Pop-Location
}
