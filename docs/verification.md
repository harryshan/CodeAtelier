# 初版验证记录

## MCP 主动服务用途目录（2026-10-05）

- 按 D135 增加可选 description 与无连接的公开目录投影；宿主、独立 Node Runtime 和启动前 fallback 均在首次及续聊任务的模型指令中提供服务名称/用途/transport。list_servers 复用投影，禁用服务不出现，旧配置缺失用途为 null；目录不包含连接字段，已知凭据先脱敏，未调用 MCP 的任务不审批、不启动 MCP 进程。
- Windows / Node.js 26.10.0 / pnpm 12.8.1：专项 7 个测试文件、57 项通过；最终完整 `pnpm check` 通过，83 个测试文件、598 项通过、1 项原有跳过，类型、ESLint、Prettier、服务端/Web/Runtime 测试构建通过。新增覆盖 stdio/HTTP 用途字段、配置兼容与边界、公开摘要/凭据隔离、最坏 JSON 转义的传输容量，以及有效 v8/拒绝 v7 握手。初次完整检查在新增测试的一处 ESLint 空行规则停止，修正后重新运行全套通过。
- Runtime IPC 升至 v8，安装副本需重建并管理员 Repair；本次只生成测试构建，未更新安装副本或重载运行中的后端。没有改 UI 或 HTTP/SSE 接口，未运行浏览器 E2E、Evaluation、真实模型或第三方 MCP 验收；独立 Node 子进程不替代固定账户安装态、macOS/Linux 验收，也不能证明真实模型必然选中正确服务。
- `src/mcp` 写入遇到 EPERM 后复核原文件哈希与新文件不存在，再经 Broker 宿主权限完成精确编辑；测试也由获准宿主命令执行，未改 ACL、私有 MCP 配置或用户既有文件。既有 Zod 注释与 Web bundle 大小构建警告保留。

## 数据库对话与 Task 阅读器（2026-10-05）

- 按 D134 将 Web 阅读器默认数据源改为当前后端数据库；复用 Store 的分片定位、Task 元数据目录和单任务 Replay 重建，校验 cookie/密码/Origin/会话归属，不提供 SQL 或文件路径输入，不启动历史执行。页面可选对话与 Task、按目录字段过滤、手动刷新、从 URL 恢复选择；切换/失败清空旧记录，取消信号隔离晚到响应。本地 JSON 和离线文件仍可使用。
- Windows / Node.js 26.10.0：`pnpm check` 全部通过，82 个测试文件、590 项通过、1 项原有跳过，类型、ESLint、Prettier 和 Web/后端/Runtime 测试构建通过。增量 API/门禁/阅读器复核 12/12 通过。
- Chromium E2E 以 `pnpm test:e2e --shard=1/2` 和 `--shard=2/2` 串行覆盖全套，27 + 10 = 37 项全部通过。真实测试服务使用临时 SQLite 保存任务后通过 UI 查询和切换两个 Task、刷新恢复及空对话；合成响应另外覆盖竞态、404/重试、空库、无效深链接。主 UI、密码门禁与 file:// 兼容回归保留。
- 初次增量检查修正了 Fastify/Pino 类型与测试参数初始化；两个测试假设也已更正：`hasActiveTasks` 包含手动写入的 queued 记录，实际执行断言应检查 activeTasks；真实捕获会先出现 title 模型调用，阅读器测试应导航到 task 回复。修正后保持状态/载荷和不执行历史的断言，没有修改这些产品语义。
- `pnpm build` 生产构建通过，已生成新的后端路由和前端产物；没有在本次任务中重载当前服务，以免中断正在执行的任务。
- 日志在忽略的 `.local/replay-db-*.log`。Runtime 无 pnpm 且阅读器目录临时写入 EPERM，相关步骤经批准以 Broker 宿主权限执行，未改 ACL。未读取 `1.json`、个人数据库，未运行真实模型或 Evaluation，未作 macOS/Linux 或非 Chromium 验收。升级需要当前任务结束后重载后端，不能只刷新旧服务的页面；大 Task 仍同步完整重建，不能宣称流式分页或低内存读取，既有构建警告仍保留。

## 现有 Web 服务托管 Replay 阅读器（2026-10-05）

- 根据用户更正，主侧栏“对话阅读器”另开同源 `/?view=replay`，复用 AccessGate，浏览器选择 JSON 后本地解析，不新增上传或服务端文件 API；独立 HTML 只保留可选兼容入口。共享 DOM 挂载/清理支持 StrictMode；原单文件 CSP 与文本安全显示不变。
- Windows / Node.js 26.10.0：最终原样 `pnpm check` 通过，81 个测试文件、587 项通过、1 项原有跳过，类型、ESLint、Prettier 与测试构建通过。独立 MCP 与阅读器复核 17/17 通过；此前一次完整检查的未修改 MCP 截断用例缺少 `truncated` 字段，不把复跑通过称为已修复其间歇风险。
- 完整 Chromium E2E 按 `pnpm test:e2e --shard=1/2` 和 `--shard=2/2` 分批正常完成，27 + 7 = 34 项全部通过，仍使用原单 worker 和断言。先前组合命令及一次不分批运行触发外层执行时限，后者日志记录 33 项通过但无最终结果，故不算完整通过。
- 新覆盖 HTTP 阅读器本地导入、工具与模型导航、安全文本/分页、坏文件保留旧视图、导入后零网络请求、侧栏另开/返回、刷新需重选且不写 localStorage；门禁状态失败不挂载，主页面和阅读器均需正确密码后才呈现内容。仍保留真实 `file://` 兼容验证。
- `pnpm build` 生产构建通过；对正在运行的本机 `http://127.0.0.1:4142/?view=replay` 做只读 HTTP 冒烟，页面 200 且引用的新入口脚本包含 ReplayViewer 分块，未重启服务。
- 验证输出在忽略的 `.local/replay-host-*.log`。Runtime 无 pnpm，且阅读器目录写临时文件报 EPERM，相关修改与检查经批准在 Broker 宿主执行，未修改 ACL。未读取 `1.json`、个人历史或运行 Evaluation/真实模型，未进行 macOS/Linux 与非 Chromium 验收；超大 JSON 的完整解析内存成本与既有 bundle 警告仍保留。

## 离线 Replay 对话阅读器（2026-10-05）

- 增加独立 `pnpm replay:view`，将现有 TaskReplayCase v1 JSON 转为单文件 HTML，或生成空白阅读器以在浏览器本地选文件。模型请求/重试、唯一 call ID 关联工具、未知结果、legacy、事件、搜索、分页与惰性载荷由合成夹具覆盖，不改变捕获或恢复链路。
- Windows / Node.js 26.10.0：最终 `pnpm check` 全部通过，81 个测试文件、587 项通过、1 项原有跳过；类型、ESLint、Prettier 和 Web/服务端/Runtime 测试构建通过。Chromium `pnpm test:e2e` 30/30 通过，新增两项真实 `file://` 测试覆盖离线导航、本地导入、坏输入保留旧视图、大文本分页、安全文本显示和不发起 HTTP 请求。
- 中间一次默认并发检查中，未修改的 `process-tree.test.ts` file-backed 用例触发八秒安全清理，`mcp.test.ts` 截断用例未返回预期 `truncated` 字段；随后两者与新增阅读器独立复核 19/19 通过，再运行原样默认并发完整 `pnpm check` 通过。未放宽断言、降低默认并发或修改这些测试；不将重跑通过描述为已修复其所有时序风险。
- 手动 CLI 已生成 `.local/replay-viewer.html` 空白阅读器（忽略的本地产物），未读取个人导出。Runtime 无 pnpm，验证经批准在 Broker 宿主执行；未运行 Evaluation、真实模型、macOS/Linux 或其它浏览器验收。保留既有 Web bundle 大小警告；超大 JSON 仍受完整解析/搜索的内存成本限制。

## pnpm check 时序调查与 MCP 清理修复（2026-10-05）

- 重新检查旧日志并按默认并发复现：审批用例把 Vitest 默认一秒轮询期限当作任务启动要求；subagent 提问用例在 Worker 尚未就绪时开始一秒等待；MCP 操作超时/取消混入首次握手；Windows 进程树用例的八秒安全计时器从启动开始累计，可能在真正的 taskkill 完成前主动杀父子进程。本次记录中，后代 PID 在 6213 ms 就绪、taskkill 在 7917 ms 启动，安全清理在 8019 ms 抢先触发，taskkill 到 10334 ms 才结束；这是测试干扰取消流程的直接证据，不等于产品在正常取消时遗留后代。
- 另定位并先用真实 PID 回归复现一项产品缺陷：SDK 1.31.0 的 `Client.connect` 初始化失败后异步关闭 stdio，transport 立即清空内部进程引用；后端再次关闭会提前返回，读取 PID 也得到 null，可能在直接子进程仍存活时报告已清理并造成 Windows `EBUSY`。新增 `McpStdioTransport` 保存启动 PID、共用首次关闭 Promise；任务客户端继续使用原清理期限确认退出，并增加 `mcp.connection_close` 安全 trace。回归保持超时结果未知、失败后禁止重连的语义，不以删除重试掩盖残留进程。
- 测试改为等待指定任务审批、Worker 模型请求或 MCP 请求到达的就绪信号，再触发被测操作；显式 1100 ms 模型与 3100 ms 握手延迟覆盖旧假设。进程树夹具改为真实 Node 父子进程并保留继承输出句柄和延迟真实 taskkill，启动/取消分别使用八秒安全期限，安全清理触发仍失败；真实 shell 集成覆盖保留。没有降低默认文件并发数、增大十五秒单用例期限或修改产品请求超时。
- Windows / Node.js 26.10.0：最终 `pnpm check` 通过，80 个文件、582 项通过、1 项原有跳过，类型、ESLint、Prettier、Web/服务端/Runtime 测试构建全部通过；独立 Chromium `pnpm test:e2e` 28/28 通过并正常退出。Node.js 24.21.0 以同一测试 runner 和默认并发运行完整普通测试，同样为 80 个文件、582 项通过、1 项跳过；不将该次普通测试描述为 Node 24 完整 check。构建仍有既有 Web bundle 大小警告。
- 本次更正旧报告遗漏：`.local/swebench/check-unlimited-3.log` 实际包含完整默认并发检查通过（80 个文件、581 项通过、1 项跳过及构建通过），因此下方无评测预算复跑记录原来的“完整检查未通过”表述不准确。此前不同失败日志仍有效，第三次重跑通过也不能单独证明根因已修复。
- 诊断与最终日志保存在本机忽略的 `.local/timing-investigation-*.log`，时序采样为 `.local/timing-investigation-file-backed.json`；临时诊断 instrumentation 已移除。验证使用获准宿主执行以排除 Codex 外层 Sandbox 的包管理器/进程终止限制；没有运行 Evaluation、真实模型、固定账户安装态或 macOS/Linux 验收。当前结果证明已定位路径的回归通过，不保证所有压力条件下永无时序失败。

## SWE-bench Verified 固定 20 题无评测预算复跑（2026-10-04）

- 用户要求移除 SWE-bench 官方规则之外的评测预算后再运行同一固定 20 题。显式 `--unlimited` 取消累计 token、模型调用、Agent 步数、任务总时长及预测容器额外的 4 GB/2 CPU 限额；保留产品单请求/单命令超时、真实模型容量、权限边界和官方评分测试 1800 秒超时。本轮数据修订及 Parquet SHA-256 与下方旧轮相同，20 题各预测一次、官方独立评分一次。
- **官方结果：15/20 解决（75%），旧轮为 14/20（70%）。** 20/20 补丁非空且成功应用，20/20 完成评分，`error_instances=0`、无遗留运行容器；20 个 Agent 和预测容器均正常完成。逐题变化为 matplotlib-20676 与 pylint-7080 转为通过，xarray-4687 转为失败。两轮各一次，不能将净增 1 题归因于取消预算。
- 20 题 usage 完整，共 7,821,852 已报告 token（输入 7,729,973、输出 91,879、缓存输入 6,796,928）及 257 次模型调用；Agent 执行时间合计约 77 分 32 秒，官方评分约 14 分 08 秒。4 题超过旧 500,000 token 阈值、1 题超过旧 10 分钟阈值，均在两轮已解决；新增解决的两题本轮 token 仍低于旧阈值。目标测试 29/39，回归测试 3454/3477。
- 五道未解决题中，sympy-20428、xarray-4687 和 pytest-7205 有目标断言未满足的直接证据。另在同一评分环境分别运行 Requests 两题的官方参考补丁，仍均未解决、评分器错误 0：requests-5414 与模型补丁失败在同一网络相关回归；requests-2317 参考补丁目标 8/8、回归 132/133，而模型补丁目标 6/8、回归 111/133，因此同时存在环境混杂与额外失败。参考对照不调整正式 15/20 分数。
- 提交前 `pnpm eval:test` 13/13、Python 手动评测回归 17/17、`pnpm build:test`、类型检查、ESLint 和 Prettier 均通过。并发 `pnpm check` 的普通测试阶段两次出现不同的时序失败；涉及的四个测试文件逐个复核 23/23 通过，完整普通测试用单 worker 复核为 581 通过、1 跳过。2026-10-05 重新检查日志确认第三次完整默认并发 `pnpm check` 实际通过（80 个文件、581 项通过、1 项跳过及构建通过），更正此前遗漏；这次重跑成功不能证明已修复当时的时序问题。没有弱化断言或把隔离复核冒称为并发套件通过。
- 完整逐题、限额对比、失败证据和参考补丁对照见本机忽略的 `.local/swebench/runs/verified20-unlimited-20261004-181603/analysis.md`，机器可读报告和正式评分在同目录。运行包 SHA-256 为 `533f26ad5933c53aa58fa2db89c95610a610ffa36ac1e18d6dca34e90378145f`；本结果仍只代表固定 20 题的一次 Linux 容器评测，不代表完整 Verified、跨平台验收或美元成本。

## SWE-bench Verified 固定 20 题手动运行（2026-10-04）

- 用户明确要求按当前仓库配置完整运行，范围为 `evals/swebench/subset.json` 固定的 20 题，每题一次。固定数据修订为 `78f471bf655a3137b2e8a75af1501690ec009ec3`、Parquet SHA-256 为 `030cfd7f2a704c4c0226e7f104c725a3b41230b1d3517f9c915ad7ea5be3fa25`；当前本地模型标识只存于忽略的运行元数据。Linux x86_64 Docker 容器串行预测，官方 swebench 4.1.0 在独立目录评分。
- **正式结果：14/20 解决，70%。** 20/20 题提交并完成评分，20 个补丁均成功应用，无空补丁或未评分题；目标测试合计 29 通过、10 失败，回归测试合计 3474 通过、3 失败。agent 状态为 17 个 completed 和 3 个 token_budget，其中两个预算停止的补丁仍通过官方评分。结果仅代表该固定子集的一次运行，不是 500 题 Verified 成绩或 pass@k。
- 正式运行 250 次模型调用，20 题用量完整，合计 7,346,748 已报告 token（输入 7,261,990，输出 84,758，缓存输入 6,504,704）；Agent 执行时间合计约 77 分 32 秒，官方评分约 12 分 17 秒。美元费用、覆盖率和多次运行方差未知。
- 运行先揭示评测审批器误认旧 `{command,args,cwd}` 契约；首轮前八题空补丁，第九题取消，其余 11 题未运行、未评分，已知额外 251,513 token，**不计入正式成绩**。增加真实 `{command,cwd}` 回归后修复。正式预测完成后，报告器遇到脱敏字符串命令参数而崩溃；增加回归后将其记为不可解析并重建报告，再以全新评分目录完成评分。
- `pnpm eval:test` 10/10、Python 手动评测回归 16/16、`pnpm eval:build` 通过。`pnpm check` 的类型、ESLint 和 Prettier 通过，但完整并发普通测试有 MCP/process-tree 时序失败；两项单独重测 13/13 通过，关闭服务测试禁用本机 UI 密码配置后 3/3 通过。未改弱断言，不能将完整 `pnpm check` 记为通过。评测容器不代表 macOS、Windows Sandbox 或跨平台安全验收。
- 完整逐题、失败分析、资源消耗与限制见本机忽略的 `.local/swebench/runs/verified20-20261004-030302/analysis.md`；机器可读报告、官方评分和逐题证据在同目录。运行包 SHA-256 为 `46e3dfef02db9b552c956f8a40a538075fb1508159377b4e2130c1bc9cd854c4`。

## Windows Sandbox 实际使用验证通过（2026-10-03，用户确认）

- **结论：Windows Sandbox 已通过用户实际使用验证，可用于日常开发。** 用户明确反馈：“windows sandbox已经可以算通过验证了，使用一段时间功能正常。”据此更新当前产品状态，不再笼统标为预览、尚不可用或仅有 harness 验证（D130）。
- 证据来源是用户在当前 Windows 环境持续使用后的确认；此前 2026-09-27 的固定账户安装态产品链路已记录普通命令、Broker Git、主动取消和正常清理通过。本次没有新增安装态测试输出，也不虚构使用时长、任务数量、系统版本、Node 版本或具体安装摘要。
- 此确认针对日常功能可用性，不等同于错误 IPC 客户端、复杂 ACL、真实 remote push/凭据/helper、强制终止、崩溃/重启恢复、资源上限等专项矩阵逐项通过；这些场景继续按具体证据记录。macOS/Linux 不因此获得 Windows Sandbox 能力。
- 默认关闭、管理员显式安装/Repair、任务实际执行模式归因、已知权限限制、Broker 宿主执行和未知结果不重放保持不变。只读 subagent 的公开门禁未由本次确认开放，仍须独立核对其就绪状态。
- 下文保留各次检查当时的结果；早期的“尚未验收”“当前不可用”不再代表当前 Windows Sandbox 日常可用性，旧 Runner/relay 的证据也不代表当前 Broker 执行边界。

## 移除 subagent 专属研究配额（2026-10-03）

- 按 D129 同步调整主工具/Worker 契约、协调器、Runtime IPC 和 SQLite：计划/通信次数、子模型轮数/时长/token、正文/上下文/报告不再附加子任务专属阈值。先添加三项容量回归并观察旧实现全部失败，再修复实现；原只读、身份、取消、恢复与发布门禁断言保持。
- 新增/更新离线回归验证六个累计计划与报告收集、二十个长问题和长消息、二十一轮研究、840,000 累计实报 token、超过 100,000 字符输入、2,000 项检查点、32,000 字符报告以及 2,000,000 字符存储；真实 Node Runtime harness 跨 Broker IPC 读取长行、提问并接收长回复。
- Windows / Node.js 26.10.0：最终独立 `pnpm check` 通过，80 个文件、581 项通过、1 项原有跳过，含类型、ESLint、Prettier 与 Web/服务端/Runtime bundle 测试构建；独立 `pnpm test:e2e` 的 Chromium 28/28 通过。仍有既有 Web bundle 大小警告。
- 中途完整并发测试曾出现未修改的 MCP 超时/目录占用、PowerShell 版本探测超时及 process-tree 安全计时器触发；前两项单独原样复验通过，最终完整检查全部通过，未放宽断言或超时。一次 check+E2E 组合命令达到工具总超时并被终止，不计作通过；之后分别执行并保存完整结果。尚未定位这些时序抖动的根因，不将重跑成功描述为已修复。
- Runtime IPC 升至 v7、Worker 消息协议升至 v3，安装副本需重建并管理员 Repair。未运行 Evaluation、真实模型、固定账户安装态或 macOS/Linux 验收；公开 subagent 门禁保持关闭。子上下文尚无自动压缩，共享 IPC 帧、主任务输出预算和模型服务容量等边界仍有效。

## Node.js 26 兼容性（2026-10-03）

- Windows 上使用 nvm 安装目录中的 Node.js 26.10.0，并以 `pnpm exec node` 确认测试子进程的版本；本轮使用工作区已有的 pnpm 12.8.1，未切换 nvm 全局选择。修改前完整 `pnpm check` 为 78 个文件、577 项通过、1 项原有跳过；Chromium `pnpm test:e2e` 28/28 通过，覆盖真实 HTTP/SSE、历史、编辑、重载与关闭。
- 新增安装器版本回归先复现 Node 26 被拒绝，扩展后通过；真实 PowerShell 只执行源文件/版本检查函数，验证 24/26 接受、22/25/27 和错误输出/非零退出拒绝，不执行账户、ACL 或 WFP 安装。最终 Node 26.10.0 与 Node 24.21.0 均通过 `pnpm check`：79 个测试文件、578 项通过、1 项原有跳过，含类型、lint、格式及服务/Web/Runtime 测试构建。
- Node 26 的 `pnpm build` 生产构建通过；`pnpm sandbox:native:build` 的 MSVC 编译、`SANDBOX_NATIVE_REGRESSION` 与 `SANDBOX_RUNTIME_DUPLEX_PROBE` 均通过。仍有既有 Web bundle 大小警告。
- 支持声明与手动 CI 矩阵已扩展至 Node 24/26；类型与 bundle 保留 Node 24 兼容基线，安装器允许两种固定 Node executable。未运行跨平台 CI、固定账户 Node 26 安装/Repair/产品链路验收或真实模型请求，未运行 Evaluation；不能把本机离线结果视为这些层次已通过。

## Skill 自动发现与按需加载（2026-10-03）

- 自动扫描项目/宿主用户的六个预设目录，主模型先接收摘要，`skill list/load` 按名称经 Broker 返回目录/正文。新增 24 项离线回归覆盖解析、优先级、无效条目、链接/硬链接、容量、版本失效、下一任务刷新、取消/失败 trace，以及宿主和独立 Node Runtime 的模型往返、DAG 阻断和历史/replay。
- 审查发现合法最大目录的 JSON 转义会超过最初的 Runtime 启动文本上限；先增加回归并观察失败，再按最多 64 项、每描述 1024 字符、最坏六倍转义扩大有界 IPC 字段。没有改变单文件、目录条目或模型上下文预算限制，回归通过。
- Windows / Node.js 24.19.0：最终 `pnpm check` 通过（类型、ESLint、Prettier、78 个测试文件，577 项通过、1 项原有跳过，以及 Web/服务端/Runtime 构建）；本次 `pnpm test:e2e` Chromium 28 项通过。修改文档的本地链接目标检查通过；构建仍有既有 Web bundle 大小警告。
- 工具读取归因为 `broker-skill/host-process`，不是 Sandbox 文件授权或脚本执行。未调用真实模型，未运行 Evaluation；未验证 macOS/Linux 或更新后的 Windows 固定账户安装态。IPC 已升至 v6，旧安装副本须重建并管理员 Repair 后另行验收。

## 本机后端 MCP 与 Windows 进程取消回归（2026-10-03）

- MCP 由本机后端使用 SDK 1.31.0 连接 stdio 或 Streamable HTTP；专项夹具覆盖工具、资源与提示模板、审批和 Runtime IPC v5 单次授权、历史/replay、超时取消、失败连接不重放、脱敏、大小限制及关闭连接。Windows UTF-8 BOM 配置先复现解析失败，再修复并通过回归。
- 完整并发测试暴露已有 Windows 关闭服务卡住问题：`taskkill /T` 尚未完成，原一秒后备定时器已杀父 shell，留下后代和输出句柄。延迟真实 taskkill 的回归先复现 pipe 挂起与 file-backed 后代仍存活；修复后等待 taskkill 明确失败才允许单进程 fallback，两种输出路径、原关闭服务断言均通过。没有放宽测试超时或降低并发；taskkill 自身故障及第三方脱离进程仍不构成完整进程树隔离保证。
- Windows / Node.js 24.19.0：最终 `pnpm check` 通过（类型、ESLint、Prettier、76 个测试文件，553 项通过、1 项原有跳过，以及 Web/服务端/Runtime 测试构建）；`pnpm test:e2e` Chromium 28 项通过。本次变更的 Markdown 本地链接目标检查通过。构建仍提示既有 Web bundle 大小警告。
- 所有 MCP 验证使用离线 stdio/回环 HTTP 和模拟模型；未调用真实模型或第三方服务，未运行 Evaluation。未验证 macOS/Linux、真实远端 OAuth/兼容性或重建后固定账户安装态；IPC v5 的旧安装副本须重建、管理员 Repair 后另行验收。MCP 为 `broker-mcp/host-process`，不得描述为 Sandbox 内执行。

## Windows Sandbox BCrypt 兼容与 Broker Git 迁移（2026-09-27，安装态复验通过）

- 安装态 native probe 显示 `bcrypt.dll` 文件打开、映射和 Load Image 均成功，但 `LoadLibraryW` 以 1114 失败；ProcMon 未显示该进程的 `ACCESS DENIED` 事件，因此尚未定位 BCrypt 内部的具体对象或 ACL。相同主机上的 `WRITE_RESTRICTED` token 变体测试中，只有加入 Everyone restricting SID 的变体使原生 BCrypt 探针成功，其他单独加入 Users、Authenticated Users、Interactive 或 Local 的变体仍失败。
- 用户选择采用 Codex Windows restricted-token 的 Everyone 兼容方式。产品 token 现包含 execution/root capability 和 Everyone；原生编译与真实 token SID 回归通过。此变更可能允许 Runtime 写入已有 Everyone 写入 ACE 且 normal-side 也允许的对象，故旧的完整写根和跨实例直接写入隔离承诺已在 D122 及使用指南中撤销。管理员 Repair 后，固定账户 restricted-token 探针中的 `cmd`、`pwsh`、Windows PowerShell 和原生 `BCryptGenRandom` 均以退出码 0 完成，原生探针的 `bcrypt.dll` LoadLibraryW 成功。
- Git 工具全部 action 已改为 Runtime 经认证 IPC 交给 Broker 宿主执行；status/add/commit 的实仓库回归及 IPC 结果形状回归通过。原生 Runtime 不再投影宿主 Git global/include 配置，旧图解析器仅供暂停的 Runner 代码使用。Repair 后 `pnpm sandbox:runtime:verify` 输出 `SANDBOX_AGENT_RUNTIME_VERIFY PASS completion=yes runtimeCommand=yes subagent=yes brokerHostCommand=yes brokerGitPushBlocked=yes cancellation=yes cleanup=yes`。这证明本机模拟模型的安装态链路，不证明真实 remote push、复杂 ACL、强制取消或重启恢复。
- 当前 Codex 中等完整性终端直接运行 `pnpm sandbox:verify` 时，WFP 枚举返回 `FwpmFilterCreateEnumHandle0(persistent) code=5`；这次非提升检查不构成规则丢失证据。用户在管理员 PowerShell 中完成 Repair，且安装态 Supervisor 自检及上述产品链路通过；完整管理员 WFP 枚举仍以 Repair/管理员 Verify 输出为准。
- 最终 `pnpm check` 通过：类型、ESLint、Prettier、70 个测试文件中的 520 项通过、1 项跳过，以及测试构建；`pnpm test:e2e` 的 Chromium 27 项通过。最终构建后再次运行安装态产品验收，全部上述阶段继续 `PASS`。

## Windows Sandbox 普通命令卡住诊断（2026-09-27，历史诊断；修复后安装态待复验）

- 最新真实会话的模型请求已于 13:02:29 UTC 返回两个 `run_command` 和一个 Git status 调用，但任务只持久化到 `tool_batch_planned`，之后无工具结果；13:04:41 Supervisor 以退出码 30 关闭，Broker 未取得可信 Runtime 终态，按 `process_unknown` 隔离并排空 generation，任务失败。Supervisor 的 `completionReported=true` 只证明其自身清理完成，不证明 Runtime 已完成任务。
- 独立的固定模型/临时工作区复现显示：安装态 Runtime 连 `Write-Output diagnostic-ok` 也未完成；同样的 Runtime/Engine 逻辑在普通 Node 子进程里能完成该命令并正确取消长命令。由此将问题缩到已安装 Windows Runtime 的普通命令路径。随后新版验收在文件编辑任务完成后，固定 `echo` 命令超时；Supervisor 的最后白名单阶段为 `command_spawn_begin`，没有子进程 PID。这将卡点缩到 Node `spawn` 调用或其紧邻的同步准备阶段，尚未证明是哪一个 Windows 调用阻塞。
- 管理员 `sandbox:recover` 已输出 `CODEATELIER_REVOKE_JOURNAL_OK count=5` 和 `SANDBOX_RECOVERY PASS`，没有手工删除授权账本。用户随后重新安装并再次 Repair，安装自检及 WFP 八条规则通过。新增安装态固定普通命令验收及只包含白名单阶段名的 Supervisor 诊断；第二轮验收先运行 Git status，也停在 `command_spawn_begin`，没有 `spawn` 返回或 PID，故不是 PowerShell 独有。两轮失败后 Broker 均完成 generation 排空；只读检查显示授权 journal 为零，仍保留一个实例和投影目录。Node 24.19.0 所用 [libuv 1.52.1 Windows pipe 源码](https://github.com/libuv/libuv/blob/v1.52.1/src/win/pipe.c)在持续收到 `ERROR_ACCESS_DENIED` 时会无界重试，因此 restricted token 下建管道失败是当前最强推断，尚无直接 Win32 错误码证据。候选修复改用实例私有 TEMP 文件承接输出并保留定时回传、64 MiB 磁盘限额和清理。本地 Node 子进程的正常输出、取消、输出持久化失败回归通过，`pnpm check` 为 70 个测试文件、513 项通过、1 项跳过；仍须更新安装副本并完成真实验收。此前缺少普通命令的 `PASS` 不能视为当前真实任务可正常运行。
- 用户安装该修复后运行固定验收：Git 任务的子进程已经启动并走到 `command_closed`，任务 clean 完成且撤销五项授权，原来的同步卡死没有复现；但 Git `rev-parse` 返回“不是可用的 Git 工作树”，使依赖的普通命令未执行，整链验收仍失败。结合专用账户与测试仓库所有者不同及 [Git `safe.directory` 规则](https://git-scm.com/docs/git-config)，当前最强推断是 Git 拒绝跨所有者仓库；尚未直接捕获该 Git 子进程的 stderr。新的只读 global 投影配置在宿主 include 之后清空继承的安全目录列表，只加入本次真实工作区路径；需再次更新安装副本并验收 Git、普通命令和后续任务。
- 安装精确 `safe.directory` 投影后的第二次验收仍在 Git `rev-parse` 处返回相同泛化错误；Git 子进程已获得 PID 并关闭，任务与授权均 clean 结束。因该错误此前丢弃了 Git 的退出码与原始输出，无法断言所有权就是原因。下一轮在工具结果中保留至多 512 字符的 Git 错误，先取得实际失败原因，再决定修复；此文本不写入日志或 trace。
- 第三轮安装态验收取得 Git 真实错误：`fatal: could not open '/dev/null' for reading and writing: Permission denied`（退出码 128）。[Git 的初始化源码](https://github.com/git/git/blob/master/setup.c)会无条件以读写方式打开 `/dev/null`；Windows restricted token 无法写入其对应 NUL 设备，`safe.directory` 不是当前阻断原因。将固定普通命令改为与 Git 独立的 DAG 节点后，第四轮同时获得两条结果：Git 仍被 NUL 拒绝，PowerShell 子进程已启动并返回，但因 `BCrypt.dll` 初始化失败（`0x8007045A`）以 .NET 未处理异常退出。两条子进程均不再卡住，Supervisor 与授权 clean 关闭；当前 Sandbox 的 Git 和普通命令仍不可用，不能宣称产品链路验收通过。

## Windows Sandbox 取消终态修复（2026-09-27，安装态复验通过）

- 用户运行安装态 `sandbox:runtime:verify`，固定任务、已安装 subagent、审批后的 Broker 宿主命令和 Broker Git push 本机拒绝夹具均完成；最后的取消断言失败。两份保留工作区的会话均显示任务 `cancelled`，但 Agent Runtime execution instance 为 `unknown`、`sideEffectsPossible=true`，账户 generation 因 `process_unknown` 隔离并排空；因此是真实终态不一致，不是断言误判。原生 Supervisor 报告 `completionReported=true`、退出码 30，但 Broker 未取得可信 Runtime 任务终态。
- 原因：取消信号在 Runtime 启动后立即关闭 Supervisor stdin，且 Broker 的 `start_task` 请求随任务 AbortSignal 提前拒绝。Runtime 很快通过 `runtime_complete` 报告取消，但 IPC 按协议不再回复已取消的 `start_task`；Broker 错过该报告并在 close 时按 unknown 隔离。修复改为保留已启动 Runtime 的 transport，先经 IPC 取消、等待 `runtime_complete` 和 `stopping`；取消后的 session 终态事件使用独立有界信号保存。超时或清理未知仍隔离，任务不会再被取消状态覆盖。
- 真实 Node 子进程回归先复现旧实现未收到 `runtime_complete`；修复后 clean 取消及时完成，原生清理返回 orphaned 的变体仍记为失败/unknown。`pnpm check` 通过：70 个测试文件、509 项通过、1 项跳过，类型、lint、格式和 Runtime bundle 构建均通过；首次全量运行中未修改的进程 UTF-8 输出测试偶发失败，单独复核及随后全量重跑通过。
- 用户在管理员终端运行 `Repair` 与 `sandbox:verify`：`SANDBOX_INSTALL PASS version=4`、`SANDBOX_INSTALL_VERIFY PASS version=4`，WFP 八条规则和账户自检通过。随后普通权限终端运行 `pnpm sandbox:runtime:verify`，输出 `SANDBOX_AGENT_RUNTIME_VERIFY PASS completion=yes subagent=yes brokerHostCommand=yes brokerGitPushBlocked=yes cancellation=yes cleanup=yes`。这证明该安装态夹具的取消路径已 clean 关闭且无 fallback/unknown；不等同于真实公网、真实 remote push 或所有平台安全阶段验收。

## Broker 宿主命令与 Git push 临时路径（2026-09-27）

- D119/D120 暂停 Capability Runner 与 Push Runner 产品入口；`run_with_permissions` 的命令/理由经 Broker 审批后作为宿主命令执行，Git push 的宿主预检、审批与执行同样由 Broker 完成。两者分别记录 `broker-command`、`broker-git-push` 的 `host-process` execution instance；旧 Runner 和 relay 的测试仍作为保留代码回归，不能证明现行路径受到 Sandbox 文件或网络限制。
- 本地 Node.js 24.19.0 上 `pnpm check` 通过：70 个测试文件，507 项通过、1 项跳过；类型、lint、格式和 Runtime bundle 构建通过。`pnpm test:e2e` Chromium 27/27 通过。定向回归覆盖已批准/拒绝的 Broker 宿主命令、Runtime push 无本地 Git 预检、Broker Git 启动后取消及 IPC 调用 ID 契约。
- 当时 Codex 进程不是提升的管理员 token，尝试从该进程启动 Windows UAC Repair 未进入安装脚本，因此该阶段未能更新安装副本。用户随后在管理员终端完成 Repair；安装态验收结果见上节。本地不可用端口夹具通过仍不代表真实远端 push、凭据或 hook/helper 兼容性通过。

## Windows Sandbox 普通用户启动自检（2026-09-27，进行中）

- 固定账户安装与管理员 `sandbox:verify` 已通过，但普通终端的 `sandbox:runtime:verify` 在第一个任务发现 `runtime_self_check` 启动前 fallback；模拟任务在宿主创建了标记，脚本正确拒绝将其计为 Sandbox 成功。保留的会话事件明确记录 `host-process-fallback`、`sandboxApplied=false`、`sideEffectsPossible=false`。对已安装 WFP manager 做只读普通用户复核，`FwpmFilterCreateEnumHandle0` 返回错误 5；因此不能用管理员校验通过推断普通用户 Broker 可以完成同一枚举。
- 产品 WFP manager 改为给安装用户对固定 provider、sublayer 和八条固定 key filter 授予对象级 `FWPM_ACTRL_READ`，保留既有 ACL；普通用户自检按 key 读取并核对规则形状，不修改全局 filter 容器 ACL。管理员 `sandbox:verify` 仍枚举 provider 下全部 filter 并要求恰好八条。用户重装后，管理员 `sandbox:verify` 通过，普通用户运行已安装 WFP manager 的 `--wfp-persistent-attest` 输出 `PASS filters=8`。
- 继续只读运行新版 Supervisor 自检，发现下一处失败为 `account_rights`；细分诊断确认普通用户 `LsaEnumerateAccountRights` 返回 Win32 错误 5，管理员验证则通过。安装器现只在专用账户 LSA 对象的原 DACL 上增加安装用户 `ACCOUNT_VIEW`，保留原 ACE；不改变 LSA policy ACL，也不授予账户权限写入。再次提升重装后，普通用户已安装 Supervisor 的 `--self-check` 输出 `CODEATELIER_SELF_CHECK_OK`。
- 随后普通用户 `sandbox:runtime:verify` 两次均未完成：系统弹窗报告 Supervisor 启动错误 `0xc0000142`。保留会话中有一次仍为 running，另一次因清理结果未知而失败；安装目录留下 5 个授权 journal。首次管理员 `sandbox:recover` 在撤销 journal 时返回 70。逐个只读核对发现 5 个目标仍存在且卷/file ID 与 journal 一致，账户直接 ACE 仍在；真实原因是恢复入口把合法 journal 标志 4/5/6 送入只接受普通撤销标志 0/2 的解析器。修复后原生回归覆盖两种输入模式，使用新版 Supervisor 定向撤销输出 `CODEATELIER_REVOKE_JOURNAL_OK count=5`；复核 journal 为 0，五个目标的账户直接 ACE 均为 0。用户再次运行管理员 `sandbox:recover` 输出 `SANDBOX_RECOVERY PASS`，清除固定账户和 8 条 WFP 规则。
- 启动失败的代码路径只创建了私有 desktop，未为目标账户提供对应 window station 的访问权。[Microsoft 的跨账户进程启动文档](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw)要求两者都可访问；这是与 `0xc0000142` 相符的原因推断，仍需重新安装后的真实跨账户测试确认。Supervisor 后来改用系统命名的非交互式 station，在持锁状态下增加实例 SID；普通用户本机探针以当前用户兼作账户，通过单次及四个并发测试，但未覆盖真实专用账户 SID。
- 用户重新安装后，普通用户运行已安装 Supervisor `--self-check` 输出 `CODEATELIER_SELF_CHECK_OK`；接着 `sandbox:runtime:verify` 的首个任务完成但被断言拒绝。保留会话明确记录 `host-process-fallback`，安装目录的授权 journal 与实例文件均为零。受控复现的安全诊断显示原生 Supervisor `exitCode=71`、`rollbackReported=true`、`stage=account_ace`：系统命名 station 已存在，其实际 DACL 缺少专用账户 ACE，创建参数中的 DACL 未替换现有对象的 DACL。修复为先核对 station 名称不是 `WinSta0`，再在跨进程锁内补齐账户和实例 SID；新 OS 探针用两个不同账户替身 SID 依次打开共享 station，核对第二个 SID 的显式 ACE，以及不同 desktop、宿主 station 恢复与 USER32 子进程启动，输出 `SANDBOX_WINDOW_STATION_PROBE PASS`。这仍不是专用账户启动成功的证据，待重新安装后复测完整 Runtime。
- 管理员 `Repair` 安装了前述修复并通过安装验证；普通用户已安装 Supervisor `--self-check` 再次通过。随后首个 `sandbox:runtime:verify` 仍回退，日志从先前的 `stage=account_ace` 变为原生退出 72、`rollbackReported=true`，没有 station 错误记录；授权 journal 和实例文件仍为零。这说明已越过前一个 station 拒绝点，但不能仅凭退出码判定是 Runtime 未连接 pipe 还是连接后的身份校验失败。新增只记录固定阶段/数字码的原生诊断。代码审查还发现 Runtime pipe 仅授予账户 SID，而 Runtime token 使用 `WRITE_RESTRICTED`；按 [Windows 受限 token 的访问检查](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens)与 [Named Pipe DACL 规则](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)，写入连接可能被 restricting SID 检查拒绝，因此仅对任务专属 Runtime pipe 补授 execution SID，bootstrap pipe 不变。原生回归核对两条 pipe 的 DACL 形状；此原因仍是推断，需重新安装并以真实账户验证。
- 下一次管理员 `Repair` 与安装验证通过后，普通用户验收仍在首个任务回退。保留日志给出原生退出 72、`rollbackReported=true`、`proxyStage=connect_wait`、`proxyWait=1`、`proxyBootstrapExitCode=1`：Supervisor 等待连接时，Node Runtime 已先退出。代码核对发现 Supervisor 用 `StringFromGUID2` 生成 `{GUID}` 后缀，而 Runtime 校验器只接受不含花括号的后缀；校验发生在 `net.createConnection` 之前，能够直接解释这次退出。回归先让带花括号的本机 pipe 名在校验和真实 Node 命名管道启动用例中失败，再允许原生 GUID 格式并验证两项通过，同时继续拒绝远程及畸形 pipe 名。该修复仍需更新 Runtime 安装包并在专用账户下重新验收；不能把普通用户回归视为已完成产品链路。
- 更新 Runtime 安装包后的下一次首任务已能连接 pipe，但仍被 Supervisor 以 `proxyStage=identity clientStage=job clientWin32=0` 拒绝，退出 72 且报告完整回滚。身份检查原先为 Job 核对按 PID 调用 `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`；受限账户创建的进程使用其 token 默认 DACL，未显式授予普通宿主 Supervisor 重新打开权限。当时尝试向安装者 SID 授予 Runtime process 的查询权限和 restricted token 对象的 `TOKEN_QUERY`，原生 ACL 回归及普通用户受限 token 探针通过，仍须在固定账户下复测。
- 用户再次提升 `Repair` 后，首任务仍以 `proxyStage=identity clientStage=token clientWin32=5` 失败，原生退出 72、`rollbackReported=true`，授权 journal 与实例文件均为零。Job 检查已通过，失败发生在 Supervisor 对另一账户的 Runtime 调用 `OpenProcessToken`；[Microsoft 文档](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocesstoken)要求调用方为此启用 `SeDebugPrivilege`，单独的 token DACL 查询 ACE 不足。现撤回上一候选 ACL 扩权，改由已核对 PID 的固定账户 bootstrap 在原有私有管道交付其创建 Runtime 时持有的进程/token 句柄值；Supervisor 用 `DuplicateHandle` 仅复制 `PROCESS_QUERY_LIMITED_INFORMATION`/`TOKEN_QUERY`，将连接 pipe 的实际 PID 与该进程句柄、Job、SID、映像和创建时间联合核对，不给宿主提升调试权限。MSVC 构建、原生状态回归和真实普通账户跨进程句柄传递探针通过；这仍不证明固定账户下的产品链路，需更新安装包后重跑 `sandbox:runtime:verify`。
- 用户更新安装后，Supervisor 与构建文件 SHA-256 一致。固定工具任务首次进入 `windows-sandbox-user/running`，说明此前的跨账户身份拒绝已越过；但约 30 秒后仍未出现模型或工具事件，Supervisor 退出 72，Runtime 入口报告固定 `STARTUP_FAILED`，任务记为 `unknown` 且 `sideEffectsPossible=true`。Broker 随后报告 generation 排空成功；只读检查受保护安装区的 grants/instances 没有文件，验收工作区只有 seed 文件、没有目标标记。新开临时工作区复现相同结果。当前无法从单一失败标记判断入口是卡在启动描述符还是 IPC 握手，因此增加不含身份材料的入口和代理首帧阶段诊断；同时新增回归先复现“畸形启动帧后入口保留 pipe 直到超时”，再修复为失败时销毁 socket 并立即退出。新版原生首帧经 Node 解析夹具验证格式和固定字段匹配，固定账户的下一次验收仍待安装更新。
- 下一次固定账户验收继续失败，但新增阶段明确显示 `entryDescriptorAccepted=true`、`runtimeFrameRead=true`、`brokerFrameWritten=true`、`brokerFrameRead=true`、`runtimeFrameWritten=false`、`entryHandshakeCompleted=false`。即 Runtime 已解析首帧并发出 hello，Broker 已收到并回复，Supervisor 却未把回复写回 Runtime。独立真实 Named Pipe 探针先以同一同步句柄上的待决读取与写入复现超时，再把任务 pipe 改为 `FILE_FLAG_OVERLAPPED`，连接、首帧和双向代理均使用带独立事件的 overlapped I/O；同一探针改后在预连接和等待连接两种顺序下通过，重复五次通过。此修复符合 [Microsoft 的并发管道 I/O 说明](https://learn.microsoft.com/en-us/windows/win32/ipc/synchronous-and-overlapped-input-and-output)，但只证明本机双向传输，不等于固定账户产品链路已经完成；仍需更新安装副本后重跑显式验收。
- 修复安装副本并重新运行后，固定工具任务确实在专用账户 Runtime 内完成，但验收发现其 `completed` execution instance 丢失先前已核对的 PID、创建时间与账户 generation 摘要；旧断言据此拒绝成功。增加先失败的 Engine 回归后，终态事件继承该进程身份。下一次 `sandbox:runtime:verify` 已通过固定工具与已安装 subagent 阶段，停在独立 Capability Runner：受限 `pwsh.exe` 在执行命令前因 `BCrypt.dll` 初始化失败而退出 82，任务未完成，工作区与日志保留在 `.local/sandbox-runtime-verification`。切换至 Windows PowerShell 5.1 仍在 CLR 启动时失败。
- Process Monitor 捕获显示受限进程成功读取并映射 `C:\Windows\System32\bcrypt.dll`，仅记录到 `.NET` 诊断命名管道的 `ACCESS DENIED`；不能据此断言管道就是加密初始化失败的原因。独立 token 探针在产品同类 `WRITE_RESTRICTED` restricting SID 下复现 `LoadLibraryExW("bcrypt.dll")=1114`，用同类 token 与默认 DACL 启动真实子进程也复现；移除 `LUA_TOKEN` 或 `DISABLE_MAX_PRIVILEGE` 均不改变结果。加入 `Everyone` 或 `SYSTEM` 可让探针通过，但会扩大写检查可命中的对象，违反 D101 的实例写入边界，因此未修改产品 token。失败后的管理员 `sandbox:verify` 再次通过：8 条 WFP 规则、自检与安装版本 4 均正常。完整 W3--W6 验收仍未通过。

## Windows Sandbox 安装状态端口回归（2026-09-27）

- 固定账户首次提升安装在 WFP 规则写入后由 Supervisor self-check 以退出码 71 拒绝；安装脚本随后报告删除 8 条规则并完成账户、权限和安装目录回滚。代码检查发现安装 state 已升至版本 4，而 C++ 仅对版本 2 解析 relayPortV4/V6，导致版本 4 自检使用端口 0。
- 原生构建新增直接调用产品状态解析器的版本 4 夹具，核对两个 relay 端口并拒绝无效端口；旧代码下 `SANDBOX_NATIVE_STATE_PARSE FAIL`，修复后 `PASS`，MSVC 原生构建通过。`pnpm check` 在允许正常子进程清理的环境通过：70 个测试文件、505 项通过、1 项跳过，类型、lint、格式和测试构建均通过。外层受限环境的首次运行有既有 shutdown 用例超时及 SQLite `EBUSY`，未修改产品语义或测试断言。
- 该次修复之后的提升环境验收进展见上节；原生构建或普通测试本身仍不能证明固定账户端到端成功。

## Compact 契约与容量验收（2026-09-26）

- 按 D115 移除每类结论/每条来源的 20 项上限、总摘要 4000/8000 字符限制及固定压缩比例；prompt 对齐保留的 JSON、单条文本与来源检查。完整输入必须符合实际预算并确实减少，用户原文、未知状态和原文快照继续保留。
- 新增 13 项回归，先在旧实现复现数量/字符与 60% 目标拒绝，再验证长摘要、多来源、小幅压缩、超容量/无收益拒绝及普通/强制保底。此前失败的已保存摘要含 33 个来源，在新 schema 下离线复验通过；未重新调用真实模型或改写用户历史。
- Windows Node.js 24.19.0：类型、lint、格式及测试构建通过。沙箱内 `pnpm check` 的 shutdown 用例超时；提权后并行全量仍触发该用例等待命令 ready 的超时，未修改断言或超时时间。提权运行 `pnpm test --maxWorkers=1` 完整通过 70 个文件、495 项测试，1 项平台跳过；修改前版本的 shutdown 对照在提权后也通过。
- 提权运行 `pnpm test:e2e`，Chromium 27/27 通过，包含压缩提示、续聊与原历史刷新；前端和 Runtime bundle 构建通过。未执行 Evaluation、真实模型摘要质量测试或固定账户 Sandbox 验收。

## 前端长对话增量投影（2026-09-26）

- 时间线聚合移至连接层，新事件按 ID 去重后逐个处理；工具状态使用调用/批次索引，旧输出、无 batch 匹配、重试 attempt、编辑进度和已完成任务折叠保持兼容。统计时钟不扫描历史，滚动复用高度前缀和并二分定位。仅涉及浏览器展示计算，不改变模型输入、工具执行、审批或持久化。
- Windows / Node.js 24.19.0：`pnpm check` 通过，69 个测试文件、481 项通过、1 项平台跳过，包含类型、lint、格式及测试模式构建。Chromium 全套 `pnpm test:e2e` 27/27 通过；最终组件缓存另定向复核统计、虚拟列表、压缩历史、重试和长历史重连。
- 外层受限执行首次出现既有关闭用例超时/SQLite EBUSY，以及浏览器用例通过但测试服务未退出；核实并清理本次测试进程后，在允许子进程清理的环境中重跑通过，未放宽产品关闭逻辑或测试断言。

合成计算基准以 `6dd99a8` 的时间线投影为对照，每个工具构造开始、状态、输出和结果等六类事件；预热一次后取五次测量中位数。旧路径每次重新构建完整时间线，新路径首次建立索引后追加一个 delta；同时核对条目、工具状态和输出卡片等价。耗时包含前端纯数据计算，不包含网络、DOM 布局、Markdown 渲染或模型执行。

| 历史事件数 | 旧时间线每次投影 | 新视图首次投影 | 新视图追加事件 |
| ---------- | ---------------- | -------------- | -------------- |
| 3,000      | 4.61 ms          | 1.21 ms        | 0.28 ms        |
| 12,000     | 70.02 ms         | 3.63 ms        | 0.56 ms        |
| 50,000     | 4,169.67 ms      | 31.01 ms       | 4.32 ms        |

浏览器合成用例加载 12,001 个事件，最终窗口挂载 10 个时间线节点，首次可见约 1.6 秒（包含测试请求和浏览器等待）。该用例验证滚动、输入、真实 EventSource 重连及游标去重；单元回归在 3,000／12,000／50,000 事件后禁止重读旧正文，并在 50,000 项布局上限制二分索引访问次数，不以机器相关毫秒阈值作为唯一断言。

限制：初次打开仍下载完整历史；每批发布仍复制事件引用/索引并检查展示条目，不宣称所有更新均为 O(增量)。这是合成 Windows/Chromium 结果，未据此推断真实长任务端到端提速或 macOS/Linux 表现。未运行 Evaluation。

## 可选只读 subagent 内部接线（2026-09-23，尚未对外开放）

- 宿主 Engine 与独立 Node Runtime 子进程 harness 已分别使用真实 SQLite、Worker thread 和模拟模型完成结构化分工、受限读取、等待、收集、原子反馈及线程退出；来源文件未被子任务修改。子模型 usage 在会话统计中单独归类。Worker 双向 postMessage 已核对固定版本、taskId/subagentId 和序号，跨任务伪造的父模型回执使子任务失败，不会被用于完成报告。存储和协调器回归复现并修复晚完成报告误消费、读结果持久化失败后仍进入下一轮、等待不响应取消和消息队列无界的问题。
- Runtime IPC v3 固定子身份与请求、拒绝伪造的写工具/模型用途、按认证执行实例持有全局 Worker lease；断连不预先归还，只有进程实例确认 clean 后对账。Windows bundle build manifest v3 增加独立 `subagent-worker.mjs`；TypeScript/C++/PowerShell 安装 state v4 要求其摘要，旧版本自检失败后按已有启动前安全回退条件处理，不冒称受 Sandbox 保护。已运行 TypeScript、PowerShell 语法、无管理员副作用的 Node harness、Runtime bundle/MSVC 构建与相应回归；具体最终全套测试结果另以本轮提交前检查为准。
- Web/HTTP 接线已预置但 `SUBAGENT_PUBLIC_READY=false`：bootstrap 不展示勾选，Engine/HTTP 同时拒绝直接开启；模拟 bootstrap 就绪只验证浏览器草稿、一次性请求与被拒后不丢输入，已标记的历史任务/子状态可从 Snapshot 重建并在刷新后回读。Host/Runtime 子状态写入后的 SSE 刷新经两条内部路径回归。Windows `pnpm check` 本次增量最终运行 68 个测试文件、448 项通过、1 项平台跳过，类型、lint、格式、前端/Runtime bundle 构建通过；Chromium E2E 26/26 通过且正常退出。首次全量运行中 `shutdown` 用例超过 15 秒并在超时清理时遇到 SQLite EBUSY；未改弱断言，隔离复测 3/3 及再次全量检查均通过。
- 重启恢复新增真实 SQLite 回归：中断子任务的未知模型请求仍为 `unknown`，人工恢复继承已保存的开关、重新读取当前文件，不重建旧 Worker，也不盲目重发模型请求。手动 `pnpm sandbox:runtime:verify` 增加已安装 subagent Worker 的计划/只读读取/报告消费/trace/清理阶段；本轮仅完成代码、类型检查、离线 harness 与构建，**未执行该显式产品验收**，不得据此声称固定账户验收成功。
- Tracing 补足主代理显式 `message`/`cancel` 子任务动作的固定 start/end span；Coordinator 回归验证消息计数与取消终态，Runtime IPC 协议回归只接受已登记子 ID 属性的固定事件名，拒绝包含正文的 frame。`pnpm check` 再次完整通过：68 个文件、448 项通过、1 项跳过；固定账户产品验收仍未执行。
- 子 Worker 新增取得活动租约后的 120 秒运行上限及服务实报累计 32,000 token 上限；超限记录 `failed`、保留最后一轮已落盘结果，确认退出后才归还租约。模拟慢模型与超额 usage 的回归覆盖终态和不重放；无 usage 时沿用 12 轮/100,000 字符备用边界。Windows `pnpm check` 本次通过 68 个测试文件、450 项通过、1 项跳过及前端/Runtime bundle 构建；未运行真实账户或外部模型验收。
- 子任务与主代理的受限提问链路：`ask_main` 只发送有界问题，Store 原子记录事件/回执，重复问题 ID 返回原回执，冲突或第九个新问题被拒；`await` 提前交付至多四条待答问题，只有主代理可用关联的 `message(replyTo)` 回复原提问的子任务。Worker 消息协议 v2、Runtime IPC v3 固定问题 action 与无正文 trace、Host/独立 Runtime stdio harness、历史页面纯文本及恶意 HTML 渲染回归均通过；不提供任意子任务间直连。本轮 Windows `pnpm check`：68 个文件、454 项通过、1 项平台跳过，前端和 Runtime bundle 构建通过；Chromium E2E 26/26 通过。已安装 Worker 的摘要变化仍需用户在真实提升环境 Repair 后手动运行 `pnpm sandbox:runtime:verify`，本轮**未执行**该产品验收，发布门禁保持关闭。
- **限制**：本轮没有对真实专用账户执行提升安装、更新 WFP 或写持久 ACL，亦未验证固定账户下子 Worker 的真实 Job/映像/取消、故障恢复和跨平台行为。Worker 与主线程共享 OS 身份，工具白名单不是恶意代码防护；HTTP/UI 仍拒绝启用 `subagentsEnabled:true`，不能把内部 harness 或原生编译通过表述为产品可用。

## 仓库审查与高优先级修复（2026-09-23）

修复文件新建竞争覆盖、历史分片取锁失败残留事务，以及进程持久化回调/管道异常逃逸。复现、修复和边界见 [本轮审查记录](repository-review-2026-09-23.md)。Windows 最终 `pnpm check` 通过：421 项通过、1 项跳过，类型/lint/格式/构建通过；Chromium E2E 23/23 通过且正常退出。未运行 Evaluation 或真实模型，未完成固定账户原生端到端验收。

以下保留从 2026-09-07 起积累的历史记录；后续条目按各自日期补充。早期状态不代表当前结论，Windows Sandbox 日常可用性以本文开头的 2026-10-03 用户确认为准。以下区分实际验证和计划覆盖，不将构建成功等同于跨平台运行成功。**Windows 专用用户 Runtime 的产品代码、受保护 bundle、安装器、ACL/Job、持久 WFP、journal、CONNECT relay、默认 Supervisor launcher 和联合身份 Named Pipe 已接入，但尚未完成固定账户提升环境端到端验收。AgentRuntimeService 与模型/session/审批 adapter 已在独立 Node 子进程 harness 通过；结构化 PushSpec、独立 Push Runner 和 Agent Runtime 阻塞等待链已接入应用代码，但真实安装下的错误 pipe 客户端、取消/恢复及 remote push 矩阵仍未验证。WSL2 与 restricted-token demo 仍只是历史或局部证据。代码存在、stdio 跨进程测试、单测或 native build 通过都不能扩展成 W0--W6 完成或跨平台 Sandbox 能力。**

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

- 2026-09-27 起暂时关闭 push 和 pull request 自动触发；`Checks` 工作流仍可在 GitHub Actions 页面手动运行。此期间的提交不能视为已有跨平台 CI 验证。
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
- D106 将 Sandbox 内工具审批边界改为“已有能力免审批、越界命令统一申请”：`run_command` 在 Agent Runtime 内不再调用 approval adapter；普通文件工具解析到授权根外时拒绝。新增严格 `run_with_permissions` 工具与两阶段 IPC operation，携带命令、最多 16 个递归只读根、16 个递归可写根、一个 HTTPS host、理由和 `toolCallId`。Broker 先重新规范化并沿用现有低成本模型三级审批，返回连接内一次性 authorizationId；Runtime 取得 Tool worker 槽后才消费授权并以独立 `capability-runner`、AccessManifest、Job 和 host-bound relay lease 执行，明确禁止宿主 fallback，且不以宿主 token 运行 LLM 命令。调度回归确认审批等待不占 worker 槽、无依赖工具可先执行、依赖节点仍等待；IPC 回归确认准备阶段无执行副作用且授权只可消费一次。任务 tool trace 按现有规则保存经密钥脱敏的完整参数；Sandbox 生命周期 trace 仍只记录安全摘要。短期 proxy token 仅进入 capability runner 环境，Push Runner 仍经 askpass 且可读取 WinCred。应用层 schema/adapter、真实 Runtime 子进程审批与结果返回、DAG 并行、重叠 lease、根投影和无审批普通命令回归已通过；固定账户真实 ACL、通用 HTTPS client、取消/unknown 清理及代理凭据生命周期尚未提升验收，不能据此宣称 W4/W6 完成。
- Agent Runtime 的 context tracing 不再止于 Broker 外围模型和工具 span：Runtime 对 `context.prepare`、`context.request` 及两个预算计量子阶段发送严格 trace span event，Broker 按 Runtime span/parent ID 重建 `Main thread` 父子 slice，并在断连时把未闭合 span 标为 cancelled/error。协议只接受四个固定名称以及 step/attempt/force/inputItems/toolCount/amount/errorName 有界字段，任意名称或自由文本属性会关闭连接。真实 Node Runtime 子进程回归核对四对 begin/end slice，IPC 回归核对非法 trace 事件拒绝；这完成应用层跨进程 context tracing 接线，不替代 Windows Named Pipe 身份验收。
- 共享账户 ACL 账本补齐 read/write 跨模式并发：grant key 改为稳定对象身份，同一对象不会因两个实例用途不同而重复安装账户 ACE 或被其中一个实例提前撤销。原生账户 ACE 统一提供 normal-side 读写候选权限，真正写入仍需该实例独有 capability ACE 与 `WRITE_RESTRICTED` token 同时允许；实例退出继续只撤销自己的 capability ACE，Broker 最后引用才通过 journal/revoke 移除账户 ACE。回归还证明已失败 grant 的后继 acquire 在改变引用前拒绝，不留下无 active lease 的幽灵引用。TypeScript 状态机测试和 MSVC 构建只能证明编排与可编译性，固定账户真实跨模式 ACL 仍属于 W2 提升验收。
- 最后共享引用的撤销不再只依赖原路径：supervisor 先按路径打开并核对卷/file ID；路径已被替换或同卷 rename 时，改用卷句柄与 `OpenFileById` 按持久 journal 的 64 位 file ID 重开，再次复核对象类型、reparse 标志、卷序列号与 file ID 后才移除账户 SID ACE。新路径对象不会被误改，原对象无法定位仍返回 cleanup unknown 并隔离 generation。MSVC `/W4 /WX` 构建通过；尚未以提升夹具实测目录/文件 rename、挂载卷、删除重建及服务重启恢复矩阵。
- CONNECT relay 的 DNS 结果检查补齐 IPv6 特殊路由：只接受 `2000::/3` 普通全球单播，并额外拒绝 Teredo、benchmark、ORCHID、文档和 6to4；NAT64 等不在全球单播前缀的转换地址也拒绝。IPv4 mapped 地址继续回到 IPv4 私网分类。13 项地址/relay 回归不访问公网，覆盖 loopback、link-local/metadata、ULA、mapped metadata、Teredo、6to4、NAT64、文档地址和正常公网样例；真实 DNS64、多地址 rebinding 与公网 CONNECT 仍需 W5 提升/网络环境验收。
- Runtime IPC 应用握手改为严格顺序：Broker 收到匹配的 `runtime_hello` 前，任何 request 或 event（不只 trace）都会立即关闭整条通道，不再允许先改变 ready/cancel 状态或取得普通错误响应后继续握手；observer 的语义异常也统一转成通道失败而不是未处理 Promise rejection。10 项 IPC 回归覆盖错误 nonce、握手前 ready、observer 异常、畸形帧、取消竞态和连接继续使用；Windows transport 身份错配仍需 W3 提升矩阵。
- Runtime 的 session 写入不再接受任意事件名：协议只允许 Agent Runtime 实际产生的模型、上下文、工具输出/状态、diff 和子进程 PID 事件；`execution_instance`、`sandbox_stage`、fallback/warning 和 `task_end` 等 Broker 专属审计事实无法经 Runtime IPC 构造。schema 回归同时确认正常 `tool_result` 保持可用；事件 payload 仍受 8 MiB 帧上限和 Broker 统一凭据脱敏，不把 Runtime 事件当成独立安全证明。
- Agent Runtime 已启动后若 IPC 断开或协议错误导致 Broker 未取得可信任务终态，Engine 现在以 `unknown` 关闭 launcher 并记录 `sideEffectsPossible=true`；SandboxBroker 即使确认 native Job shutdown clean，也不会正常释放并复用 lease，而是隔离 account generation、调用整代 drain 并返回 orphaned。正常 Runtime 报告的失败仍可 clean release；可证明清理完成的主动取消记录 `cancelled`，同时保留可能已发生副作用。应用层回归覆盖 clean native shutdown 也不得掩盖未知工具结果；真实 supervisor 断连/崩溃注入仍待提升环境验收。
- Push Runner 的取消审计与 Capability Runner 对齐：一旦收到进程启动回调，随后即使 Job/ACL/代理均 clean release 并归类为 `cancelled`，execution instance 仍记录 `sideEffectsPossible=true`，因为远端可能已接收对象或完成 ref 更新。启动前取消保持无副作用；应用层回归覆盖 started cancellation，真实 remote 的中途取消仍待 W5/W6 提升环境验收。
- Supervisor 增加带固定错误码的 clean timeout 结果：只有 native 已确认 Job 终止且未报告 cleanup failure 时，Broker 才按受控停止撤销 ACL、提交 lease 并清理私有目录，不再把其它健康实例一并 quarantine；超时调用自身仍失败并由 execution instance 保留可能副作用。cleanup exit 70/控制帧、ACL revoke 或私有目录清理失败仍升级为 unknown/orphaned 与整代 drain。编排回归已覆盖两条分支，真实强制墙钟终止与后代清理仍待 W6 提升环境验收。
- 常驻 Agent Runtime launcher 现与命令/Runner 路径使用同一 per-instance 状态事实：联合身份启动成功后写入 `sandboxed/applied=true/level`，无可信终态或清理失败写入 `unknown`，启动前完整回滚写入 `host-process-fallback`。Engine 同步发出 `sandbox_stage`，Web 当前会话徽标不再停留在进程启动时的全局 `unknown`。回归覆盖成功、fallback 和 unknown 状态；并发会话仍只展示用户当前打开会话的最新事件。
- 本轮 Sandbox 收尾在宿主权限完成 `pnpm check`：52 个测试文件、343 项通过、1 项按平台跳过，TypeScript、ESLint、Prettier 与 production/runtime bundle build 全部通过；Chromium E2E 23/23 通过。`pnpm sandbox:native:build` 以 MSVC C++20 `/W4` 成功生成 Supervisor 与产品 WFP manager，后者对实验参数 `--ipc` 输出固定拒绝并以 2 退出。上述结果证明代码、协议和无管理员副作用编排闭环，不替代固定账户提升安装、真实 ACL/WFP/CONNECT/remote、强制取消、崩溃与重启恢复矩阵。

## 2026-09-21 Sandbox 审查修复验证

- 15 项审查问题已落实到实现、回归或文档：跨会话 compact、审批对象身份、失败回滚证明、Job 分配失败、grant acquire/revoke 互斥、provision waiter 失败/取消、relay 首次启动与 socket 生命周期、Git global 优先级、execution instance 恢复关联、fallback 事件及实际安装说明均已修正。产品 WFP verify 现在从受保护 state 取得账户和 V4/V6 relay 端口，逐条核对八条持久规则的账户 security descriptor、layer、action、weight、地址、端口、raw flag 和唯一形状，而非只计数。
- 当前 Codex Sandbox 中，TypeScript、ESLint、Prettier、production/runtime build 均通过；排除已确认被外层 Sandbox 阻止 `taskkill /T /F` 的 `shutdown.test.ts` 后，52 个测试文件为 349 项通过、1 项平台跳过。该关闭用例实际诊断得到 `taskkill` 的 `Access denied`，未修改产品逻辑或弱化断言。Chromium 23/23 用例均完成通过，但外层 Sandbox 同样阻止 runner 正常收尾，因此人工终止等待进程，不记为干净的 `pnpm test:e2e` 退出成功。
- `pnpm sandbox:native:build` 以 MSVC C++20 `/W4` 无警告生成 Supervisor 和产品 WFP manager。没有运行 Evaluation，也没有提升安装或修改专用账户、WFP、持久 ACL；原生撤销失败、Job 失败、askpass 卡死、损坏/替换 WFP 规则及异常终止仍须在固定产品账户环境做故障注入，故不能据本轮结果将 W3--W6 标为平台验收完成。

## 已移除工具的历史回归记录

以下记录从测试说明迁入，仅用于保留历史，不代表当前工具接口。

- 文件名命中恰好填满第 100 个搜索结果后，仍继续追加内容命中，返回 101 条。该内置 `search` 已移除；历史记录继续可展示和归档，新的代码搜索改走受审批的命令。

## Sandbox 组件探针历史记录

以下保留从测试说明迁入的阶段记录，原文中的“当前”“尚未实现”和“更新”均指各次探针阶段。现行状态与验收门槛见 [Windows Sandbox 架构](windows-integrity-sandbox.md)。

测试清单不等于穷尽所有输入或保证没有缺陷。当前 Windows WSL2 `inspect` 仅有历史的 bubblewrap 只读绑定与基本命名空间/环境夹具；restricted-token 和网络/IPC demo 也只是被 Codex 外层 Sandbox 明确区分的局部证据。专用账户动态 `ALE_USER_ID` V4/V6 TCP 回环 fence 的管理员矩阵已通过：宿主不受影响、专用账户每个地址族只通获准端口、其它端口返回 `WSAEACCES`；相同结果也由 restricted Runtime 的直接网络后代复现。dynamic engine 关闭后同一账户的两个地址族均恢复连接，账户和目录清理为 0。扩展运行进一步证明 UDP 拒绝端口在普通及 restricted 后代中均无法收到 ACK，V4/V6 listen 也在两条路径中均返回 `10013`；TEST-NET TCP 的初始 `10035` 和仅创建 raw socket 都不能作为最终结论。allow 已收紧为 loopback 地址加端口，并以本机真实非回环 IPv4 listener 和 raw bind 建立正反基线；完整动态与持久生命周期结果见下。目标架构的一次性提升安装、单一专用账户、并发 instance lease/grant table、显式 ACL 投影/撤销、精确 Git config 图、Runtime 身份、Broker IPC、产品持久 WFP fence、真实 Git 配置下的 host 级网络边界、认证 relay/credential pipe、短期凭据、Job 后代清理、kind-specific executionInstance、资源限制及外部写入仍须分别实现和验证，不能由探针结果替代。该 profile 明确允许同账户并发任务读取、终止、注入或检查其它活动 Runtime/授权根，也无法保护既有公共 ACL 对象的机密性；不同对话不是彼此的安全边界。每实例 capability 只承诺经验证的直接及后代文件写入限制，不保证 Git 配置/hooks/helper 无副作用或仓库 path/ref 级网络边界。能力声明须分别对应 W0 安装、W1 身份/网络、W2 文件/监督、W3 Broker IPC、W4 本地 Runtime、W5 受限 push 和 W6 取消/资源边界，不能用较早阶段推断较晚能力。另仍未进行断电/磁盘损坏恢复、真实模型质量统计、全浏览器矩阵、其他平台 OS 级 sandbox、访问密码抗暴力破解评估或长期压力测试。应用层权限和单一密码门禁都不是系统沙箱或公网安全保证；不得将通过现有测试描述成上述能力已经验证。

更新：上述“完整提升运行仍待取得”已由后续管理员结果取代。动态 WFP 扩展矩阵现已完整通过 TCP、带 ACK 的 UDP 回环交付、真实本机非回环 IPv4、V4/V6 listen/raw bind、普通账户与 restricted 后代，以及正常关闭/强制终止清理；临时账户和目录清理为 0。持久 WFP 探针的进程退出后存续、枚举自检、核心 fence、卸载恢复与幂等清理也已通过。尚未完成的是产品安装器/升级/重启/篡改/故障恢复，以及真实 DNS、非回环 UDP、UDP 入站、ICMP、组播/广播等剩余路径。

持久生命周期手动夹具已在管理员环境完整通过：预清理 0 条、事务安装 8 条、安装进程退出后枚举自检 8 条；V4/V6 获准连接成功，其它连接、listen 和 raw bind 均以 `10013` 拒绝；卸载删除 8 条，自检按预期失败为 0 条，原拒绝端口恢复；`finally` 再次幂等清理 0 条。只读复核确认临时账户和目录为 0。BFE/机器重启、篡改修复、重复安装、版本升级、故障注入和卸载中断仍未覆盖。

独立恢复脚本的 AST、嵌入 C# 编译和 `-WhatIf` 已通过；它分页枚举 filter 快照，只选择固定 provider 后删除 filters、sublayer/provider，并把账户/目录清理限制为 `CAPersist[8 位十六进制]` 与仓库内 `persistent-run-[32 位十六进制]`。生命周期夹具已验证同算法的原生清理器能删除真实持久对象并重复清理空状态，但嵌入 C# 恢复路径对真实对象的删除、部分对象缺失、删除失败和重复执行仍须单独验证。

首次管理员生命周期运行在安装前预清理暴露枚举模板缺陷：`actionMask=0` 会得到 `FWP_E_NEVER_MATCH`。中间修订显式使用 `0xFFFFFFFF` 后继续暴露零 GUID `layerKey` 不是跨层通配。

第二次管理员运行进一步证明部分模板中的零 GUID `layerKey` 会返回 `FWP_E_LAYER_NOT_FOUND`。枚举随后改为 null template 的完整快照并分页读取，删除前逐项核对固定 provider GUID；第三次管理员运行已通过上述完整生命周期。

最小 relay lease 探针已在普通权限下通过错误证明、错误 host、消费后重放拒绝，以及登记 lease 对绑定 host 成功。组合探针进一步在批准的宿主权限下证明 restricted client 经 Named Pipe 联合身份验证后获得 lease 并访问绑定 host，Job 外同映像客户端被拒。加上已通过的 WFP 固定回环端口探针，身份、一次性 host lease 与内核端口 fence 的核心机制均已有证据；尚未实现产品 relay，也未验证 CONNECT/HTTPS 或真实 Git push。

真实 Git 配置投影探针已通过 system、两个 global 入口、匹配 includeIf、local、worktree 的加载顺序；显式 `GIT_CONFIG_GLOBAL` 忽略私有 HOME decoy，Broker 只读投影根拒绝 global 写入。该结果只验证配置栈机制，不替代宿主真实配置图解析、专用账户逐文件 ACL、helper/证书或 push 集成。
