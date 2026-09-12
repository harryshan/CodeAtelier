# 文件作用：从 PowerShell 手动编译并刷新前三题评测环境，可继续运行预测和评分。
#
# 使用场景与输入输出：
# Windows 用户手动入口，使用指定 WSL 发行版中的评测 Python 环境，把当前仓库交给 refresh_run.py。
#
# 代码结构与阅读顺序：
# 1. param 声明 PrepareOnly 与 Distribution，随后定位仓库并保存调用前工作目录。
# 2. 先运行 pnpm eval:build，编译失败立即停止。
# 3. 通过 WSL wslpath 转换仓库路径，组装 Python 脚本及可选 prepare-only 参数。
# 4. 在指定发行版中执行脚本，检查退出码；finally 恢复 PowerShell 工作目录。
#
# 维护注意事项：
# 会启动 WSL 中的手动镜像刷新及可选评测，不属于普通检查；PrepareOnly 仍执行构建和镜像刷新。

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
