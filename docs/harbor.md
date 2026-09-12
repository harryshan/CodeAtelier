# Harbor 评测接入

Harbor 是外部评测工具，生产运行时不依赖它；Engine、工具、上下文和 SQLite 均复用生产实现。固定 Harbor 0.23.0、Python >= 3.12，产品继续使用 Web UI。

## 仅手动执行

用户要求：Evaluation 仅在用户需要时手动运行，不以任何形式自动触发。没有 Harbor CI、定时器、提交钩子或服务启动钩子。默认 `pnpm test`、`pnpm check` 不执行评测；评测回归也独立为手动 `pnpm eval:test`。本文所有运行命令均由用户自行选择执行。

## 准备

推荐 Linux 或 Windows WSL，使用 Docker Engine 与 Compose v2。Windows Python 可运行契约测试；容器执行需采用 Docker 所在系统的路径，不能混用 Windows/Linux venv。macOS Docker Desktop 尚未实测。

在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm eval:build
python3 -m venv .local/harbor-linux-venv
.local/harbor-linux-venv/bin/python -m pip install -r scripts/harbor/requirements.txt
.local/harbor-linux-venv/bin/python scripts/harbor/prepare.py
docker info
docker compose version
```

Windows Python 路径为 `.local/harbor-venv/Scripts/python.exe`。可在 Windows 构建打包，再在 WSL 的对应目录运行 Harbor。

`prepare.py` 只打包 `dist/server/**/*.js`、package.json 和 pnpm-lock.yaml，生成 SHA-256 清单；不打包 .env、Git、历史、日志、测试、源码映射或 node_modules。每次修改后重新构建和打包。

适配器上传运行包，在任务容器的 `/opt/codeatelier` 安装 Node 24.19.0 和 pnpm 11.22.0，按 lockfile 安装生产依赖并禁用安装脚本。初始化访问 nodejs.org、npm registry；缺少 curl/xz 时通过 apt 安装。若任务已提供完全相同版本的 Node 和 npm，则复用它；否则下载并核验官方 Node SHA-256 清单。不替换任务的系统 Node。当前面向 bash/glibc Linux x64/arm64 容器，不支持 Alpine/musl。

## 真实模型 smoke

API key 只放在 Harbor 宿主环境中，不放在命令行参数、任务文件或 kwargs。下面是示例占位符，不是真实凭据。入口不自动加载真实 .env。

```sh
export CODEATELIER_API_KEY='YOUR_API_KEY'
export CODEATELIER_BASE_URL='http://jp.harryshan.com:4141/v1'
.local/harbor-linux-venv/bin/python scripts/harbor/run.py run \
  -p evals/harbor/smoke-add \
  -a scripts.harbor.codeatelier:CodeAtelierAgent \
  -m codex/gpt-5.6-luna \
  --ak allow_workspace_commands=true \
  --ak max_total_tokens=100000 --ak max_model_calls=12 \
  --ak timeout_ms=150000 \
  -n 1 -k 1 --max-retries 0 --jobs-dir .local/harbor/jobs
```

`run.py` 将仓库加入 Python 导入路径后调用官方 CLI。smoke 要求修复加法，独立 verifier 检查正数、负数、零、混合符号和小数。用相同任务和 `-a oracle` 可验证参考修复，不消耗模型 token。

## Terminal-Bench

先运行 smoke，再从固定版本挑选任务（筛选参数见 `run --help`）。完整运行示例：

```sh
.local/harbor-linux-venv/bin/python scripts/harbor/run.py run \
  -d 'terminal-bench@2.0' \
  -a scripts.harbor.codeatelier:CodeAtelierAgent \
  -m codex/gpt-5.6-luna \
  --ak allow_workspace_commands=true --ak max_total_tokens=500000 \
  -n 1 -k 1 --max-retries 0 --jobs-dir .local/harbor/jobs
```

这会调用真实模型并产生费用，不进入默认测试。每次仅运行一个 trial；每题一次，Harbor 不自动重跑。任务的 Harbor 超时与 CodeAtelier 超时同时生效，先达到者停止。子集、调整后的超时、工具和权限限制必须披露，不能冒充官方完整榜单成绩。

## 参数、预算与权限

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| bundle_path | .local/harbor/codeatelier.tar.gz | 预先构建的运行包 |
| workspace | 容器 pwd -P | 可显式指定绝对容器路径 |
| max_total_tokens | 500000 | 累计实报输入 + 输出阈值 |
| max_model_calls | 60 | 包括摘要和重试 |
| max_steps | 30 | 生产引擎任务轮次 |
| timeout_ms | 600000 | CodeAtelier 任务超时 |
| allow_workspace_commands | false | 显式预授权工作区 cwd 的容器命令 |

累计 token 是请求间阈值，不是硬费用上限。一次请求可能跨过阈值；已返回响应和工具批次继续按生产流程处理，下一次模型请求前停止。失败请求、缺失或无效 usage 记为未知，禁止后续模型请求；评测模式因此可能比产品模式更早停止重试。最终回复缺少 usage 仍可完成，但计量标为不完整。

默认拒绝所有审批，避免无人处理。启用预授权后只自动批准 run_command 且解析后的 cwd 位于工作区；文件越界、敏感访问和整文件覆盖仍拒绝，生产 Git/提权限制保留。**cwd 检查不限制命令实际访问范围**：命令和脚本可产生容器用户权限内的副作用。Linux `/.dockerenv` 检查只是防止误在宿主运行，不是安全认证。不要挂载个人目录、Docker socket 或额外凭据。实际隔离由 Harbor/Docker 配置负责，不是产品新增沙箱。

## 产物与判定

每个 trial 的 agent 日志目录包括：

- codeatelier-build.json：运行包 SHA-256 和 Harbor 版本。
- codeatelier/report.json：模型、平台、时间、任务终态、停止原因、预算、审批数。
- codeatelier/usage.json：每次模型调用前后原子更新的累计实报用量。
- codeatelier/events.json：正常结束时导出的生产事件、diff 和工具结果。
- codeatelier/data/history.sqlite：完整原生会话历史。
- codeatelier/data/logs/app.log：生产脱敏诊断日志。

完整 usage 回填 Harbor 的 n_input_tokens（含缓存）、n_output_tokens、n_cache_tokens。缓存字段缺失时缓存未知；有未计量调用时总量不回填，已知部分放在 metadata，不能当成完整账单。cost_usd 保持空，不猜费率。强杀可能缺少最终 report/events，不能把缺失记为零消耗或成功。

`task.status=completed` 仅表示 agent 正常结束，正确性由 Harbor 的 `verifier_result.rewards` 决定。历史和任务说明含被测代码，不提交或公开 trial 产物。

## 不调用真实模型的验证

```sh
pnpm eval:test
.local/harbor-linux-venv/bin/python -m unittest scripts.harbor.test_adapter -v
.local/harbor-linux-venv/bin/python scripts/harbor/run.py agent schema scripts.harbor.codeatelier:CodeAtelierAgent

# 输出目录必须不存在；重跑可指定新的 --output。
.local/harbor-linux-venv/bin/python scripts/harbor/prepare_contract.py
CODEATELIER_API_KEY=contract-only \
CODEATELIER_BASE_URL=http://127.0.0.1:18765/v1 \
.local/harbor-linux-venv/bin/python scripts/harbor/run.py run \
  -p .local/harbor/contract-add \
  -a scripts.harbor.codeatelier:CodeAtelierAgent -m contract-model \
  --ak allow_workspace_commands=true --ak timeout_ms=150000 \
  -n 1 -k 1 --max-retries 0 --jobs-dir .local/harbor/jobs
```

模拟服务只监听任务容器内回环地址，固定返回读取、修改、测试、最终回复。此流程验证真实 SDK/SSE、引擎、文件、命令、SQLite、Harbor 适配和独立评分，不证明模型编码能力。预期模拟用量：4 次调用，400 输入、80 输出 token；这是测试数据，不是计费消耗。

Python 风格检查：`uv tool run --from ruff==0.15.6 ruff check scripts/harbor` 和 `uv tool run --from ruff==0.15.6 ruff format --check scripts/harbor`。

官方接口：[Agents](https://www.harborframework.com/docs/agents)、[Task format](https://www.harborframework.com/docs/tasks)。兼容性以固定发行包与契约测试为准。

本项目的 run.py 默认关闭 Harbor telemetry（HARBOR_TELEMETRY=0）；显式设置该变量时尊重调用者配置。

## 单独运行无界面入口

准备好可信项目、任务文本和模型环境变量后，也可直接使用开发入口；以下路径是示例：

```sh
pnpm eval --workspace /absolute/project \
  --output /absolute/eval-runs/trial-1 \
  --prompt-file /absolute/task.txt \
  --max-total-tokens 100000 --max-model-calls 12 --timeout-ms 150000
```

工作区与输出目录不能相互包含，输出目录不能复用已有 trial 数据。默认拒绝审批；普通宿主机不能启用 `--allow-workspace-commands`。SIGINT/SIGTERM 会取消并保存报告。退出码 0 表示 agent 正常结束，独立 verifier 仍需另外运行。
