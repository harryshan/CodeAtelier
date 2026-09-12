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
export CODEATELIER_BASE_URL='http://jp.harryshan.com:4141/v1'
export CODEATELIER_MODEL='codex/gpt-5.6-luna'
.local/swebench-venv/bin/python scripts/swebench/predict.py \
  --output .local/swebench/runs/verified-20-v1-run1
```

每题一次、串行，不自动重试；输出目录必须全新。默认每题 500000 token、60 次模型调用（含摘要）、30 步、600000ms，可用 --max-total-tokens、--max-model-calls、--max-steps、--timeout-ms 调整。安装最多 600 秒，官方独立评分每题最多 1800 秒。Ctrl+C/SIGTERM 停止并清理当前容器，已写出的结果保留；强杀无法保证清理，可通过 Docker label `codeatelier.evaluation=swebench` 定位本工具容器。

每个任务只向 agent 提供 problem_statement 和初始仓库，不上传参考 patch、test_patch、hints 或评分标准。验证镜像 HEAD 等于 base_commit；在 /testbed 运行生产引擎，提取包含新增非忽略文件的 git diff。输出 predictions.jsonl 使用官方 instance_id/model_name_or_path/model_patch 格式。agent 非零退出仍保存可提取补丁和失败状态，环境初始化错误单独记录；缺失输出不代表成功。

## 手动独立评分

```sh
.local/swebench-venv/bin/python scripts/swebench/grade.py \
  --run .local/swebench/runs/verified-20-v1-run1
```

必须具备清单全部题目的预测记录。评分器在新的 grading 目录中加载固定数据并调用官方 `swebench.harness.run_evaluation`，在干净容器应用预测和隐藏测试，按 FAIL_TO_PASS/PASS_TO_PASS 判定解决情况。参考数据只留在宿主评分目录。禁止复用已有 grading，避免官方缓存把旧补丁结果当作新结果。官方 JSON 总结及日志位于 grading 下；不要将未评分任务记为失败后冒充完整得分。

## 产物与边界

每次运行保存 subset.json、run.json（运行包 SHA256、模型和预算）、predictions.jsonl；每题 trial.json（环境镜像 ID、执行状态）及 output 下的 report.json、usage.json、events.json、SQLite 和诊断日志。task.status=completed 只表示 agent 结束，官方 resolved 才表示测试判定解决。

累计 token 是请求间软阈值，一次响应可能超出；失败请求或缺失 usage 属于未知消耗，后续请求停止，不能按零计费。不估计美元费用。

容器中显式批准工作区 cwd 的 run_command，其他审批仍拒绝，保留产品 Git/提权规则。cwd 检查无法限制命令副作用；Docker 是开发评测隔离，不是产品新增的安全沙箱。容器不挂载宿主仓库、个人目录或 Docker socket，模型 key 只传给执行进程，但同权限容器代码仍可能读取它。测试数据和会话不提交 Git。

## 手动回归与当前验证

```sh
pnpm eval:test
.local/swebench-venv/bin/python -m unittest discover -s scripts/swebench -p 'test_*.py'
```

本次替换不执行这些测试、不启动模型或任务容器；只做静态检查。新链路尚未做端到端验收，不能把旧链路的通过记录当成当前结果。

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
| 工具与验证过程 | 工具次数/分类/耗时/错误率、缺失结果、截断、重复只读参数、测试命令次数及退出状态 | 测试命令识别为启发式；相同读取可能必要；退出 0 不证明有测试覆盖 |
| 上下文与稳定性 | 主任务/摘要 token、可观测任务轮数、压缩成功/失败、重试通知、停止原因分布 | 重试通知不等于成功发出重试；日志轮转可能丢失旧计数 |
| 修改规模 | 补丁是否为空、文件数、新增/删除行数、二进制文件数、字节数 | 小补丁不等于高质量，不以代码量打分 |
| 权限与可观测性 | 批准/拒绝数、产物完整性、usage 完整任务数及未知请求 | 不据此声称安全性；未知用量不能按零收费 |

JSON 包含逐题详细指标及运行配置、子集修订和分组汇总；Markdown 提供概览和完整明细。无样本/缺失数据为 null，分布带 samples；已知 token 小计另列，整套 totalTokens 只在全部任务用量完整时填写。

本轮每题一次，不能估计多次运行稳定性或 pass@k；没有价格数据不猜美元费用，没有覆盖率仪器不声称代码覆盖率，不生成混合维度的能力总分。比较版本时固定题目、模型、预算和环境。
