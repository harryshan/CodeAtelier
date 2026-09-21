# 初版验证记录

日期：2026-09-07；后续条目按各自日期补充。以下区分实际验证和计划覆盖，不将构建成功等同于跨平台运行成功。**Windows 专用用户 Runtime 的产品代码、受保护 bundle、安装器、ACL/Job、持久 WFP、journal、CONNECT relay、默认 Supervisor launcher 和联合身份 Named Pipe 已接入，但尚未完成固定账户提升环境端到端验收。AgentRuntimeService 与模型/session/审批 adapter 已在独立 Node 子进程 harness 通过；结构化 PushSpec、独立 Push Runner 和 Agent Runtime 阻塞等待链已接入应用代码，但真实安装下的错误 pipe 客户端、取消/恢复及 remote push 矩阵仍未验证。WSL2 与 restricted-token demo 仍只是历史或局部证据。代码存在、stdio 跨进程测试、单测或 native build 通过都不能扩展成 W0--W6 完成或跨平台 Sandbox 能力。**

## 本机实际验证

- Windows，Node.js 24.19.0，pnpm 11.22.0。
- 类型检查、ESLint、生产前后端构建通过。最新本机回归为 82 项通过、1 项 POSIX 文件模式测试在 Windows 跳过；8 项 Chromium UI 验收通过。
- 核心测试覆盖文件读取前置条件、外部并发修改、精确替换、外部访问拒绝、junction 越界、取消审批、命令超时、输出限制及非零退出码、SQLite 重启恢复、单任务锁、工具回传、本机请求校验、密钥不写设置与日志脱敏。
- Responses 协议回归覆盖 item.done 收集、缺少完成事件、failed/incomplete/error。
- Chromium 浏览器验收通过：会话创建、真实文件写入、diff、刷新后历史、审批刷新/拒绝/取消、设置保存不返回密钥。
- 已人工查看欢迎页截图，布局无明显遮挡或溢出。

## 真实自建服务

服务：当时本地配置的 Responses 服务，具体地址和模型标识不保留在文档中。

1. 模型简称返回 400、不支持此端点。
2. /v1/models 公布完整模型标识；后续使用该标识。
3. 官方 SDK 流式请求、function_call、function_call_output 回传和最终文本 CODEATELIER_OK 均验证通过。
4. 观察到 completed.output 可为空，完整调用项出现在 output_item.done；适配器已覆盖该行为。
5. 真实 agent 在独立示例中将 add(a,b) 的 a-b 修复为 a+b，添加负数相加测试，运行 node --test，退出码为 0，任务状态 completed。未对用户项目执行试验性修改。

## GitHub CI

- 初版提交 cfac6fe 的 Windows、Linux、macOS 核心检查及 Linux Chromium UI 验收全部通过。
- [已完成的跨平台运行](https://github.com/harryshan/CodeAtelier/actions/runs/34068860495)。后续新增回归以对应提交的 CI 结果为准。

## 当前限制

- CI 已验证托管 Windows/Linux/macOS 环境中的核心逻辑与构建，以及 Linux Chromium UI；真实模型端到端任务目前只在本机 Windows 验证。
- Firefox、真实 Safari、更多 CPU 架构尚未实测。
- 应用层审批不是系统沙箱；获准命令可产生当前用户权限下的副作用。
- 不同真实工作目录会话默认最多两任务并行（设置可调 1～4），同工作目录始终排队串行；上下文按字符预算；输出受限；不含删除工具、无人值守崩溃执行恢复、自动 worktree 或完整 IDE。单一 Git 工具允许受限 action 自动执行；模拟执行器回归覆盖其 worktree、路径、revision 和 upstream 校验，但尚未在真实 Git 仓库或远程服务完成手动集成验证。
- UI 密钥只驻留内存；需重启持久化时可使用不受版本控制的本地环境配置。

## 恢复机制增量验证（2026-09-07）

- 新增 8 项故障注入/恢复测试：重试预算及 HTTP 分类、退避取消、真实 HTTP SSE 缺失完成事件、请求与空闲超时、文件编辑后的人工恢复、SQLite 重启后已知/未知结果修补、等待审批时关闭与取消、工具完成后模型自动重试不重复编辑。
- Chromium 验收增加取消后刷新并恢复、部分回复与成功回复隔离、SSE 401 后重连且不提交任务。
- pnpm check 和 pnpm test:e2e 在本机 Windows 通过。本次错误注入使用本机模拟服务，未对用户自建服务制造故障；跨平台结果以本次提交 CI 为准。

## 功能测试补齐（2026-09-07）

- 新增 54 项单元/集成回归测试，以及 1 项浏览器历史续聊/隔离验收。功能对应关系见 testing.md。
- 先由新增测试复现搜索返回 101 条、反向行号范围成功返回空值、结构化 token/password 未脱敏，再修复并验证。
- Windows 本机 pnpm check 通过（79 通过、1 项 POSIX 模式跳过），pnpm test:e2e 为 6 项通过。POSIX CI 跳过 Windows ADS 用例，执行 POSIX 文件模式用例；本次跨平台结果以对应提交 CI 为准。

## 服务关闭增量验证（2026-09-07）

- 新增 3 项核心测试：未授权/伪造/未确认关闭被拒绝；运行中命令被终止、中断保存、SSE 结束与端口释放；实际 main 入口收到关闭请求后退出码为 0。
- 新增 2 项 Chromium 验收：关闭前确认/取消、成功页面和重新启动说明；关闭请求失败不冒充成功，界面仍可操作。UI 用例模拟关闭响应，真实退出由核心进程与网络测试验证。
- Windows 本机 pnpm check 为 82 通过、1 项平台跳过；pnpm test:e2e 为 8 项通过。跨平台结果以对应提交 CI 为准。

## 可读性整理验证（2026-09-08）

- 整理源码、测试、脚本和工具配置的段落与控制流，补充关键约束注释；拆分上下文恢复、指令构建与数据库 schema。未新增产品行为。
- 新增 pnpm format:check 并纳入 pnpm check；ESLint 同时约束花括号、独立变量声明和基础段落。
- 类型、lint、格式检查、82 项核心回归（1 项平台跳过）、生产构建及 8 项 Chromium 验收通过。另与整理前版本比较最终指令文本和 SQLite 字段、外键与索引，结果一致。
- 本轮复用既有行为测试，不为纯排版增加重复用例。跨平台结果以对应提交 CI 为准。

## 模块职责整理验证（2026-09-08）

- 审查 src、tests、scripts 与工具配置，拆分工具执行器、配置持久化、模型接口/错误/重试、日志脱敏、HTTP 防护与 SSE、浏览器会话连接。更新全部直接引用，无兼容转发文件。
- Windows 本机 pnpm check 通过：类型、lint、格式、82 项核心回归（1 项平台跳过）及生产构建。既有测试覆盖权限、模型失败与恢复、持久化和服务退出等移动后的行为。
- 最新生产构建的 8 项 Chromium 验收全部通过；跨平台 CI 以本次提交结果为准。本轮不改变产品功能。

## 自举验收准备（2026-09-08）

新增真实源码副本验收入口，覆盖配置缺陷修复、补测试、文档更新和引擎/存储重建后的恢复。已在 Windows 运行 prepare-only 并复现原有测试失败；新增 6 项精确命令审批回归通过。自动审批阻止向模型服务发送私有源码，真实模型尚未运行，不宣称自举成功。细节见 bootstrap.md。

本轮 pnpm check 完整通过：88 项测试通过、1 项平台跳过，类型、lint、格式与生产构建通过。尚未运行真实模型或新增浏览器验收。

## 真实自举验收与脱敏修复（2026-09-08）

用户明确授权后，使用自建 Responses 转发服务与 当时配置的模型 在 Windows 完成一个真实源码任务。

- 验收副本基于 4b97181；引擎使用本次未提交时的 JSON 脱敏修复。不是旧提交本身即可通过的证据。
- 首次运行 bootstrap-QfUPHq 在读取 tests/config.test.ts 时失败：直接替换序列化 JSON 的脱敏正则破坏了转义。先增加引擎与日志两项失败用例，再改为解析结构、脱敏字段值、重新序列化。已知密钥包含引号或反斜杠时同样正确处理。
- 第二次运行 bootstrap-drisvF 成功，产生 80 条历史事件、18 次工具调用、2 次精确命令审批。没有额外文件改动。
- 在配置修复完成后主动取消；重建 Engine 与 Store 后恢复。模型重新读取三个目标文件，没有重复执行配置修复，然后补测试并更新文档。

| 独立检查             | 结果                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| 注入更新路径缺陷     | 原有 10 项测试：9 通过、1 失败，准确复现                             |
| 模型修复及新增测试   | 11 项全部通过                                                        |
| 恢复原始测试独立复验 | 10 项全部通过                                                        |
| 临时注入构造路径缺陷 | 11 项中仅新增测试失败，确认新增断言有效                              |
| 源码与测试格式       | Prettier 通过                                                        |
| 人工审核             | 配置恢复正确；原有测试保留；新增环境变量用例有清理；文档对应实际行为 |

配置修复使文件恢复到原始 HEAD，因此最终对 HEAD 的差异仅含测试和文档；历史 diff 中保留了实际修复。副本及完整会话留在 .local，不自动合并模型生成的修改、不提交凭据或历史。此结论仅覆盖有明确故障领域与固定测试命令的小任务，不能代表复杂自主开发或全平台自举；不是进程崩溃或 Web UI 真实模型验收。

本轮产品修复检查：pnpm check 通过，90 项核心测试通过、1 项平台跳过；8 项 Chromium 验收通过。跨平台以对应提交 CI 为准。

## 2026-09-08：会话内上下文压缩

- 实现字符预算统计（含工具定义）、80% 触发/60% 目标、结构化摘要、完整工具批次切分、用户原文保留、原子快照、分页历史工具与一次服务端容量错误恢复。
- pnpm check 通过：16 个测试文件，106 项通过、1 项平台相关跳过；类型、ESLint、Prettier 和生产构建通过。新增 context.test.ts 共 16 项。
- pnpm test:e2e 通过：Windows Chromium 9 项，包含压缩提示、续聊完成和刷新后原历史保留。
- 回归先复现调用 ID 重用导致旧结果误记，修复后验证匹配歧义保留未知状态。其他测试覆盖失败回滚、取消、重启、原文分页隔离和重试 attempt 分离。
- 文档相对链接及 git diff --check 通过。没有调用真实模型验证摘要语义质量，也未在 macOS/Linux 实测本次变更；没有精确 token 计量、长期磁盘增长或断电损坏保证。

## 2026-09-09：服务容量与 token 用量

- 真实 /v1/models 返回 当时配置的模型 的窗口 372000、最大输入 372000、最大输出 128000、tokenizer=o200k_base。
- /v1/responses/input_tokens 返回 404；不接入不存在的计数接口。新 ResponsesProvider 带 max_output_tokens=16384 完成最小流式请求，usage 输入 10、输出 5、合计 15；本地同请求估算 21，界面明确区分。
- token 模式扣除输出预留和 5% 安全余量，默认输入预算 337016；元数据不可用时退回字符模式。任务和摘要用量分别保存；实报输入高于估算时上调本任务估算。
- pnpm check 通过：17 个测试文件，114 项通过、1 项平台相关跳过；类型、lint、格式、生产构建通过。pnpm test:e2e 在 Windows Chromium 10 项全部通过。
- 未做填满窗口的极限测试、真实摘要语义评估或其他平台实测。372000 是服务公开容量，不冒充极限负载验证结果。

## 2026-09-12：渐进上下文压缩

- 新增读取去重、文件归档、完整分块摘要三级流程；每级达标即停止。前两级仅处理可核对的成功文件读取，完整工具协议、用户原文与历史快照保留。
- 回归先复现长记录中间内容未送入摘要的问题；新增 5 项测试覆盖全文分块、零调用去重、版本隔离、归档后全文还原、已有摘要保留和计数工作量约束。摘要前还原投影也用于核对执行账本。
- 首次浏览器长上下文验收发现重复 tokenizer 计算导致等待超时；改为减半寻找可容纳分块，并跳过未改变阶段的计数。保留原来的浏览器断言与等待时间，复验通过。
- 工作区最终 pnpm check 被并发新增、与本次无关的 evaluation 文件格式错误阻断。保留并发文件，在 .local 隔离副本执行本次交付的全部 check 检查项：类型、ESLint、Prettier、18 个测试文件（119 通过、1 项平台跳过）和生产构建均通过。
- 工作区 pnpm test:e2e：Windows Chromium 10 项全部通过，包含整理提示、续聊和刷新历史。
- 未调用真实模型评测摘要语义质量，未进行其他操作系统实测。文件摘录仍有损，旧摘要累积仍可触顶；不承诺无限上下文或自动识别所有重要代码。

## 2026-09-12：每请求无损机械整理

以下记录保留当时的验证结果；该机制于 2026-09-18 按 D027 移除，当前行为见 context-management.md。

- 在每次主任务请求和重试前精确引用重复只读结果与相同文件正文，保留完整来源和不同路径/元数据；请求视图不写入原始历史。预算触发和实际 usage 校准统一使用请求视图。
- 新增 5 项普通功能回归：逐字还原、幂等、版本/失败/截断/歧义保护、小内容与 token 增长回退、低阈值重试及新工具轮次每次整理、请求视图和历史不变。旧去重测试相应验证无需创建快照即可降低输入。
- pnpm check 通过：19 个测试文件，124 项通过、1 项平台跳过；类型、ESLint、Prettier、生产构建均通过。pnpm test:e2e：Windows Chromium 10 项通过。
- 未运行 Evaluation 或真实模型请求。无损指可精确还原内容，不保证模型理解引用与展开全文具有相同表现；当前仅识别明确的只读结果与正文重复，不删除源码空白、用户要求或近似内容。

## 2026-09-12：SWE-bench 固定子集替换

- 移除原评测框架适配、任务、依赖、文档及本地专用环境/缓存/容器；保留通用 TypeScript 生产引擎评测入口。
- 新增 Verified 固定 20 题清单，覆盖 12 个仓库；固定数据修订，Parquet 文件 SHA256 与官方 LFS 元数据一致。模型不接收 gold/test patch 或 hints。
- 新增直接 Docker 补丁生成、官方 swebench 4.1.0 独立评分入口、手动契约回归和使用文档。输出目录不复用，取消清理当前容器，环境错误和 agent 失败分别记录。
- 静态验证：Python Ruff 格式/lint 通过；pnpm check 通过（19 文件、124 项普通测试通过、1 项平台跳过，类型/lint/格式/构建通过）。
- 未启动 Evaluation、Python 评测契约测试、任务容器或真实模型调用。新 SWE-bench 全流程仍待用户手动验收；默认检查不包含评测。

## 2026-09-12：评测综合报告

- 新增离线 report.py，生成 report.json/report.md，逐题与汇总展示官方解决/回归结果、时间/token 分布、调用/工具/验证过程、压缩/重试、补丁规模、权限与产物完整性。
- 模型计量增加每次请求耗时、首次文本增量延迟和失败标记；任务侧记录准备/墙钟时间，评分侧记录耗时。缺失数据为未知；无实测价格、覆盖率或重复试验时不编造相关结论。
- 已添加 5 项手动报告回归用例，按用户约定未执行 Evaluation 或报告回归。默认 pnpm check 通过：124 项普通测试通过、1 项平台跳过，类型/lint/格式/构建通过；Python Ruff 与语法检查通过。
- 新报告尚未用完整真实评测产物验收；官方字段与固定 v4.1.0 源码核对，静态检查不代表端到端成功。

## 2026-09-12：大陆环境准备

- 三题官方 Docker 镜像通过大陆加速下载成功，摘要与官方 Registry 一致。独立准备镜像恢复到 base_commit，保留原始官方镜像。
- 三题 Python、Node 24.19.0、pnpm 11.22.0 及完整评测 runner 依赖导入验证成功。npm 镜像安装使用冻结 lockfile 和禁用安装脚本；公开配置缓存保存在本地。
- 预测入口新增显式准备镜像清单，核对运行包摘要与镜像 ID，避免重新跨境下载。增加手动契约回归用例，本次未执行该用例、任务测试或模型调用。
- 已在阻断网络请求的条件下确认三题官方 task spec 可完整从本地缓存生成；准备容器已清理。普通 pnpm check 通过（124 项通过、1 项平台跳过），Python Ruff 通过；未运行 Evaluation。

## 2026-09-12：用户授权前三题真实评测

- 固定前三题各运行一次，使用 当时配置的模型，完成补丁生成和官方评分：0/3 resolved；三题均正常结束并成功应用补丁，官方评分执行错误为 0。
- Astropy 目标测试 0/1，原有测试 9/9；Django 目标测试 1/1，原有测试 41/43，两项大批量删除的查询次数断言失败；Matplotlib 目标测试 0/2，原有测试 32/32。以上计数仅指官方指定测试集。
- 实报 token 总量 910,265（含缓存输入 754,688），模型调用 49 次；Agent 执行累计 312.968 秒，官方评分约 130.006 秒。三题样本不足以推断整体 SWE-bench 能力。
- 真实产物触发报告器对数组工具结果调用 get 的缺陷；先以回归复现，再兼容数组/文本结果。仅重新生成报告和完成官方评分，没有重跑模型。手动报告回归 6 项通过，pnpm check 通过（124 项通过、1 项平台跳过），Python Ruff 通过。
- 本地产物位于 .local/swebench/runs/first-three-cn-20260912/report.md 和 report.json；含任务内容的日志和产物不提交。评测仍只通过明确的手动请求运行。

## 2026-09-12：手动一键刷新三题入口

- 新增 PowerShell 编译入口及 Python 镜像刷新流程，支持 PrepareOnly。独立运行包、镜像清单和报告目录避免旧代码混用；容器内逐文件哈希核验后才提交镜像，失败清理临时容器并停止后续阶段。
- 本地数据加载先校验固定 Parquet SHA256，预测与评分共享该入口。新增独立手动刷新回归用例，按约定未执行。
- pnpm check 通过：19 文件、129 项通过、1 项平台跳过；Python Ruff 和 PowerShell 语法解析通过。未运行真实镜像刷新、模型或官方评分，新入口端到端仍待手动验收。

## 2026-09-12：WSL 路径参数修复

- 复现 PowerShell 经 WSL 默认 shell 传入 G:\codeagent 后反斜杠丢失的问题。入口改用 --exec 直接传参，并将 Windows 路径转换为正斜杠；Python 入口也使用 --exec 保留含空格参数。
- 实际 WSL 路径转换验证通过：G:/codeagent 和含空格路径均完整返回 Linux 路径。未启动镜像刷新或 Evaluation。

## 2026-09-12 辅助模型配置

新增可选辅助模型和独立思考等级，并接入上下文摘要。Windows 本机 `pnpm check` 通过（137 passed / 1 skipped），`pnpm test:e2e` 通过（10 项 Chromium）。验证覆盖配置持久化、独立摘要预算、路由及失败保留原始历史；使用模拟服务，未验证真实辅助模型质量、价格或其他操作系统。Evaluation 未运行，相关路由仅静态检查。

## 2026-09-14：项目内多个对话入口

- 先以 Chromium 回归复现项目内新建入口缺失，再补齐按项目分组、目录预填、名称重置和独立历史切换。
- Windows 本机 `pnpm check` 通过（137 项通过、1 项平台跳过）；`pnpm test:e2e` 全部 11 项通过。检查项目分组截图，确认同一项目展示两个独立对话和新建入口。
- 使用临时项目及模拟模型，未运行 Evaluation；未验证其他操作系统和浏览器。

## 2026-09-14：开发服务重载入口

- Web UI 侧栏新增“重载服务”，以完整浏览器刷新清除旧前端模块和 SSE 连接；刷新后重新请求 bootstrap 并连接当前后端，不停止任务或伪装为进程重启。
- Windows 本机执行 `pnpm test:e2e` 通过：生产构建成功，Chromium 共 13 项通过；新增浏览器用例确认点击入口后页面重新请求 bootstrap，且入口仍可操作。
- Windows 本机 `pnpm check` 通过：类型、ESLint、Prettier、24 个测试文件的 171 项通过（1 项跳过）及生产构建均成功。
- 未在本轮实际修改源码后启动 `tsx watch` 与 Vite 并观察跨进程 HMR 时序；该入口的职责仅是加载监视器已经更新的代码，后端进程重启和前端模块更新仍分别由开发监视器负责。

## 2026-09-14：受监督构建服务重载

- `pnpm start` 已改为 launcher 监督实际后端子进程；确认重载会保存任务中断、关闭旧子进程，之后由固定 IPC 在相同端口启动新的构建产物，UI 以新 token 确认后刷新。
- Windows 本机 `pnpm check` 通过：类型检查、ESLint、Prettier、24 个测试文件的 171 项通过（1 项跳过）和生产构建均成功；其中 launcher 回归验证认证重载后在相同端口启动替代子进程，并能继续认证关闭。
- Windows 本机 `pnpm test:e2e` 通过：生产构建成功，Chromium 共 13 项通过；重载浏览器用例验证取消时不发送请求、确认时发送 `{ "confirm": true }`，并等待不同 token 的替代服务后刷新。一次先前运行在无关的 `page.goto` 出现 `ERR_NO_BUFFER_SPACE`，立即完整重跑后 13 项均通过。未将开发 HMR 时序或真实模型调用作为该功能的验证范围。

## 2026-09-15：低成本模型三级工具审批

- 新增无工具、256 token 上限的审批分类请求，严格处理 `approve`、`human review`、`reject`；分别验证自动通过不创建待审批项、人工确认沿用点击流程并显示理由、拒绝阻止操作并返回理由，以及无分类器时保守保持人工确认。
- Windows 本机 `pnpm check` 通过：类型检查、ESLint、Prettier、27 个测试文件的 203 项通过（1 项跳过）和生产构建均成功。新增 Engine 回归确认显式配置的辅助模型收到审批请求，自动通过决定持久化到会话时间线。
- Windows 本机 `pnpm test:e2e` 通过：生产构建成功，Chromium 共 17 项通过。该浏览器回归沿用无辅助模型时的人工审批降级流程；未调用真实辅助模型，不验证真实模型的风险分类质量、延迟、价格或其他操作系统/浏览器。

## 2026-09-16：工作区内开发命令自动批准提示

- 审批 prompt 明确规定：cwd 固定为工作区且只读写工作区文件的常用开发命令直接返回 `approve`，涵盖包管理器 test/build/lint/typecheck/format 脚本和常见编译、测试、格式化、代码生成工具；构建产物或生成文件的工作区内写入不会单独触发人工确认。
- Windows 本机 `pnpm check` 通过：类型检查、ESLint、Prettier、28 个测试文件的 206 项通过（1 项跳过）和生产构建均成功。回归断言审批指令保留工作区内开发命令的自动批准规则。
- 未调用真实审批模型，因此不验证提供商是否完全遵守该 prompt，也不验证其分类质量、延迟或费用。

## 2026-09-16：显式受信任局域网监听

- `CODEATELIER_LISTEN_ADDRESS` 默认保持 `127.0.0.1`，并覆盖 `::1`、`0.0.0.0` 与 `::` 的配置解析、Vite 通配监听时的本机代理回退，以及默认回环/显式局域网模式下的 Host 和同源 Origin 边界。未在真实局域网设备、其他操作系统或公网防火墙规则上实测。
- Windows 本机 `pnpm check` 通过：类型检查、ESLint、Prettier、29 个测试文件的 211 项通过（1 项跳过）及生产构建均成功。
- Windows 本机 `pnpm test:e2e` 的完整 Chromium 运行中 19/20 项通过；上下文压缩页面的既有加载态断言超时。立即单独重跑该用例通过，因此不将完整浏览器套件描述为干净通过；此次未运行真实局域网浏览器访问。

## 2026-09-17：编辑定位与换行等价匹配

- 基于本机运行服务截至北京时间 19:40 的历史，筛出当天 35 个文本匹配失败的逐文件条目；其中 16 个能与后续成功调用的同一修改可靠配对。失败与成功文本对比为：10 个 `oldText` 完全相同而行范围改变，2 个只差 CRLF/LF，3 个只差缩进或空格，1 个成功调用扩大了片段。该配对说明改动方向，但后续成功文件不自动证明整批原调用可重放。
- 用历史完整 `read_file` 快照做只读离线重放时，35 个目标中仅 2 个满足“完整读取且无已记录的中途命令或写入”条件：1 个通过新增换行等价匹配定位，1 个仍找不到。其余 26 个读取片段不完整、5 个中间运行过命令、1 个中间写过文件、1 个缺少先前读取，未把它们计作成功或失败。另以 16 组成功调用的旧文本和行号构造最小反事实片段时，默认全文搜索均能定位候选；该片段不代表完整原文件，不能证明全文唯一性或真实任务成功。
- 回归测试覆盖 Markdown/Python 的双向 CRLF/LF 定位及替换风格、重复候选拒绝和其他空白敏感差异拒绝。未运行真实模型 Evaluation；离线分析脚本及摘要保留在忽略的 `.local/` 目录，不进入产品源码或默认测试。
- Windows 本机 `pnpm check` 的沙箱运行中，进程取消与服务关闭的 3 个既有用例发生 15 秒超时并伴随临时目录 `EBUSY`。随后在解除沙箱限制的同一工作区完整重跑通过：32 个测试文件，235 项通过、1 项跳过，类型检查、ESLint、Prettier 和生产构建通过。本次未运行 UI E2E，因为没有改变 UI 或 HTTP/SSE 交互。

## 2026-09-18：移除每请求机械引用

- 低于容量阈值时，主任务请求、瞬态重试及工具后续轮次均发送完整活动上下文；达到阈值后的一级读取去重、归档和摘要仍按原预算规则执行。测试先在旧实现下确认新增回归失败，再修改实现。
- `pnpm check` 在解除沙箱限制的同一工作区通过：类型、ESLint、Prettier、35 个测试文件的 243 项通过、1 项跳过，生产构建成功。受限环境中的既有进程取消及服务关闭用例曾发生临时目录 `EBUSY` 和超时；解除限制后的完整检查通过。
- 未运行 Evaluation、真实模型或浏览器 E2E；静态与模拟模型测试不证明服务端缓存命中率已改善。

## 2026-09-18：WSL2 bubblewrap inspect Sandbox 夹具（历史证据，非 restricted-token）

- Windows 10 Enterprise（build 26200）上的 WSL `Ubuntu-26.04` 使用 Linux kernel `6.18.33.2-microsoft-standard-WSL2`。`unshare --user --map-root-user --mount --net --fork` 可以创建 namespace，但用户 namespace 内直接 `mount --bind / ...` 被拒绝；没有把该失败路径登记为 Runtime。
- 同一发行版已安装 `/usr/bin/bwrap`。实际无害夹具以 `bwrap` 的 user/PID/network namespace、只读 `G:/codeagent` 映射、私有 `/mnt`、`/home`、`/root`、`/tmp`、新 `/proc`、最小 `/dev` 启动：可读取工作区 `package.json`，工作区内 `touch` 因只读文件系统失败，`/mnt/g` 与 `/home/root/.ssh` 不存在。该证据只覆盖本机 WSL2 参考后端。
- `WslInspectRuntime` 的实际 `selfCheck` 成功；隔离命令返回 `sandbox-ok`，独立边界命令验证 `/mnt/g`、`/home/root/.ssh`、真实 `.git/config` 与 `/sys/class/net` 不可见，且工作区写探针失败后返回 `boundary-ok`。本轮 `pnpm check` 通过：类型、ESLint、Prettier、36 个测试文件的 250 项通过和 1 项跳过，以及测试生产构建；构建仍有前端 bundle 大小警告。
- 未验证 Windows 原生 restricted token/Job Object、其他 WSL 发行版、Linux/macOS、受保护路径的全部别名、cgroup/rlimit、fork/取消、资源消耗或真实构建；不将该夹具描述为完整 S2 或跨平台系统隔离。

## Windows Sandbox 探针与专用用户目标的验证状态

- 2026-09-20 目标契约改为可用性优先后，通用 `SandboxBroker` 已完成第一阶段实现：关闭时仍调用原宿主执行器；缺 Runtime、工作区 preflight 或自检在命令启动前失败时，状态变为 `host-process-fallback`，同一任务固定使用宿主执行器；Runtime execute 已开始后的异常变为 `unknown` 且不调用宿主执行器。UI/历史显示醒目警告，Bootstrap 返回 Broker 最新状态，生命周期写入独立 `sandbox.log`。现名 `runtime-capability-core.ts` 的模块增加绑定 execution instance/请求摘要/30 秒期限的一次性命令 grant，以及不向 Runtime 暴露 API 配置的模型代理；模型 trace 标记 `windows-sandbox-user`、instance、kind 和 `brokered=true`，不含 prompt、instructions、delta 或结果原文。定向 typecheck 与 4 个测试文件共 20 项先通过；普通 Codex Sandbox 中的完整检查仍有 3 个既有进程终止用例超时，随后在宿主权限下 `pnpm check` 全部通过：38 个文件、261 项通过、1 项跳过，类型、ESLint、Prettier 和生产构建通过。UI 变更另以宿主权限完成 Chromium E2E，23 项全部通过；普通 Codex Sandbox 中首次 E2E 的 23 项也均显示通过但 runner 收尾未退出。专用账户、supervisor、真实 pipe 身份、ACL/WFP 产品安装和 relay 尚未实现。
- 同日继续完成命令级 execution instance 账本：每次已批准命令在执行前持久化不可复用 ID，子进程创建后立即追加 PID 和 `host-process | runtime-launcher | runtime` 类型，完成、取消或执行后异常分别记录 `completed`、`cancelled` 或 `unknown`。记录同步进入 session、`sandbox.log` 和 Perfetto trace，不含命令、路径或输出。自动测试覆盖真实 PID 回调、宿主模式的 created/running/completed 序列及 trace 关联；专用账户 supervisor 仍需提供 Runtime PID、创建时间、Job 和 account generation 才能支持重启后复证。
- 该增量在宿主权限下完成 `pnpm check`：38 个测试文件、262 项通过、1 项跳过，typecheck、ESLint、Prettier 和生产构建通过。普通 Codex 外层 Sandbox 中的定向运行仅在既有 Windows 进程树取消用例上超时并留下 `EBUSY`，同一用例在宿主权限下通过；这是外层 Job 影响，不弱化产品断言。
- 恢复与 supervisor 控制契约的下一增量已完成：中断调用在下次模型请求中携带 execution instance 安全摘要和 `replayAllowed:false`；strict supervisor schema 拒绝任意 executable/command/SID/handle，并验证 requestId 相关性、响应字段和固定错误。定向 typecheck、lint 及 recovery/supervisor 11 项测试通过；这不表示真实 C++ 二进制或私有 transport 已完成。
- 随后的宿主权限 `pnpm check` 全部通过：39 个测试文件、265 项通过、1 项跳过，typecheck、ESLint、Prettier 和生产构建通过；仅保留 Vite 已知的 bundle-size 警告。
- supervisor 通道再增加有界 JSONL framing、并发乱序响应路由、本地等待取消和未请求/超限响应的整体失败。定向 supervisor protocol/channel 7 项用例通过；PassThrough 只模拟已建立的私有 handle，不代表 Windows handle 继承、二进制校验或父进程身份已验证。
- 通道增量的宿主权限 `pnpm check` 全部通过：40 个测试文件、269 项通过、1 项跳过，typecheck、ESLint、Prettier 和生产构建通过；仅保留 Vite 已知的 bundle-size 警告。

- 新增 [专用 Sandbox 用户最小验证](../experiments/windows-sandbox-user-demo/README.md)：提升脚本创建随机临时本地账户，为两个实例预置不同 execution SID，并为两个根预置不同 root capability ACE，再以同一账户启动固定 bootstrap。夹具核对共享 account SID、独立 execution/root capability、活动根跨任务可读、直接进程/后代只写各自根，并在 `finally` 精确删除运行目录和账户；密码不进入 argv、环境、文件或输出。该入口是 W2 第一阶段夹具，不覆盖共享 grant、Broker/supervisor 控制面、WFP 或 Git。
- 2026-09-20 首次管理员运行中，两个实例及其后代分别完成跨根读取、自己根写入与对方根写拒绝，但两次 launcher 的 logon SID 同为 `S-1-5-5-0-488199`，触发旧断言。检查确认 `CAProbe*` 账户为 0 且对应运行目录不存在，证明异常清理有效。该证据支持临时账户和文件 root capability 的窄组合，同时推翻“显式凭据启动产生不同 logon SID”的假设；不能记为 W2 通过。
- 修订版改用独立 execution SID 作为实例身份、root capability SID 作为写根身份，兼容 restricting SID 仍包含 logon/Everyone，但 token default DACL 已从 root/logon/Everyone 收紧为共享账户 SID 加本实例 execution SID。C++ `/W4 /WX` 构建和旧当前用户入口回归通过：restricted probe/后代均为 4 个 restricting SID，读写矩阵不变。随后管理员复测最终报告 `distinctExecutionSids=yes logonSidReused=true crossRead=yes ownWrite=yes crossWriteDenied=yes nestedProcess=yes`；复测后 `CAProbe*` 账户和 `run-*` 目录计数均为 0。该结果完成 W2 的顺序文件访问第一阶段；真正并发的文件写入矩阵当时尚未得到结果。
- 下一阶段夹具同时启动两个 bootstrap/Runtime，并从创建时为各自 process/thread/命名 Job 安装 account+execution DACL；Runtime 通过文件屏障观察 peer 的 terminate、注入、duplicate handle、改 DACL、thread suspend/set-context 和 Job terminate/assign open 结果，再执行并发文件访问矩阵。MSVC `/W4 /WX` 构建与 PowerShell 解析此前已通过；D100 更新后，危险 open 只记录 allowed/denied 且不实际执行，W2 通过条件改为双方同时存活时仍保持跨根读取、各自根直接/后代写入和跨根写拒绝。
- 首次管理员并发运行证明 peer 对 `OpenProcess(PROCESS_TERMINATE)`（access `1`）成功，旧探针按当时契约返回 45。显式 process DACL 中虽同时包含共享 account SID 和目标 execution SID，但 token 使用 `WRITE_RESTRICTED`；Microsoft 契约规定该标志只在评估写访问时考虑 restricting SID，而 `PROCESS_TERMINATE` 没有被本次访问检查归入该集合。用户已确认不同对话无需互相隔离，因此该结果现为接受的 process 干扰风险，不再阻塞单账户并发。
- 修订夹具再次通过 MSVC `/W4 /WX` 构建和 PowerShell AST 解析；Codex 宿主批准运行仍不是 UAC 提升，`Assert-Administrator` 按预期拒绝。随后从提升 PowerShell 完成新契约管理员复测：两个并发 Runtime 都观察到 process access `1` allowed、其它 3 个 process/3 个 thread/Job dangerous open denied；双方均通过跨根读取、自己的 existing/direct/nested 写入和对方根 direct/nested 写拒绝，最终 `DEMO PASS` 报告 `distinctExecutionSids=yes logonSidReused=true concurrent=yes peerObjectIsolation=not-required crossRead=yes ownWrite=yes crossWriteDenied=yes nestedProcess=yes`。只读复核确认 `CAProbe*` 账户和 `run-*` 目录计数均为 0。
- 另以未提交候选验证“去掉 `WRITE_RESTRICTED`、对全部访问执行 restricting SID 检查并增加 shared-read capability”：目标可以启动，根读写矩阵保持，但未显式授权的 `C:\Windows\win.ini` 读取和后代 `CreateProcess` 均返回 `ERROR_ACCESS_DENIED`；给 runtime 映像和 token 对象补 execution DACL 后，后代创建仍失败。继续加入 `Users`/`Authenticated Users` 等宽泛兼容 SID 会重新匹配公共可写对象，无法证明只写授权根。该候选代码已撤回，不构成解决方案。
- 新增 [restricted-token 最小可行性探针](../experiments/windows-restricted-token-demo/README.md)，使用真实 `CreateRestrictedToken`、临时 capability SID/ACL、token default DACL、`SeChangeNotifyPrivilege`、suspended process 和 Job。它是手动 feasibility demo，不接入产品、不进入默认测试，也不构成 supervisor 或 Sandbox profile。
- 2026-09-20 在 Windows `10.0.26200`、MSVC `19.52.36725` 上，普通 Codex 工具运行的 launcher 父进程自报 `restricted=yes`、6 个 restricted SID、medium integrity、`appContainer=no`、`inJob=yes`；嵌套 `CreateRestrictedToken` 返回错误 87 且目标没有启动。该结果记录为当前 Codex Sandbox 对实验的干扰，不用于判定目标设计。
- 同一二进制经批准以宿主权限运行时，launcher 父进程为 `restricted=no`、0 个 restricted SID、medium integrity、`appContainer=no`，但仍为 `inJob=yes`。目标和后代均为 `restricted=yes`、3 个 restricting SID、medium integrity、`inJob=yes`；成功读取临时兄弟目录文件和 `C:\Windows\win.ini`，修改安装根 ACE 前的 `existing.txt`，创建 `direct-write.txt`/`nested-write.txt`，对未授权兄弟目录的两次创建均返回 `ERROR_ACCESS_DENIED`，最终夹具检查 `reads=2 allowedWrites=3 deniedWrites=2 nestedProcess=yes` 通过并清理临时目录。
- 首次宿主探针只加入 capability SID 时，目标在进入 `wmain` 前以 `0xC0000142` 退出；加入当前 logon SID、Everyone SID、相应 token default DACL，并只重新启用 `SeChangeNotifyPrivilege` 后通过，证明普通 Win32 启动需要额外兼容 SID。D101 后回归进一步证明 restricting SID 可保留 logon/Everyone，而 default DACL 可收紧为 account/execution 后仍启动并创建后代；但还不能由单个正常 DACL 夹具断言所有工具兼容、复杂文件 ACL 安全或 Broker/supervisor 控制面安全。
- 该结果仅支持“正常 DACL 对象上的核心 restricted token/Job 组合可运行”这一窄结论。由于批准运行仍在 Codex 外层 Job 中，它不证明完全独立的 Job 行为；D099 又把文件身份改为专用账户和显式 ACL，因此 capability SID、当前用户广泛读取与弱 DACL 结论不再是产品方案的直接验收证据。完整 supervisor、私有 desktop、COM/RPC/宿主代写、PID/IPC 身份、复杂 ACL/重解析/其它盘、真实 Git/Node/PowerShell、WFP、relay、凭据、取消/恢复和资源限制仍须按 W0--W6 分层验证。
- 新增 [网络与 Broker IPC 最小探针](../experiments/windows-network-ipc-demo/README.md)。普通 Codex restricted 父 token 下 IPC 子探针仍在 `CreateRestrictedToken` 得到错误 87；经批准的宿主权限运行中，合法 restricted client 的 PID、创建时间、execution SID、映像、Job 与 nonce 联合证明通过，同用户、同映像且知道同一 nonce 的 Job 外 client 被拒绝。它只证明一次 pipe 连接的 Broker 联合身份核验可行，不完成 W3，也不阻止直接 socket。
- 最小 relay lease 探针在普通权限下通过：错误 lease、错误 host 和消费后重放均拒绝，两个登记 lease 分别只在绑定 host 成功，最终报告 `wrongRejected=yes acceptedOnce=yes replayRejected=yes wrongHostRejected=yes boundHostAccepted=yes`。组合 IPC 探针也已在批准的宿主权限下通过：restricted client 经 PID、创建时间、映像、Job、execution SID 和 nonce 联合验证后只从 pipe 获得 lease，并成功访问绑定 host；Job 外同映像进程被拒，最终报告 `relayLeaseDelivered=yes`。该组合完成身份→lease→relay 的机制验证，但尚未实现 CONNECT、DNS、TLS 或真实 Git push。
- 新增 [真实 Git 配置投影探针](../experiments/windows-git-config-demo/README.md)，使用 Git for Windows 2.55.0 在最小环境中通过 `system,global-a,conditional,global-b,local,worktree` 顺序，确认显式 `GIT_CONFIG_GLOBAL` 忽略私有 HOME 的 decoy `.gitconfig`，且 Broker 只读投影根使 `git config --global` 写入失败。首次精确绝对 Windows drive pattern 未命中 `includeIf`，按 Git 官方 glob 语义改用 `**/workspace/.git` 后通过；这同时促使聚合文件从 Runtime 可写 HOME 移到独立只读投影根。该结果不覆盖宿主真实配置图、helper/证书或 push。
- 同一网络探针的 TCP 回环 baseline 在普通和宿主权限运行中均成功；两种运行都在 `FwpmSubLayerAdd0` 得到 `ERROR_ACCESS_DENIED`，说明当前 medium-integrity 验证环境不能安装动态 WFP policy。SDK 10.0.28000.0 条件审计同时确认 user-mode `ALE_AUTH_CONNECT` filter 没有 PID、创建时间或 Job 条件，`ALE_APP_ID` 只是规范化映像路径。D099 不再按 execution instance 或映像放行，而改用安装期创建的稳定专用账户 SID：持久 WFP 只允许该 SID 连接固定 Broker relay/proxy 端口，任务级 host/ref 权限由代理 lease 再校验。这个方案不需要自研 callout driver；动态账户 SID 条件的扩展矩阵和持久规则核心生命周期均已在提升环境实测，但其它协议/地址、产品安装/升级/重启/篡改和 W5 代理绕过夹具尚未完成，因此 W1/W5 仍未完成，不能由 IPC 探针替代。
- 专用账户并发文件矩阵通过后，网络探针增加动态 `ALE_USER_ID` fence。首次提升管理员运行的 V4 矩阵通过：宿主连接不受影响，专用账户连接获准回环端口成功、连接另一端口以 `WSAEACCES 10013` 失败，controller 正常退出；只读复核确认临时 `CAWfp*` 账户和 `user-run-*` 目录均为 0。旧输出中的 `dynamicCleanup=yes` 只代表 dynamic engine 正常关闭，并未在关闭后重连，不作为撤销实证。
- 双栈修订版的提升管理员结果已通过：宿主 V4/V6 均可连接被 fence 的专用账户拒绝端口；专用账户在两个地址族均可连接各自获准端口，连接其它端口均以 `WSAEACCES 10013` 失败；controller 退出并关闭 engine 后，同一账户连接新 V4/V6 listener 均成功，最终报告 `hostUnaffected=yes ipv4=yes ipv6=yes allowedLoopbackPort=yes otherLoopbackPortBlocked=yes dynamicCleanupVerified=yes`。随后只读复核确认临时账户和运行目录均为 0。
- restricted Runtime→网络后代矩阵的提升管理员结果已通过：V4/V6 获准端口均成功，非获准端口均精确返回 `WSAEACCES 10013`；launcher 观察到 restricted parent 和后代的预期退出码，最终报告 `restrictedDescendant=yes`。复核确认临时账户和目录再次为 0。这证明账户 SID fence 不因 restricted token 或直接后代而失效，但仍只覆盖 TCP 回环 connect。
- 首次扩展管理员运行在 UDP 拒绝端口停止：`sendto()` 返回成功，而旧夹具错误地将其当成数据已获准；账户和目录仍清理为 0。该结果不证明绕过，因为 WFP/防火墙可在接受发送后静默丢弃 UDP。修订版由 controller 在允许和拒绝端口都启动 UDP echo，客户端只有收到 ACK 才判定交付；拒绝路径允许 `sendto` 成功，但必须等待 ACK 超时。V4/V6 restricted 后代的本地 UDP 回显基线已通过。
- UDP 修订后的管理员运行已确认允许端口可收到 ACK，拒绝端口在普通及 restricted 后代中均为 `sent=yes delivered=no error=10060`。随后 TEST-NET 非阻塞 TCP 初始返回 `WSAEWOULDBLOCK 10035`，旧夹具错误地把进行中状态当最终阻断并停止；账户和目录仍清理为 0。检查同时发现 permit 只绑定端口而未绑定 loopback 地址，尚不足以实现设计契约。
- 再修订的 allow filter 同时匹配账户 SID、`127.0.0.1`/`::1` 和 relay 端口；非回环测试改为 PowerShell 在本机 `0.0.0.0` 建立真实 listener，客户端经主机名解析连接本机非回环 IPv4。无 WFP 时宿主及 restricted 后代均已实际连接成功；启用 fence 后两条路径均以 `WSAEACCES 10013` 被拒。真实 DNS/DoH 和非回环 UDP 不由无接收端的结果冒充验证。现有 IPC 回归仍输出 `IPC_DEMO PASS trustedAccepted=yes sameUserSameImageRogueRejected=yes`。
- 本轮管理员运行进一步证明 V4/V6 TCP listen 在普通账户及 restricted 后代中均以 `WSAEACCES 10013` 被拒；随后旧 raw 探针仅检查 `socket(SOCK_RAW)` 创建并因创建成功触发错误断言。修订探针现继续执行 raw socket 的 loopback bind，并分别报告 `created`/`bound`；无 WFP 时 restricted 后代的 V4/V6 raw bind 均已成功，因此下一轮 bind 的 `10013` 可归因于 `ALE_RESOURCE_ASSIGNMENT` 规则。失败后的账户和目录仍清理为 0。
- 最终扩展管理员矩阵完整通过：V4/V6 TCP relay 和 UDP ACK 只在 loopback 获准端口成功；其它回环端口、真实本机非回环 IPv4、V4/V6 listen 与 raw bind 在普通账户和 restricted 后代中均被拒；raw 输出为 `created=yes bound=no error=10013`。controller 正常关闭后 connect/listen 恢复，强制终止后 connect 也恢复，最终报告 `tcp=yes udpDelivery=yes nonLoopbackTcp=yes listenBlocked=yes rawDenied=yes restrictedDescendant=yes dynamicCleanupVerified=yes crashCleanupVerified=yes`。只读复核确认临时账户和运行目录均为 0。该证据完成动态规则核心矩阵，不等同于持久安装、自检、升级或卸载通过。
- `wfp-persistent` 生命周期夹具的提升运行已通过：固定测试 provider/sublayer 在显式事务中安装 8 条 persistent filters；安装进程退出后新进程确认 provider/sublayer persistent flag、8 条 filter 的 flag 和关联 GUID。V4/V6 获准回环端口成功，其它端口、listen 和 raw bind 均返回 `10013`；卸载删除 8 条后自检按预期失败为 0 条，V4/V6 原拒绝端口恢复，`finally` 再次清理 0 条。只读复核确认临时账户和目录均为 0。该证据完成探针级持久核心生命周期，不代表产品安装器、重启、升级或故障恢复完成。
- 新增独立 [persistent WFP 恢复脚本](../experiments/windows-network-ipc-demo/recover-persistent-wfp.ps1)：不依赖探针 EXE，以嵌入 C# P/Invoke 分页枚举 filter 快照并只选择固定 provider 的 filter key，依次删除匹配 filters、固定 sublayer/provider，再清理名称精确匹配 `CAPersist[8 位十六进制]` 的账户和仓库内 `persistent-run-[32 位十六进制]` 目录；支持 `-WhatIf`。PowerShell AST、嵌入 C# 独立编译和无变更 `-WhatIf` 已通过；实际删除路径要在提升环境随生命周期夹具共同验证。
- 首次提升运行在安装前预清理失败：零初始化的 `FWPM_FILTER_ENUM_TEMPLATE0.actionMask` 表示不匹配任何 action，BFE 因而返回 `FWP_E_NEVER_MATCH (0x80320033)`；失败发生在创建临时账户及安装持久规则之前，没有产生网络 policy。中间修订曾显式使用 `0xFFFFFFFF` 忽略 action 类型，随后由第二次运行继续暴露零 GUID `layerKey` 问题。
- 第二次提升运行显示部分枚举模板仍不可作为跨 layer 通配：零 GUID `layerKey` 得到 `FWP_E_LAYER_NOT_FOUND (0x80320004)`，同样在创建账户和安装规则之前失败。修订实现不再构造部分模板，而是使用官方定义的 null template 分页枚举快照，并只在本地匹配固定 provider GUID 后计数或删除；独立恢复脚本采用相同策略。第三次提升运行已通过完整生命周期。
- D100 允许同一专用账户的 1～4 个不同工作区任务并发，并明确不同对话不是彼此的 OS 安全边界；D101 明确共享 logon SID 不作为文件写入 capability。管理员夹具现已通过正常 DACL 下两个实例的真正并发文件矩阵；尚未验证 3～4 实例、复杂 ACL、共享 ACE 引用计数、实例级代理 lease、Broker/supervisor 防护或 orphaned generation 排空，因此不能把该局部证据扩展成完整 Sandbox 并发能力声明。
- 为支持上述专用账户夹具，restricted-token 原生探针新增由提升编排端预置 execution/root capability SID 的入口，并在 context 输出 account/logon SID；旧的当前用户入口在批准的 medium-integrity 宿主环境再次完整通过，仍显示外层 `inJob=yes`。这只回归了组件行为，不替代修订版管理员账户实测。
- 探针以 MSVC `/W4 /WX` 构建通过；本轮 `pnpm check` 在普通 Codex 进程沙箱中因三个取消/超时夹具无法终止子进程而失败，改在批准的宿主权限下完整通过：37 个测试文件、255 项通过、1 项跳过，类型、ESLint、Prettier 和生产构建均通过。两次结果分开记录，不把解除 Codex 外层限制当作产品 Sandbox 能力。
- 上一节的 WSL2 无害夹具和本节两个 demo 仍仅可作为旧实现或组件的局部事实；它们不能作为专用用户 fallback、阶段完成或跨平台系统隔离证据。

## 2026-09-21 Sandbox 清理、generation 与并发账本审计

- 静态复核确认并修复取消优先级缺陷：supervisor 的 cleanup 控制帧或退出码 70 现在先于 AbortSignal 分类；Broker 与 ToolRunner 都把该组合持久化为 `unknown`，不会显示普通 `cancelled`。纯函数回归覆盖“取消 + cleanup failure”与正常取消的分流。
- account generation 的 release 改为 prepare/native revoke/commit 两阶段；原生撤销成功前 active lease 和 grant 引用不减少，失败会保留 orphan 对账对象并 quarantine。共享 grant 增加 `provisioning/installed/failed` 状态，后继 lease 在首个 supervisor 回报 Runtime started 前等待，首个 provision 失败时等待者失败并回滚未启动引用。并发回归覆盖共享 read root 的第二个 Runtime 不会抢先执行。
- unknown/orphaned 不再只改内存标志：Broker 调用 Runtime generation drain，先关闭 relay，再运行固定的 `--terminate-account-processes` 与 `--revoke-journal`；服务监听前主动运行同一恢复步骤，从原生持久 ACL journal 对账上次崩溃遗留，失败会保留为后续 Sandbox fallback。内存 generation 继续保持 quarantined，不因 drain 返回成功而在本进程复用。execution instance/session 账本与原生 journal 分别保存审计事实和可撤销对象；仍未完成机器断电、损坏 journal、真实多实例强制终止及提升环境重启夹具。
- Broker 状态从全局 `latestStatus` 改为 task/execution-instance 映射；并发测试让任务 A 停在 host fallback，同时任务 B 完成 sandbox 路径，并分别核对状态不串扰。Bootstrap 只公开启动配置，具体执行事实以 execution instance 与工具结果为准。
- 本轮开始时的基线仍由 Broker Host 的 Node 进程运行 agent loop/文件工具，C++ Sandbox Supervisor 每次只启动一条命令或 Git 的 Sandboxed Tool Process；该事实已被下文同日后续增量取代。当前默认 Windows Sandbox 组装由 Engine 经 `AgentRuntimeLauncher` 启动常驻 Agent Runtime，完整 loop/工具路径见第 286、290、291 条；禁用 Sandbox、非 Windows 或可证明启动前完整回滚的 fallback 才继续使用宿主 loop。
- 2026-09-21 恢复原始进程边界的应用层增量已通过：capability core 与 Runtime IPC 已拆名；新增 8 MiB 有界双向 request/response/event framing、instance/nonce 握手、Broker model/session/approval/memory adapter、Runtime 侧 `ModelProvider`、session/context client 和 Runtime 内 ToolRunner。独立 Node fixture 跨进程完成模型能力查询、delta 流、可重试错误元数据、无效 DAG 的无副作用回传、文件工具、命令、session 持久化和 runtime completed；Engine 集成回归同时确认模型与工具 replay 仍写入 Broker 数据库，Runtime 工具及上下文压缩事件进入独立 Perfetto 逻辑轨道。畸形 JSON、取消与 clean 退出也有回归。该 fixture 使用继承 stdio、当前用户和模拟 provider，只证明 loop 与 adapter 的真实进程分离，不证明 Windows Named Pipe 的 PID/Job/token/capability/generation/nonce/lease 联合身份，也不证明 agent loop 已进入专用账户。
- 同日先新增安装版 `agent-runtime-main` 固定入口及 64 KiB Supervisor 首帧协议。入口 argv 只允许 `\\.\pipe\CodeAtelier.AgentRuntime.*` 本机命名空间，identity/nonce 由严格长度前缀首帧交付，跟随首帧到达的 Runtime IPC 字节不会丢失；错误 pipe、远程 UNC、超限长度、未知字段和非法 nonce 均有无副作用回归。该阶段测试 pipe 仍由普通 Broker 测试进程创建；随后第 286 条已把 C++ Supervisor 建 pipe、联合身份检查、首帧和字节代理接入默认 launcher。两阶段都没有替代固定账户提升环境的 W3 验收。
- 产品与测试 build 现用直接声明的 esbuild 生成 Node 24 ESM `agent-runtime.mjs`、独立 `compaction-worker.mjs` 及只列这两个文件的 SHA-256 manifest；Runtime bundle 约 3.3 MiB，使用仓库内 Node 24 对不存在的合法启动 pipe 做加载 smoke 时按固定诊断退出。构建产物不会被提交。安装器现严格核对 manifest 与源文件，只接受实际报告 v24 的非 reparse Node executable，并把 Node、entry、worker 复制到受保护 ProgramData；v2 state 连同两个原生程序共记录五个 SHA-256，TypeScript 与 native self-check 都会拒绝摘要不符。PowerShell AST、Runtime 构建、MSVC `/W4 /WX` 构建和 Runtime 篡改单测已通过；尚未在提升环境完成真实 install/repair/verify，所以不能据此声称产品安装验收完成。
- 产品 WFP manager 不再从 `experiments` 目录 include 实现。共享实现迁到 `native/windows-sandbox/network-fence-implementation.cpp`；实验入口变为薄包装，产品构建定义 `CODEATELIER_PRODUCT_WFP_ONLY`，只分派 persistent install/verify/remove。MSVC `/W4` 产品构建通过，且产物对实验参数 `--ipc` 返回 2 和固定拒绝文本；这改善代码归属与命令面审计，不替代提升 WFP 行为矩阵。
- 默认 Windows Agent Runtime launcher 现已接线：SandboxBroker 在 native 启动前建立 AccessManifest、generation lease 和两阶段 grant；C++ Supervisor 只启动 v2 state 固定的 Node 24/entry，以逐租约私有目录作为初始 CWD，创建任务专属 Named Pipe，并在发送 identity/nonce 首帧前联合核对客户端 PID、创建时间、Job、账户 SID、restricted execution/root capability 与固定 Node 映像。Supervisor 随后双向代理原始 Runtime IPC，stdin 断连终止 Job；正常 close 再由 Broker 执行 native revoke/commit，无法证明 clean 时 quarantine 并整代排空。启动前 self-check/provision 可证明回滚时才抛出显式 fallback，Engine 记录 `host-process` 后继续宿主 loop。3 项 Broker launcher 回归、Engine fallback、既有 startup/IPC 回归、TypeScript 检查和 MSVC `/W4` 构建已通过；尚未运行产品固定账户提升安装，因此这里只记录代码接线与无管理员副作用证据，不把 W3/W4 标为平台验收完成。
- 显式 `pnpm sandbox:runtime:verify` 产品验收入口不访问真实模型、外部网络、真实 remote 或凭据。它先经默认 Engine、SandboxBroker、C++ Supervisor 和受保护 Node bundle，让专用账户 Agent Runtime 执行固定 `edit_files`，核对 execution instance 为 `windows-sandbox-user/completed`、文件结果和零活动 lease；再由低成本模型夹具批准结构化扩展写权限，让独立 Capability Runner 在工作区 sibling 目录写入固定标记，并用系统 `curl.exe` 经自身环境中的短期代理 token 请求获准但必须被 relay 以 403 拒绝的 `127.0.0.1`，核对 `running→failed`、结果回传、Agent Runtime 继续完成和 ACL/lease 清零。随后宿主夹具对同一私网目标验证独立 Push Runner 的审批、askpass 路径、`running→failed` 和 clean release；最后在 Broker model 请求中主动取消第四个 Runtime，必须持久化 `cancelled`、不得出现 `unknown`。非 Windows 固定 SKIP，失败保留 `.local/sandbox-runtime-verification` 现场。当前代码已通过脚本类型、lint、格式及应用层回归；本次在非产品安装态实际启动时 install attestation 失败并按设计转入 host fallback，故没有形成 W3--W6 平台证据。即使真实安装下私网拒绝通过，也不证明公网 HTTPS、真实 remote 或真实凭据成功。
- Runtime IPC 取消从仅停止本地等待者改为显式 `request_cancel(requestId)`：远端只中止对应 handler，已取消请求不再发送响应；本地保留最多 1024 个 requestId tombstone，忽略取消竞态中的迟到响应，其他未知响应仍关闭通道。回归证明远端 AbortSignal 被触发且同一连接可继续处理下一请求；这为 Agent Runtime 阻塞等待 Push Runner 和 W6 主动取消消除悬挂的 Broker 请求，但仍不是 Push Runner 执行链本身。
- D105 删除了 push 前终止/重建 Agent Runtime 的要求。Runtime 内 Git 继续查询唯一 upstream、HTTPS URL、source OID 与目标 ref，但 `git_push` IPC 只发送严格 PushSpec 与当前 `toolCallId`；含 push 的工具批次若还有任何其它节点，会在产生副作用前整体作为无效图返回模型修正。Broker 逐次审批后从 PushSpec 重建固定 `git push --porcelain <remote> <oid>:<ref>` 参数，并以独立 `push-runner` execution instance 调用现有 native Runtime/relay 路径；execution event、Sandbox log 与 Push Runner trace 使用同一 `toolCallId` 关联原工具调用，该调用显式禁止 host fallback。Agent Runtime 保持存活并在同一 IPC request 上等待，且拿不到 Runner 的 proxy lease/credential channel。内存 generation 允许同一任务的一个被阻塞 Agent Runtime 与一个 Push Runner 重叠，不因此放宽 1～4 个任务上限或同工作区跨任务串行。结构化 IPC、真实临时仓库分流、独占批次、重叠 lease 和禁止宿主 fallback 回归已通过；Broker 实时记录的 `git_output` 不再由 Runtime 收到最终结果后重复写入。固定账户下真实 HTTPS remote、凭据/helper/hook、Runner 取消与 unknown generation drain 仍未完成提升环境端到端验收，因此 W5 仍不能标记完成。
- D106 将 Sandbox 内工具审批边界改为“已有能力免审批、越界命令统一申请”：`run_command` 在 Agent Runtime 内不再调用 approval adapter；普通文件工具解析到授权根外时拒绝。新增严格 `run_with_permissions` 工具与 IPC operation，携带命令、最多 16 个递归只读根、16 个递归可写根、一个 HTTPS host、理由和 `toolCallId`。该调用只阻塞自身 DAG 节点，无依赖工具可并行；Broker 重新规范化并沿用现有低成本模型三级审批，随后以独立 `capability-runner`、AccessManifest、Job 和 host-bound relay lease 执行，明确禁止宿主 fallback，且不以宿主 token 运行 LLM 命令。任务 tool trace 按现有规则保存经密钥脱敏的完整参数；Sandbox 生命周期 trace 仍只记录安全摘要。短期 proxy token 仅进入 capability runner 环境，Push Runner 仍经 askpass 且可读取 WinCred。应用层 schema/adapter、真实 Runtime 子进程审批与结果返回、DAG 并行、重叠 lease、根投影和无审批普通命令回归已通过；固定账户真实 ACL、通用 HTTPS client、取消/unknown 清理及代理凭据生命周期尚未提升验收，不能据此宣称 W4/W6 完成。
- Agent Runtime 的 context tracing 不再止于 Broker 外围模型和工具 span：Runtime 对 `context.prepare`、`context.request` 及两个预算计量子阶段发送严格 trace span event，Broker 按 Runtime span/parent ID 重建 `Main thread` 父子 slice，并在断连时把未闭合 span 标为 cancelled/error。协议只接受四个固定名称以及 step/attempt/force/inputItems/toolCount/amount/errorName 有界字段，任意名称或自由文本属性会关闭连接。真实 Node Runtime 子进程回归核对四对 begin/end slice，IPC 回归核对非法 trace 事件拒绝；这完成应用层跨进程 context tracing 接线，不替代 Windows Named Pipe 身份验收。
- 共享账户 ACL 账本补齐 read/write 跨模式并发：grant key 改为稳定对象身份，同一对象不会因两个实例用途不同而重复安装账户 ACE 或被其中一个实例提前撤销。原生账户 ACE 统一提供 normal-side 读写候选权限，真正写入仍需该实例独有 capability ACE 与 `WRITE_RESTRICTED` token 同时允许；实例退出继续只撤销自己的 capability ACE，Broker 最后引用才通过 journal/revoke 移除账户 ACE。回归还证明已失败 grant 的后继 acquire 在改变引用前拒绝，不留下无 active lease 的幽灵引用。TypeScript 状态机测试和 MSVC 构建只能证明编排与可编译性，固定账户真实跨模式 ACL 仍属于 W2 提升验收。
- 最后共享引用的撤销不再只依赖原路径：supervisor 先按路径打开并核对卷/file ID；路径已被替换或同卷 rename 时，改用卷句柄与 `OpenFileById` 按持久 journal 的 64 位 file ID 重开，再次复核对象类型、reparse 标志、卷序列号与 file ID 后才移除账户 SID ACE。新路径对象不会被误改，原对象无法定位仍返回 cleanup unknown 并隔离 generation。MSVC `/W4 /WX` 构建通过；尚未以提升夹具实测目录/文件 rename、挂载卷、删除重建及服务重启恢复矩阵。
- CONNECT relay 的 DNS 结果检查补齐 IPv6 特殊路由：只接受 `2000::/3` 普通全球单播，并额外拒绝 Teredo、benchmark、ORCHID、文档和 6to4；NAT64 等不在全球单播前缀的转换地址也拒绝。IPv4 mapped 地址继续回到 IPv4 私网分类。13 项地址/relay 回归不访问公网，覆盖 loopback、link-local/metadata、ULA、mapped metadata、Teredo、6to4、NAT64、文档地址和正常公网样例；真实 DNS64、多地址 rebinding 与公网 CONNECT 仍需 W5 提升/网络环境验收。
- Runtime IPC 应用握手改为严格顺序：Broker 收到匹配的 `runtime_hello` 前，任何 request 或 event（不只 trace）都会立即关闭整条通道，不再允许先改变 ready/cancel 状态或取得普通错误响应后继续握手；observer 的语义异常也统一转成通道失败而不是未处理 Promise rejection。10 项 IPC 回归覆盖错误 nonce、握手前 ready、observer 异常、畸形帧、取消竞态和连接继续使用；Windows transport 身份错配仍需 W3 提升矩阵。
- Runtime 的 session 写入不再接受任意事件名：协议只允许 Agent Runtime 实际产生的模型、上下文、工具输出/状态、diff 和子进程 PID 事件；`execution_instance`、`sandbox_stage`、fallback/warning 和 `task_end` 等 Broker 专属审计事实无法经 Runtime IPC 构造。schema 回归同时确认正常 `tool_result` 保持可用；事件 payload 仍受 8 MiB 帧上限和 Broker 统一凭据脱敏，不把 Runtime 事件当成独立安全证明。
- Agent Runtime 已启动后若 IPC 断开或协议错误导致 Broker 未取得可信任务终态，Engine 现在以 `unknown` 关闭 launcher 并记录 `sideEffectsPossible=true`；SandboxBroker 即使确认 native Job shutdown clean，也不会正常释放并复用 lease，而是隔离 account generation、调用整代 drain 并返回 orphaned。正常 Runtime 报告的失败仍可 clean release；可证明清理完成的主动取消记录 `cancelled`，同时保留可能已发生副作用。应用层回归覆盖 clean native shutdown 也不得掩盖未知工具结果；真实 supervisor 断连/崩溃注入仍待提升环境验收。
