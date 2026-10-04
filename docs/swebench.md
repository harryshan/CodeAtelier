# SWE-bench Verified 固定子集

只在用户明确要求时运行。没有 CI、定时任务、提交/启动钩子；默认 pnpm test/check 不执行 Evaluation。生产 UI 及核心引擎继续使用 TypeScript。

## 数据与范围

`evals/swebench/subset.json` 固定 Verified 的数据集 commit 和 20 个 instance_id。以仓库名称排序轮询，每个仓库内部按 SHA256(`codeatelier-v1:` + instance_id) 排序，不根据模型得分挑选。清单是开发基线，不是官方完整成绩，不代表全部语言。运行时从固定修订读取并校验题目存在。

## 准备（Linux/WSL x86_64）

```sh
pnpm eval:build
python3 -m venv .local/swebench-venv
.local/swebench-venv/bin/pip install -r scripts/swebench/requirements.txt
.local/swebench-venv/bin/python scripts/swebench/prepare.py
docker info
```

需要 Docker、Python >=3.10、网络和足够磁盘。仅支持已提供官方任务镜像的 glibc Linux x86_64；macOS/ARM 未验证。评分器固定 swebench 4.1.0，数据固定 commit；官方容器标签为 latest，记录实际 image ID 供追踪，不能声称容器完全不可变。

打包只包含 dist/server 的 JS、package.json、pnpm-lock.yaml，不含密钥、源码映射、历史、测试和 node_modules。容器安装独立 Node 24.19.0、pnpm 11.22.0 和生产依赖，禁用依赖安装脚本。

## 手动生成补丁

以下环境变量使用示例值；不把真实 key 放进脚本、Git 或命令参数。入口不会读取 .env。

```sh
export CODEATELIER_API_KEY='YOUR_API_KEY'
export CODEATELIER_BASE_URL='https://api.example.com/v1'
export CODEATELIER_MODEL='YOUR_MODEL_ID'
.local/swebench-venv/bin/python scripts/swebench/predict.py \
  --output .local/swebench/runs/verified-20-v1-run1
```

每题一次、串行，不自动重试；输出目录必须全新。通常默认每题 500000 token、60 次模型调用（含摘要）、30 步、600000ms，可用 --max-total-tokens、--max-model-calls、--max-steps、--timeout-ms 调整。2026-10-04 用户要求复跑时移除这些评测专加的预算，可显式传 `--unlimited`：不检查累计 token、模型调用数、Agent 步数或任务总时长；缺失 usage 仍记为未知，不因此中断；预测容器也不再附加 4 GB/2 CPU 上限。无上限模式使用 Docker 分离 exec 轮询退出码，避免 Docker HTTP 读取超时伪装成任务超时。仍保留生产 Agent 的单请求、单命令与上下文容量机制，以及取消、目录检查、审批和产物记录；这些是产品行为或安全边界，不代表 SWE-bench 的官方限制。官方评分测试仍采用官方 1800 秒默认超时。

```sh
.local/swebench-venv/bin/python scripts/swebench/predict.py \
  --output .local/swebench/runs/verified-20-unlimited-run1 \
  --unlimited
```

Ctrl+C/SIGTERM 停止并清理当前容器，已写出的结果保留；强杀无法保证清理，可通过 Docker label `codeatelier.evaluation=swebench` 定位本工具容器。

每个任务只向 agent 提供 problem_statement 和初始仓库，不上传参考 patch、test_patch、hints 或评分标准。验证镜像 HEAD 等于 base_commit；在 /testbed 运行生产引擎，提取包含新增非忽略文件的 git diff。输出 predictions.jsonl 使用官方 instance_id/model_name_or_path/model_patch 格式。

agent 非零退出仍保存可提取补丁和失败状态，环境初始化错误单独记录；缺失输出不代表成功。

## 手动独立评分

```sh
.local/swebench-venv/bin/python scripts/swebench/grade.py \
  --run .local/swebench/runs/verified-20-v1-run1
```

必须具备清单全部题目的预测记录。评分器在新的 grading 目录中加载固定数据并调用官方 `swebench.harness.run_evaluation`，在干净容器应用预测和隐藏测试，按 FAIL_TO_PASS/PASS_TO_PASS 判定解决情况。参考数据只留在宿主评分目录。禁止复用已有 grading，避免官方缓存把旧补丁结果当作新结果。官方 JSON 总结及日志位于 grading 下；不要将未评分任务记为失败后冒充完整得分。

## 产物与边界

每次运行保存 subset.json、run.json（运行包 SHA256、模型和预算）、predictions.jsonl；每题 trial.json（环境镜像 ID、执行状态）及 output 下的 report.json、usage.json、events.json、SQLite 和诊断日志。task.status=completed 只表示 agent 结束，官方 resolved 才表示测试判定解决。

有限模式的累计 token 是请求间软阈值，一次响应可能超出；失败请求或缺失 usage 属于未知消耗，不能按零计费。无上限模式继续执行并记录未知用量，因此总 token 只在全部请求 usage 完整时填写。不估计美元费用。

容器中仅自动批准生产 `run_command` 生成的 `{ command, cwd }` 审批描述，`cwd` 必须是工作区内的绝对路径；其他审批仍拒绝，保留产品 Git/提权规则。cwd 检查无法限制命令副作用；Docker 是开发评测隔离，不是产品新增的安全沙箱。容器不挂载宿主仓库、个人目录或 Docker socket，模型 key 只传给执行进程，但同权限容器代码仍可能读取它。测试数据和会话不提交 Git。

## 手动回归与当前验证

```sh
pnpm eval:test
.local/swebench-venv/bin/python -m unittest discover -s scripts/swebench -p 'test_*.py'
```

2026-10-04 按用户要求完成固定 20 题的有限预算运行（14/20）及显式 `--unlimited` 复跑（15/20）。逐题结果、两轮差异、参考补丁对照及验证限制见 [验证记录](verification.md) 和本机 `.local/swebench/runs/verified20-unlimited-20261004-181603/analysis.md`；旧轮报告为 `.local/swebench/runs/verified20-20261004-030302/analysis.md`。两轮均仅由用户手动要求触发，不加入默认检查或自动化。

官方参考：[数据](https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified)、[评分格式](https://www.swebench.com/SWE-bench/guides/evaluation/)、[固定评分器源码](https://github.com/SWE-bench/SWE-bench/tree/v4.1.0)。

## 最终综合报告

手动生成补丁或评分结束（包括异常退出）时，更新运行目录的 `report.json` 与 `report.md`。仅汇总已有产物，不触发新的任务、网络或评分。也可手动重建：

```sh
.local/swebench-venv/bin/python scripts/swebench/report.py --run .local/swebench/runs/verified-20-v1-run1
```

| 维度 | 报告指标 | 含义与限制 |
| --- | --- | --- |
| 正确性 | 官方 resolved、完整子集/已评分解决率、仓库分组结果 | completed 不代表 resolved；未评分单列，不算失败 |
| 修复与回归 | FAIL_TO_PASS 成功/失败/通过率、PASS_TO_PASS 成功/失败/保持率、补丁应用状态 | 使用官方报告；隐藏测试通过不证明所有潜在行为正确 |
| 时间 | 环境准备、任务总墙钟、agent 执行、评分耗时；样本数/总和/平均/中位数/P95 | 容器准备和模型能力分开；任务墙钟含清理，不等于整批运行墙钟 |
| 模型效率 | 输入/输出/总 token、缓存输入及比例、调用数、失败调用、请求耗时、首次文本增量延迟 | 首次文本增量不是 provider TTFT；纯工具响应无文本则记 null |
| 资源效率 | 每题 token 分布、成功题 token 分布、整套已知消耗/解决题数、预算使用比例 | 最后一个比率计入失败题消耗；token 是请求间软预算 |
| 工具与验证过程 | 工具次数/分类/耗时/错误率、缺失结果、截断、重复只读参数、测试命令次数及退出状态、不可解析的命令参数数 | 测试命令识别为启发式；脱敏后的命令参数不猜测内容；相同读取可能必要；退出 0 不证明有测试覆盖 |
| 上下文与稳定性 | 主任务/摘要 token、可观测任务轮数、压缩成功/失败、重试通知、停止原因分布 | 重试通知不等于成功发出重试；日志轮转可能丢失旧计数 |
| 修改规模 | 补丁是否为空、文件数、新增/删除行数、二进制文件数、字节数 | 小补丁不等于高质量，不以代码量打分 |
| 权限与可观测性 | 批准/拒绝数、产物完整性、usage 完整任务数及未知请求 | 不据此声称安全性；未知用量不能按零收费 |

JSON 包含逐题详细指标及运行配置、子集修订和分组汇总；Markdown 提供概览和完整明细。无样本/缺失数据为 null，分布带 samples；已知 token 小计另列，整套 totalTokens 只在全部任务用量完整时填写。

本轮每题一次，不能估计多次运行稳定性或 pass@k；没有价格数据不猜美元费用，没有覆盖率仪器不声称代码覆盖率，不生成混合维度的能力总分。比较版本时固定题目、模型、预算和环境。

## 大陆网络与准备镜像

2026-09-12 实测：毫秒镜像 `docker.1ms.run` 下载前三题成功，逐一与官方 Registry 摘要核对；GHProxy/jsDelivr 可获取固定提交文件；npm 使用 registry.npmmirror.com，Python 使用阿里云 PyPI 镜像，公开数据使用 hf-mirror.com 并核验官方 SHA256。服务可用性会变化，不修改全局 Docker/pip/Git 配置，不向加速服务发送模型密钥。

当前机器的准备记录在 `.local/swebench/prepared-environments.json`，离线运行包在 `.local/swebench/codeatelier-runtime.tar.gz`。官方镜像额外创建了构建提交，准备镜像在独立容器内 `git reset --hard base_commit` 后保存，官方原镜像保持不变。三题均已检查 HEAD、Python、Node、pnpm 和运行依赖导入，未执行 agent 或测试。

手动预测可显式传 `--prepared-environments .local/swebench/prepared-environments.json`。清单要求 instance_id、preparedImage、preparedImageId、baseImageId、bundleSha256；所选题目必须全部覆盖，运行包摘要必须一致，本地镜像 ID 必须匹配。该路径跳过远程规格查询、镜像拉取及安装，但仍检查仓库 HEAD；未指定时保留标准流程。

运行报告记录清单摘要及实际镜像 ID，旧运行包不可冒充新版本。

当前三题的本机手动入口：WSL 内运行 `.local/swebench-venv/bin/python .local/swebench/run-three.py predict` 或 `grade`。它显式使用哈希核验的数据副本、准备镜像、固定 URL 配置缓存；此本地入口不提交 Git，不自动执行。公开配置缓存仅影响该命令及其评分子进程，不更改系统代理。修改生产代码后须重建运行包和准备镜像。

## 一键刷新并运行前三题（当前 Windows/WSL 机器）

在 PowerShell 手动执行：

```powershell
cd G:\codeagent
powershell -ExecutionPolicy Bypass -File scripts/swebench/run-three.ps1
```

仅编译、打包和刷新镜像，不调用模型或评分：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/swebench/run-three.ps1 -PrepareOnly
```

默认 WSL 发行版为 Ubuntu-26.04，可传 `-Distribution` 指定。需要该发行版的 Docker 服务已启动、现有 `.local/swebench-venv`、已核验的 `.local/swebench-verified.parquet`、初始 `prepared-environments.json` 和其中的本地镜像。

运行评测还需要 `.local/swebench/cn-python/sitecustomize.py` 及 `network-cache`（先前大陆环境准备产物），以及环境变量或仓库 `.env` 中的 CODEATELIER_API_KEY。此脚本刷新当前机器已准备的环境，不负责首次安装 WSL、Docker 或下载题目镜像。

脚本依次编译后端、打包当前 JS/依赖清单、选取固定 20 题清单的前三题，再基于原准备镜像清除容器内旧应用目录、解包新代码，使用 npm 大陆镜像和冻结 lockfile 安装生产依赖。逐文件 SHA256 和 runner 导入验证成功后才提交新镜像。沿用已有 Node/pnpm 和题目环境，不读取旧 codeatelier-runtime.tar.gz。

每次准备保存到 `.local/swebench/preparations/时间戳-随机标识/`；全部镜像完成后才写入本次准备清单。不会覆盖初始镜像清单或旧报告。随后调用现有 predict.py 和 grade.py，输出到 `.local/swebench/runs/first-three-时间戳-随机标识/report.md`。失败停止后续阶段，保留已有产物；Ctrl+C 取消，刷新中的临时容器会清理，已提交的缓存镜像保留。

本地 Parquet 通过 CODEATELIER_SWEBENCH_PARQUET 显式传入，预测和评分均校验固定 SHA256，校验失败不回退到其他数据。Python 原始入口也可使用该变量；未设置时沿用固定修订的在线加载方式。

这个入口只在手动执行时运行，不接入服务启动、CI、钩子或默认 test/check。实现阶段仅静态检查，未运行真实刷新或评测；手动回归 test_refresh.py 亦保留独立入口。
