# 初版验证记录

日期：2026-09-07；后续条目按各自日期补充。以下区分实际验证和计划覆盖，不将构建成功等同于跨平台运行成功。**当前 Windows 专用用户 Runtime 与 Broker 目标架构尚未实现或验证；本文件中的 WSL2 与 restricted-token demo 条目只是历史或局部证据，不能用于宣称专用用户 Sandbox 能力。**

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

- 新增 [专用 Sandbox 用户最小验证](../experiments/windows-sandbox-user-demo/README.md)：提升脚本创建随机临时本地账户，为两个实例预置不同 execution SID，并为两个根预置不同 root capability ACE，再以同一账户启动固定 bootstrap。夹具核对共享 account SID、独立 execution/root capability、活动根跨任务可读、直接进程/后代只写各自根，并在 `finally` 精确删除运行目录和账户；密码不进入 argv、环境、文件或输出。该入口是 W2 第一阶段夹具，不覆盖真正并发、同账户私有对象攻击、共享 grant、WFP 或 Git。
- 2026-09-20 首次管理员运行中，两个实例及其后代分别完成跨根读取、自己根写入与对方根写拒绝，但两次 launcher 的 logon SID 同为 `S-1-5-5-0-488199`，触发旧断言。检查确认 `CAProbe*` 账户为 0 且对应运行目录不存在，证明异常清理有效。该证据支持临时账户和文件 root capability 的窄组合，同时推翻“显式凭据启动产生不同 logon SID”的假设；不能记为 W2 通过。
- 修订版改用独立 execution SID 作为实例身份、root capability SID 作为写根身份，兼容 restricting SID 仍包含 logon/Everyone，但 token default DACL 已从 root/logon/Everyone 收紧为共享账户 SID 加本实例 execution SID。C++ `/W4 /WX` 构建和旧当前用户入口回归通过：restricted probe/后代均为 4 个 restricting SID，读写矩阵不变。修订后的专用账户入口仍待管理员复测，显式 process/thread/object DACL 与同账户攻击也尚未验证。
- 新增 [restricted-token 最小可行性探针](../experiments/windows-restricted-token-demo/README.md)，使用真实 `CreateRestrictedToken`、临时 capability SID/ACL、token default DACL、`SeChangeNotifyPrivilege`、suspended process 和 Job。它是手动 feasibility demo，不接入产品、不进入默认测试，也不构成 supervisor 或 Sandbox profile。
- 2026-09-20 在 Windows `10.0.26200`、MSVC `19.52.36725` 上，普通 Codex 工具运行的 launcher 父进程自报 `restricted=yes`、6 个 restricted SID、medium integrity、`appContainer=no`、`inJob=yes`；嵌套 `CreateRestrictedToken` 返回错误 87 且目标没有启动。该结果记录为当前 Codex Sandbox 对实验的干扰，不用于判定目标设计。
- 同一二进制经批准以宿主权限运行时，launcher 父进程为 `restricted=no`、0 个 restricted SID、medium integrity、`appContainer=no`，但仍为 `inJob=yes`。目标和后代均为 `restricted=yes`、3 个 restricting SID、medium integrity、`inJob=yes`；成功读取临时兄弟目录文件和 `C:\Windows\win.ini`，修改安装根 ACE 前的 `existing.txt`，创建 `direct-write.txt`/`nested-write.txt`，对未授权兄弟目录的两次创建均返回 `ERROR_ACCESS_DENIED`，最终夹具检查 `reads=2 allowedWrites=3 deniedWrites=2 nestedProcess=yes` 通过并清理临时目录。
- 首次宿主探针只加入 capability SID 时，目标在进入 `wmain` 前以 `0xC0000142` 退出；加入当前 logon SID、Everyone SID、相应 token default DACL，并只重新启用 `SeChangeNotifyPrivilege` 后通过，证明普通 Win32 启动需要额外兼容 SID。D101 后回归进一步证明 restricting SID 可保留 logon/Everyone，而 default DACL 可收紧为 account/execution 后仍启动并创建后代；但还不能由单个正常 DACL 夹具断言所有工具兼容或所有私有对象安全。
- 该结果仅支持“正常 DACL 对象上的核心 restricted token/Job 组合可运行”这一窄结论。由于批准运行仍在 Codex 外层 Job 中，它不证明完全独立的 Job 行为；D099 又把文件身份改为专用账户和显式 ACL，因此 capability SID、当前用户广泛读取与弱 DACL 结论不再是产品方案的直接验收证据。完整 supervisor、私有 desktop、COM/RPC/宿主代写、PID/IPC 身份、复杂 ACL/重解析/其它盘、真实 Git/Node/PowerShell、WFP、relay、凭据、取消/恢复和资源限制仍须按 W0--W6 分层验证。
- 新增 [网络与 Broker IPC 最小探针](../experiments/windows-network-ipc-demo/README.md)。普通 Codex restricted 父 token 下 IPC 子探针仍在 `CreateRestrictedToken` 得到错误 87；经批准的宿主权限运行中，合法 restricted client 的 PID、创建时间、execution SID、映像、Job 与 nonce 联合证明通过，同用户、同映像且知道同一 nonce 的 Job 外 client 被拒绝。它只证明一次 pipe 连接的 Broker 联合身份核验可行，不完成 W3，也不阻止直接 socket。
- 同一网络探针的 TCP 回环 baseline 在普通和宿主权限运行中均成功；两种运行都在 `FwpmSubLayerAdd0` 得到 `ERROR_ACCESS_DENIED`，说明当前 medium-integrity 验证环境不能安装动态 WFP policy。SDK 10.0.28000.0 条件审计同时确认 user-mode `ALE_AUTH_CONNECT` filter 没有 PID、创建时间或 Job 条件，`ALE_APP_ID` 只是规范化映像路径。D099 不再按 execution instance 或映像放行，而改用安装期创建的稳定专用账户 SID：持久 WFP 只允许该 SID 连接固定 Broker relay/proxy 端口，任务级 host/ref 权限由代理 lease 再校验。这个方案不需要自研 callout driver，但专用账户 SID 条件、持久规则、提升安装和绕过夹具尚未实测，因此 W1/W5 仍未完成，不能由 IPC 探针替代。
- D100 允许同一专用账户的 1～4 个不同工作区任务并发；D101 明确共享 logon SID 不授权，必须由 execution SID 隔离。现有探针尚未验证同账户实例之间的 process/thread/token/Job handle 防护、真正并发、共享 ACE 引用计数、实例级代理 lease 或 orphaned generation 排空。因此当前证据不能支持 Sandbox 并发声明。
- 为支持上述专用账户夹具，restricted-token 原生探针新增由提升编排端预置 execution/root capability SID 的入口，并在 context 输出 account/logon SID；旧的当前用户入口在批准的 medium-integrity 宿主环境再次完整通过，仍显示外层 `inJob=yes`。这只回归了组件行为，不替代修订版管理员账户实测。
- 探针以 MSVC `/W4 /WX` 构建通过；本轮 `pnpm check` 在普通 Codex 进程沙箱中因三个取消/超时夹具无法终止子进程而失败，改在批准的宿主权限下完整通过：37 个测试文件、255 项通过、1 项跳过，类型、ESLint、Prettier 和生产构建均通过。两次结果分开记录，不把解除 Codex 外层限制当作产品 Sandbox 能力。
- 上一节的 WSL2 无害夹具和本节两个 demo 仍仅可作为旧实现或组件的局部事实；它们不能作为专用用户 fallback、阶段完成或跨平台系统隔离证据。
