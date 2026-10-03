# 测试约定与功能覆盖

所有功能开发均须配套合理的单元/回归测试，测试和文档属于功能交付的一部分。不要等全部开发结束后才首次运行测试。

## 开发流程

1. 明确功能正常行为、关键失败路径、边界条件；选择能够验证行为的最小测试层次。
2. 修复缺陷先增加能失败的复现用例，再修复，确认该用例通过。
3. 每完成一个可验证增量就运行相关测试。开发时可使用 `pnpm test:watch`，或 `pnpm test -- tests/files.test.ts` 定向验证。
4. 需要评估单元/回归测试的源码覆盖率时运行 `pnpm test:coverage`；在补测前先查看未覆盖分支，避免为提高数字而削弱行为断言。
5. 提交前运行 `pnpm check`（类型、lint、格式、单元/集成回归、构建）。UI、API、SSE 变更额外运行 `pnpm test:e2e`。
6. 新增行为同步维护下表与验证记录；说明平台跳过、外部依赖和未验证范围。CI 暂时仅手动触发；触发后在 Windows、macOS、Linux 分别使用 Node 24/26 跑核心检查，在 Linux 的两个 Node 版本下跑 Chromium UI 验收。

## 共享执行逻辑回归

- `model-loop.test.ts`：响应先保存再执行工具、轮次推进、普通重试上限、超限恢复的任务级次数及 attempt 连续编号、保存/工具失败不重放、取消与无效图/正常工具耗尽轮次的区分。
- `model-tool-batch.test.ts`：两种执行模式的节点解析与依赖一致、Runtime push 独占而宿主维持原规则、退出码及多文件 failed/unknown 阻断 DAG 后继。
- `execute-runner.test.ts`：保留但暂停使用的 Push Runner 与 Capability Runner 的实例标识、进程元数据、事件/账本一致、非零退出、启动前后失败、取消、unknown 优先级、命令构造失败和拒绝 host fallback；不能视作现行产品路径验收。
- `engine.test.ts`、`agent-runtime-service.test.ts`、`agent-runtime-engine.test.ts` 继续验证生产组装、真实 Node 子进程、工具结果回传、审批和取消记录；Engine 回归还核对已验证的 Runtime PID 在 `running` 与 `completed` execution instance 中一致。这些测试不替代专用账户提升环境验收。

## 测试审计（2026-09-30）

按默认 Vitest、独立 Playwright、手动 Evaluation（TS 与 Python）和 Windows 原生探针的入口清点测试；扫描断言、跳过条件、历史功能引用和相似用例后，对删除候选逐项核对实际实现及替代覆盖。移除了八项重复或不属于现行后端的用例：基础文件替换、配置密钥落盘、会话重启、重复的旧连接迁移、单文件缺失/歧义目标、两文件部分成功预检、重复的 push 独占图测试及未注册的 WSL inspect 启动形状测试。将重启后事件回读、错误详情与单独 push 合法性补到保留用例。修正手动 Evaluation 的旧工具参数与已移除的 list_files 夹具；**未执行 Evaluation**，不能把静态核对当成该套件通过。

保留有独立安全或兼容价值的旧投影、旧 Runner、历史数据迁移、平台条件跳过以及运行中/已完成任务分别覆盖的长时间线 UI 测试。历史 WSL 代码仍在仓库，但 Runtime 工厂只选择 Windows 专用账户后端；单测、原生构建和 Chromium 测试均不替代安装态验收。审计不以用例数量或单纯调用 spy 作为删除理由。

## 测试分层

- Node 版本兼容性按 `package.json` 的 Node 24/26 范围验证；`@types/node` 和 Runtime bundle 保留 Node 24 基线，避免引入仅 Node 26 可用的 API。`windows-sandbox-node-version.test.ts` 在真实 PowerShell 中单独加载安装器函数，验证 Node 24/26 选择成功、不受支持版本和探测失败被拒绝；不执行账户安装或 WFP 操作。

- 单元测试验证配置、授权、错误分类等可独立观察的行为。
- 集成回归使用真实临时文件、SQLite、子进程和本机 HTTP；模型通过可控适配器/SSE 服务注入预设请求与回复，验证上下文与副作用，而非只检查 mock 调用次数。
- 浏览器测试操作真实 Web UI 与测试后端，覆盖消息、历史、权限、设置、恢复与重连。
- `pnpm test`、`pnpm test:coverage`、`pnpm test:watch`、`pnpm test:e2e` 和 `pnpm check` 都经 `scripts/test-runner.ts` 启动：Vitest 子进程仅接收固定测试环境白名单，Vite 的 test 模式禁止读取 dotenv；Playwright 测试后端直接以 Node/tsx 启动，不解析包管理器的系统路径。

  测试不继承本机 `.env`、系统中的 CodeAtelier 配置或真实 API key；模型只可使用注入式模拟值和本机测试 HTTP/SSE 服务。

- `pnpm build` 与 `pnpm build:test` 还会生成 `dist/runtime/windows-x64` 下以 Node 24 为兼容基线、支持 Node 24/26 的 Agent Runtime、compaction/read_file/subagent 三种 Worker bundle 和 SHA-256 manifest；构建成功只验证 bundle 可生成，不代表安装器已把它复制到受保护目录或 native Supervisor 已核对并启动它。
- `windows-sandbox-scripts.test.ts` 使用模拟平台与子进程核对 `sandbox:repair` 的 pnpm 入口、全部固定维护 action 的 PowerShell 参数、非 shell 启动、退出码/启动错误与非 Windows `SKIP`；不实际执行安装、修复、账户、ACL 或 WFP 操作，也不替代平台安装态验收。
- `pnpm sandbox:native:build` 的原生回归核对产品受限 token 的 execution/root capability 与 Everyone restricting SID、Runtime bootstrap 句柄帧、进程 PID 绑定、仅复制查询权限及畸形帧拒绝；显式 `codeatelier-sandbox-state-parser-test.exe --handle-transfer-probe` 还以真实子进程验证私有管道读帧和跨进程句柄复制。这些都不代替固定账户下的 BCrypt/PowerShell、Job 与 Runtime pipe 联合身份验收。
- 原生 `codeatelier-sandbox-state-parser-test.exe --runtime-descriptor-probe` 可输出固定启动描述符二进制首帧，供 Node 解码器跨语言核对；`runtime-startup-protocol.test.ts` 验证真实本机管道的成功握手，以及无效首帧后入口关闭 socket 并退出。安装态首帧和 IPC 双向代理仍须用显式产品验收验证。
- `pnpm sandbox:native:build` 还以五秒上限运行原生 `--runtime-duplex-probe`：在真实本机 Named Pipe 上覆盖预连接与待决连接两种顺序，并在 server 读取下一帧时向 client 写入 Broker 回复；它曾在同步 pipe 上超时，overlapped I/O 修复后通过。该探针不覆盖固定账户 ACL、Job 或完整任务协议。
- `pnpm sandbox:runtime:verify` 是安装完成后由用户显式运行的 Windows 产品链路验收：它使用模拟模型，经默认 Engine/SandboxBroker/native Supervisor 在专用账户 Agent Runtime 内创建工作区文件，再在同一批次独立执行 Broker 宿主 Git status 和 Runtime 普通命令，使一条路径的失败不遮蔽另一条的结果，并核对专用账户子进程、输出与 clean release；随后以仅供此手动验收的内部已标记任务调用受保护的 subagent Worker，核对受限工具、读取、报告收集和 tracing，公开 HTTP 门禁仍保持关闭。`process.test.ts` 覆盖 file-backed 输出回传、取消和持久化失败时的进程停止与临时文件清理；这些本地测试不代替安装态 restricted token 验收。
- `agent-runtime-engine.test.ts` 与 `runtime-ipc.test.ts` 核对 Broker Git status/add/commit 的宿主执行归因、原有 action-specific 结果形状和受限 IPC schema；`sandbox-native-windows-runtime.test.ts` 核对 Runtime 不再投影宿主 global/include 配置。
- `sandbox-git-config-graph.test.ts` 保留旧 Runner 路径的只读 Git global 投影回归；当前产品 Git 已由 Broker 宿主执行，该测试不是现行产品路径验收。
- `git-tools.test.ts` 核对仓库探测失败时工具结果保留有界 Git 错误，避免安装态验收只剩泛化失败信息。

  `tests/runtime-startup-protocol.test.ts` 另以原生 `StringFromGUID2` 的 `{GUID}` 后缀启动真实本机 pipe，验证 Node 入口能连接并完成模拟任务；普通协议测试同时保留不带花括号的合法名称及远程、畸形名称拒绝。该测试不代替专用账户的身份与 ACL 验收。

  随后由低成本模型夹具自动批准一次 `run_with_permissions`，让 Broker 宿主命令写入 sibling 目录，核对独立 `broker-command/host-process` 记录、结果回传和 Sandbox lease 清理。此阶段不验证 Capability Runner 的外部 ACL 或 HTTPS relay。

  下一阶段初始化一次性 Git 仓库，验证 Broker 宿主 Git push 对本机不可用端口的失败结果、审批和归因；最后验证主动取消。该命令不属于 `test`/`check`，不会访问模型服务、外部网络、真实 remote 或凭据；只有在真实安装环境运行并输出 PASS 才构成对应平台证据。

- 真实模型 smoke 测试独立运行，需要本地提供密钥；不作为日常离线测试前提。不对用户项目进行测试性写入。

## 代码覆盖率

- `pnpm test:coverage` 通过同一隔离测试启动器执行默认 Vitest 测试，并使用 V8 provider 统计 `src/**/*.{ts,tsx}`；`src/evaluation/**` 明确排除，避免将只能手动运行的 Evaluation 纳入日常覆盖率。
- 命令在终端输出行、函数、分支和语句摘要，并将 HTML 报告写入 `coverage/index.html`、LCOV 写入 `coverage/lcov.info`。`coverage/` 为可再生成的本地产物，已由 Git 忽略。
- 报告覆盖默认单元/集成回归可加载到的产品源码，不包含 Playwright 浏览器 E2E、真实模型 smoke 或 Evaluation；它反映测试执行路径，不能替代关键失败路径、跨平台和端到端行为验证。
- 当前不设置覆盖率阈值。先保留真实基线并用报告定位高风险缺口；引入门槛前应依据稳定基线和模块风险另行确认，不能以排除源码或降低断言来满足数字。

## 已有功能覆盖

### 目录与命令搜索

主要测试：files.test.ts、core.test.ts、tool-schema.test.ts。

只公开当前工具契约，拒绝无执行器的工具名；跨平台检测常见命令并按估计性能排序，将目录浏览/可用列表注入模型指令

### 文件读取

主要测试：files.test.ts、core.test.ts、read-file-worker.test.ts。

行号/范围/500 行限制、分页与截断元数据、无效范围、文件大小、二进制、链接越界；宿主及 Agent Runtime 的 read_file 工具内阶段嵌套、无独立准备/计算片段、冷/热 Worker 启动、超过旧空闲回收间隔仍复用、任务结束关闭/排队与执行中取消、部分线程退出失败仍等待其余线程、失败 trace

### 新建与精确编辑

主要测试：files.test.ts、multi-file-edit.test.ts、regressions.test.ts。

create:true 嵌套创建、已有目标及最后一次预检之后出现目标的覆盖拒绝；create:false 的唯一/字面替换、任务内读取前置条件、并发修改、临时文件清理、POSIX 模式

### 路径与工作区

主要测试：paths.test.ts、core.test.ts。

路径前缀隔离、父目录越界、新建路径规范化、敏感组件、真实目录要求、Windows ADS

### 权限

主要测试：permissions.test.ts、model-approval.test.ts、core.test.ts。

单次/会话授权、低成本模型三级分流、失效或无模型时保守人工确认、跨会话隔离、内容变化后重新审批、取消、敏感文件/AGENTS.md、直接 Git 与提权限制

### Git 工具

主要测试：git-tools.test.ts、paths.test.ts、tool-schema.test.ts、e2e/app.spec.ts。

单一 action 契约、固定 status/diff/log/show/branch 参数、add/提交/推送自动执行、worktree/upstream/revision/敏感目录校验；运行时 dotenv 拒绝、受控 dotenv 模板的占位凭据校验与输出保护、暂存失败不提交、禁止额外选项，以及流式输出与退出状态的卡片聚合

### 命令执行

主要测试：process.test.ts、process-tree.test.ts、core.test.ts、permissions.test.ts、tool-schema.test.ts。

不存在的命令及子进程实际错误、输出与退出码、截断、UTF-8/ANSI 分块、颜色环境与控制符清理、API key 不继承、内部 Windows/POSIX shell 选择、单一 command 契约、复合命令合并、直接 Git/提权拒绝、取消和超时；输出持久化失败及 stdin 提前关闭不会产生未捕获异常，停止子进程后返回错误。Windows 专属 process-tree.test.ts 延迟真实 taskkill，验证不能抢先杀父 shell；pipe/file-backed 均须让后代退出并释放输出资源，安全兜底清理一旦触发则测试失败。

### Sandbox Broker 与专用用户目标

主要测试按边界组织：

- 执行和账本：sandbox.test.ts、sandbox-native-windows-runtime.test.ts、process.test.ts、engine.test.ts、recovery.test.ts。
- 网络与协议：sandbox-https-relay.test.ts、runtime-capability-core.test.ts、runtime-ipc.test.ts、runtime-session-client.test.ts、runtime-startup-protocol.test.ts、supervisor-protocol.test.ts。
- Agent Runtime：agent-runtime-tools.test.ts、agent-runtime-service.test.ts、agent-runtime-engine.test.ts。
- 配置与诊断：logging.test.ts、config.test.ts、tracing.test.ts。
- 手动组件探针：`experiments/windows-sandbox-user-demo`、`windows-restricted-token-demo`、`windows-network-ipc-demo`、`windows-git-config-demo` 中的 `run-demo.ps1`。路径后缀均相对于 `experiments/`。

自动回归覆盖：

- 关闭或非 Windows 时的宿主路径；启动前失败的按任务 fallback、宿主工具定义与实际状态。
- 执行开始后不重放；executionInstance、PID/创建时间、中断状态、独立日志及恢复提示。
- strict 协议操作与响应关联、有界 framing、instance/nonce 握手、model/session/approval adapter 和 Supervisor 首帧。
- 独立 Node 子进程中的 agent loop、工具 DAG 和 Engine launcher 分流。
- `sandbox-supervisor-failures.test.ts` 用内存管道验证 Runner/Agent Runtime 启动与输出回调故障、stdin 错误，以及清理证明缺失优先于原始错误；不启动原生账户。

Windows native runtime/relay 测试在非 Windows 整组跳过。stdio harness、首帧 parser 和组件探针不能证明产品 Windows transport 身份；完整能力须按 [W0--W6 分层门槛](windows-integrity-sandbox.md#9-实施与验收) 验收。

### 模型协议与重试

主要测试：provider.test.ts、recovery.test.ts。

item.done 回退、失败/不完整事件、服务实际错误 message/reason/code 的脱敏保留、断流、超时、重试次数、HTTP 分类、取消退避、并行工具调用请求参数

### Skill 发现与加载

主要测试：skills.test.ts、skills-engine.test.ts、tool-schema.test.ts。

覆盖 UTF-8/BOM/CRLF、YAML 多行/坏字段/重复键/大小边界，六个预设根及同名优先级、缺省空目录、坏条目隔离和低优先级回退，链接/junction/硬链接与加载前根替换拒绝，枚举/目录容量限制，任务内版本失效、新任务重新发现，strict 工具与 IPC v7 拒绝路径/命令和旧握手、最大目录 JSON 转义后的启动传输边界。宿主及真实 Node Runtime 模拟模型往返验证摘要先行、正文按需、无审批/脚本副作用、失败后继阻断、历史/replay 及 trace 脱离元信息/正文。所有文件在临时项目/home 中，无个人密钥；不替代固定账户安装态或跨平台验收。

### MCP 本机访问

主要测试：mcp.test.ts、mcp-engine.test.ts、mcp-ipc.test.ts、tool-schema.test.ts；夹具 tests/fixtures/mcp-server.ts 使用官方 SDK。

覆盖配置缺省关闭/损坏拒绝/UTF-8 BOM/私密字段、禁用服务拒绝、stdio 真实握手与连接复用/直接子进程退出、工具/资源/模板往返、HTTP 认证头和裸 token 脱敏、分页/重定向拒绝/响应流大小限制/正常 DELETE、审批先于连接、单次授权、超时/取消及禁止自动重连、输出截断与 isError、宿主和独立 Runtime 模型往返/历史/replay、失败后继阻断及 trace 不含 MCP 参数/正文。全部离线且无个人密钥；不替代真实远端、跨平台和固定账户安装态验收。

### 网页检索与来源引用

主要测试：provider.test.ts、engine.test.ts、agent-runtime-engine.test.ts、tool-schema.test.ts、core.test.ts。

错误诊断另由 runtime-ipc-errors.test.ts 覆盖：跨 IPC 保留模型超时、HTTP 原因、重试元数据和底层 cause；凭据脱敏、消息限长、未知异常不序列化正文、无效请求定位字段。provider.test.ts 使用本机流服务区分总超时和空闲超时，并检查提示包含实际配置时限。

主任务请求包含 OpenAI 内置 `web_search`，宿主与 Agent Runtime 路径一致；Responses URL 引用只接受 HTTP(S)、按 URL 去重并转为可点击 Markdown 来源；内置工具不注册为本地函数或 DAG 节点

### agent 循环、任务调度与工具 DAG

主要测试：tool-graph.test.ts、tool-status.test.ts、engine.test.ts、core.test.ts、recovery.test.ts、server.test.ts。

复杂任务先读取代码/文件并获得信息后才输出计划摘要的指令与随后执行、已知参数的依赖调用同轮提交指引（依赖只能引用本轮节点，禁止跨轮历史 ID）与过时顺序指令回归、工具往返、同轮 DAG 的稳定拓扑并发、审批准备与执行槽分离、单槽下独立节点越过审批等待、并发上限、重复/未知/环拒绝、失败后继阻断与反馈；跨会话不同工作目录并行、同目录排队、同会话互斥、取消/关闭队列、步骤/上下文预算、参数错误反馈、根规则、输出预算、跨任务重新读取、不重放副作用、工具耗时排除审批等待

### 可选 subagent（内部双执行路径，尚未开放）

文件读取回归覆盖超过 32,000 字符的完整长行、与主工具共有的 500 行分页及 2 MiB 文件大小限制；搜索覆盖超过 4 MiB 的文件、超过 240 字符的匹配行和 120 字符的搜索词、调用方请求超过 100 条结果、超过 300 个目录条目/200 个文件及超过 6 层的目录。取消与只读权限检查继续有效，不以移除资源阈值扩大授权范围。

主要测试：subagent-capacity.test.ts、subagent-contracts.test.ts、subagent-limits.test.ts、subagent-readonly.test.ts、subagent-worker.test.ts、subagent-coordinator.test.ts、subagent-recovery.test.ts、model-tool-batch.test.ts、engine-subagent.test.ts、agent-runtime-subagent.test.ts、runtime-subagent-ipc.test.ts、sandbox-native-windows-runtime.test.ts、store.test.ts、session-statistics.test.ts、server.test.ts、tests/e2e/app.spec.ts。

已覆盖分工 action 严格校验、计划 DAG 与超过旧数量阈值的批次、单任务与跨 Runtime 的 Broker 全局 Worker lease、排队和取消；真实 SQLite 子计划、检查点、重复请求拒绝、重启中断与未知模型请求，以及与主工具反馈同分片提交的报告消费。晚完成、反馈截断或持久化失败不能误标已消费；子 Worker 只可用受限读取，读回执落盘失败立即停止，不继续模型轮次，主任务取消中断等待；超过旧 120 秒、12 轮、32,000 累计 token、100,000 输入字符、8 个问题和 16 条消息后仍能完成或明确取消，保留实报用量与完整内容；schema/SQLite 覆盖超过四个计划/报告、2,000 项检查点、32,000 字符报告和 2,000,000 字符检查点/请求结果；`ask_main` 长问题、错误拒绝、已确认回执重试幂等、任务归属、主代理 `await` 提前返回、`message(replyTo)` 唯一答复，以及真实 Runtime IPC 和刷新后 HTML 安全历史均有回归；Worker 双向消息核对版本、任务/子任务归属和单调序号，跨任务父回执不能成为有效模型结果；question/message/cancel 只写固定名与登记子 ID 的 trace，不放问题正文、消息或报告。宿主 Engine 与真实 Node Runtime 子进程的内部已标记任务均完成计划/等待/收集的模拟模型闭环；Broker IPC 拒绝未经登记的子模型、冒用主模型身份、写工具声明和重复 lease 释放，断连后留存租约直到实例确认清理。Worker 与主线程共用进程/身份，不抵御恶意代码直接使用 Node API；stdio 测试、bundle/MSVC 构建不等于固定账户提升环境或跨平台验收。Bootstrap、Engine 与 HTTP 共用默认 false 的发布门禁；Playwright 伪造 bootstrap true 只可检查 checkbox 与一次性请求，后端 409 拒绝启用且草稿不丢失。历史任务标记及子计划/状态/收集由持久化 Snapshot 重建、刷新后仍可见；Host/Runtime 在状态落盘后通知 SSE。真实 SQLite 重启后的子模型未知请求保留，人工恢复继承启用选择并重新读取文件而不自动重建旧 Worker。真实发布仍待固定账户下子线程启动/取消、恢复及故障矩阵验收；上述手动命令未在无安装环境运行。

### 项目记忆

主要测试：memory.test.ts、tool-schema.test.ts、engine.test.ts。

按真实工作区 SHA-256 隔离的 Markdown 文件、严格解析/安全降级、关键词检索、archive、版本冲突、敏感内容拒绝；模型无需人工确认的 `memory_apply` 契约、任务内写入、固定检索 bundle 与仅含操作数量的任务事件。项目管理 UI、来源哈希失效验证和手工恢复/清空待后续测试覆盖

### 会话存储、标题与 Replay Case

主要测试：store.test.ts、recovery.test.ts、title-generation.test.ts、replay-case.test.ts。

`store.test.ts` 覆盖 Store Worker 串行常规写入、回执后的读写顺序、跨重启持久化和失败批次原子回滚；`tracing.test.ts` 验证独立 Store worker 轨道及无正文泄露。同步兼容入口与未开放 subagent 的迁移仍需另行验证；现有宿主/Runtime subagent 回归覆盖其同步账本与 Worker 事务交错时的执行、检查点及报告收集。`store.test.ts` 用第二个真实 SQLite 连接锁住后续历史分片，验证兼容连接有界等待后失败会释放前面分片，后续事务仍可提交。`shutdown.test.ts` 等待冷启动 Worker 确认命令输出已持久化，再验证 SSE 关闭与中断保存。

隔离、事件顺序与游标、增量上下文批次重建与事务回滚、旧分片先备份再迁移以及备份失败保持旧数据、queued/running/waiting 重启中断、实际开始时间、标题状态迁移和恢复，以及大 JSON 的 Worker 读取；按小阈值触发的历史 SQLite 分片、新旧分片聚合、重启发现和旧分片 Worker 读取；任务级 subagent 开关的布尔序列化、旧分片迁移默认关闭及未开放请求明确拒绝（UI 尚未启用）；逐条模型/工具增量捕获、跨重启前缀恢复、未完成请求、旧整条捕获与 legacy 历史标记、局部读取拒绝、哈希一致的分页读取重建和只写入新隔离目录

### 会话统计

主要测试：session-statistics.test.ts、e2e/app.spec.ts。

服务实报 token 的缓存/非缓存完整性、LLM 请求与任务轮次、工具成功率、任务累计运行时间、旧 usage 历史回退及默认折叠/展开展示

### 模型设置

主要测试：config.test.ts。

连接只来自环境、settings.json 仅保存偏好、备用字符上限新默认值及既有自定义值保留、端点规范化、连接改动拒绝、参数边界、失败更新保持原状态、密钥内存存储、损坏配置不覆盖

### 日志

主要测试：logging.test.ts、core.test.ts。

级别过滤、紧凑纯文本格式、上下文字段、错误元数据/原因链/堆栈、凭据脱敏、轮转、存储故障降级

### Perfetto tracing

主要测试：tracing.test.ts、read-file-worker.test.ts、agent-runtime-engine.test.ts、runtime-ipc.test.ts、tool-graph.test.ts、e2e/app.spec.ts。

宿主与真实 Runtime 子进程的 `read_file` 路径准备/检查/字节读取/Worker 排队/冷启动/处理回传阶段及结果字节数与纯计算耗时，冷/热 Worker、二进制失败与排队取消的阶段配对；`context.prepare`/`context.request` 及计量子阶段、Runtime `tool.result_persist`、独立模型与响应处理、工具计划/持久化及 instant/flow 事件导出；Runtime trace IPC 只接受固定阶段、工具槽位、单调微秒时间戳和有界数值属性，Broker 校验时间窗、以已验证 Runtime PID 分组、对五次 read_file 复用最多四条槽位轨道，参数在 Broker 侧从 tool_start 脱敏附加；任意名称/文本字段关闭通道；主线程嵌套 begin/end slice、Task 包络、时序排序、整数 flow ID、可复用工具轨道、实际 tool 的完整结构化参数及递归凭据脱敏、按 session/task 独立持久化、终态后释放内存、认证下载、仅显示真实文件的统计框入口、关联元数据与普通长属性限长

### HTTP API、访问密码与监听范围

主要测试：access-password.test.ts、server.test.ts、listen-address.test.ts、core.test.ts。

环境开关默认关闭、非法开关/启用时缺少密码拒绝启动、正确/错误密码、HttpOnly 门禁 cookie、未验证 API 拒绝；会话初始快照与按 event ID 游标读取的增量事件、任务接口和参数校验、跨工作区并行与同工作区排队、默认 IPv4/IPv6 回环、显式 IPv4/IPv6 局域网通配监听、Host/Origin/cookie/token、运行/排队任务时的配置更新互斥、取消与恢复

### 服务关闭

主要测试：shutdown.test.ts、e2e/app.spec.ts。

关闭授权与确认、正在执行命令的中断保存、SSE 结束、端口释放、重复清理、实际入口进程退出、关闭页面与失败反馈

### 开发服务重载

主要测试：e2e/app.spec.ts。

从侧栏完整刷新页面，重新请求 bootstrap 并恢复可操作的本机界面；不把页面刷新误作服务器进程重启

### Web UI

主要测试：e2e/app.spec.ts、e2e/access-password.spec.ts、e2e/web-history.spec.ts、e2e/sandbox-badge.spec.ts、session-view.test.ts、timeline-virtualization.test.ts。

访问密码开启时先显示门禁、错误密码不进入主页面且正确密码后加载主页面；

建会话、首条消息标题更新、已完成任务默认只显示输入和最后一轮输出，展开后可检查工具/diff/通知/重试过程且刷新后重新默认折叠、历史续聊及隔离、项目内折叠和最近记录限制、审批与取消、有流式输出工具的卡片聚合与历史重载、设置、人工恢复、Markdown 输入规则原地转换为富文本且不显示独立预览、消息中的标题/链接/代码围栏/表格/任务列表及原始 HTML 拒绝、SSE 失效重连及切换会话时的加载反馈；

Sandbox 徽标浏览器回归以合成历史阶段验证：bootstrap 的待确认状态不能覆盖当前会话已有的实际隔离结果，即使 SSE 断开、重连且没有新增阶段；切换到尚无执行证据、结果未知或宿主回退的会话不能继承旧会话结果，待确认不能误报为不可用。该回归不替代真实专用账户验收。

手机视口可通过菜单完整打开侧栏，并由会话选择、遮罩或 Escape 收起；

时间线按滚动位置和缓冲范围只创建可视条目，其余历史以准确高度占位；高度前缀和复用与二分查询覆盖 50,000 项下的索引读取次数。

增量会话投影覆盖分批与全量结果一致、重复事件去重、乱序重建、显式替换、跨会话拒绝、attempt 隔离、完整回复替换流式项、旧命令输出和 batch 通配兼容、任务完成分组复用、不可变旧视图、usage 回退在 request 到达后撤销以及时钟独立计量。3,000／12,000／50,000 事件用例通过禁止读取旧正文验证增量边界；浏览器以 12,001 个合成事件验证有限节点、滚动、输入、真实 EventSource 重连游标与重复统计防护。测试不访问真实模型或个人历史。

## 关键缺陷回归

- endLine 小于 startLine 时返回成功空读取。现在拒绝无效范围，避免将错误输入当作成功读取。
- 原结构化 JSON 日志的 token/password 等字段未被文本脱敏识别。增加内部字段脱敏，测试包含嵌套字段和转义引号；当前落盘前再格式化为纯文本，不泄露凭据。
- Windows Sandbox 回归现覆盖：cleanup failure 在同时取消时仍为 unknown；

  Supervisor 已证明 clean 的墙钟超时只释放当前 lease、不隔离其它实例；

  原生 ACL 撤销失败前 lease/grant 不从账本删除；

  共享对象的第二个 lease 等待首个原生 provision，read/write 用途交叉时仍只安装和最终撤销一个账户 grant；

  失败 grant 拒绝后不泄漏引用；

  unknown 调用整代账户 drain；

  任务 A fallback 与任务 B sandboxed 并发时状态不串扰；

  启动恢复/首次 self-check 依次执行账户进程终止、journal 撤销和安装自检。

  这些是无提升副作用的协议/编排测试，不替代固定账户下的真实 ACL、Job、WFP 或崩溃恢复验收。

- `runtime-capability-core.test.ts` 只验证传输无关的 capability 状态机。

  `runtime-ipc.test.ts` 以独立 Node 子进程验证有界 framing、instance/nonce 握手和模型流；

  Broker 在匹配 `runtime_hello` 前收到任何 request/event 都关闭通道，observer 语义异常也转成连接失败；

  Runtime session adapter 只接受 Runtime 自有的模型/工具/上下文事件，不能伪造 Broker 的 execution instance、Sandbox 生命周期、fallback 或任务终态；

  请求级取消会向远端发送关联 requestId 的 cancel 帧、终止对应 handler，并以有界 tombstone 忽略竞态迟到响应而不破坏后续请求。

  `runtime-startup-protocol.test.ts` 验证安装版入口只接受固定本机 pipe 命名空间及有界严格首帧，并在 Windows 用真实本机 Named Pipe 启动独立 Node 正式入口完成握手和模型终态；

  `runtime-session-client.test.ts`、`agent-runtime-tools.test.ts`、`agent-runtime-service.test.ts` 与 `agent-runtime-engine.test.ts` 进一步验证 session adapter、Runtime 内命令、完整模型/工具循环、模型重试元数据、无效 DAG 的无副作用修正及 Engine launcher 分流。

  这些自动回归仍不验证专用账户、Named Pipe client PID、token/capability、Job 或 generation，因此不能单独计入 W3/W4 完成。

- 原生产品构建直接编译 `native/windows-sandbox/network-fence-implementation.cpp` 并定义 `CODEATELIER_PRODUCT_WFP_ONLY`；同时编译并运行真实 Supervisor 的版本 4 relay 端口解析回归、LSA 账户 DACL 进程内回归、Runtime/Bootstrap pipe 实例 SID DACL 差异，以及二进制授权 journal 标志回归。journal 模式只接受带安装账户标志且不同时声明文件与写入的 4/5/6，普通撤销模式仍只接受 0/2。提升安装后须分别在管理员终端执行 `pnpm sandbox:verify` 的完整 WFP 枚举，在普通终端执行 `pnpm sandbox:runtime:verify`，核对对象级 WFP/LSA 读取、Runtime 承载、Runner 与取消无 fallback/unknown；两种身份不能互相代替。构建后手工冒烟确认实验参数 `--ipc` 以退出码 2 被拒。实验 demo 通过薄包装编译同一实现但不定义该宏，避免产品源从 experiment 目录反向依赖。
- 非交互式 window station/desktop 的真实 OS 探针需在普通用户 Windows 会话中手动运行 `dist\native\windows-x64\codeatelier-sandbox-state-parser-test.exe --window-station-probe`。它短暂创建并关闭两个 desktop，以不同账户替身 SID 核对已有共享 station 补装第二个账户 ACE、不同实例 SID、宿主原 station 恢复，以及在完整 station/desktop 路径上的 USER32 子进程启动；不创建专用账户，不替代安装后跨账户的 Runtime 验收。默认 native build 不执行此 OS 探针，以免外层受限环境影响纯构建回归。

### Sandbox 证据边界

自动回归、组件探针和真实产品验收分别记录。测试清单不能证明专用账户 Sandbox 已完整可用；当前分层门槛见 [Windows Sandbox 架构](windows-integrity-sandbox.md#9-实施与验收)。

早期 WSL2、restricted-token、WFP、relay 和 Git 配置探针的运行过程已集中到 [历史验证记录](verification.md#sandbox-组件探针历史记录)。其中的“尚未实现”只描述当时状态。

尚未覆盖的产品提升安装、真实 IPC/网络/push、取消与恢复矩阵，不能由构建或模拟测试替代。不同会话共用 Sandbox 账户，仍存在读取并集与 peer 干扰风险。

### Sandbox 产品回归

产品实现新增无管理员副作用的 Sandbox 单元覆盖：AccessManifest 对工作区、显式读写根、逐实例 HOME/TEMP 和 Git 配置文件固定卷/file ID 并拒绝链接/模式冲突；Runtime 在 manifest 前创建私有目录，确保它与工作区一样经过 ACL/capability/journal，而不是依赖 ProgramData 父目录写权。

Git 配置图按两个 global 入口递归解析 `include` 与适用的 `gitdir/gitdir/i includeIf`，对循环、未知条件、链接和资源上限安全拒绝；

account generation 状态机验证 1～4 个不同工作区并发、同工作区串行、共享 grant 引用计数、epoch 防重放和整代 quarantine；

ToolRunner 回归夹具证明受限 Git 的仓库探测和实际 action 都经过配置的 Sandbox Runtime；

CONNECT relay 夹具验证 proxy token、精确 host、私网 DNS、IPv4/IPv6 公网分类和 lease 撤销，其中 IPv6 只接受普通全球单播并拒绝 Teredo、6to4、NAT64、文档和本地前缀。

原生构建脚本已在本机 MSVC x64 下生成 WFP manager 与 supervisor，后者含逐对象 ACL/journal、同卷 rename 后按 file ID 重开原对象的 revoke 回退、收紧的 WRITE_RESTRICTED token、private desktop、Job、账户拒绝登录权、专用账户环境块与同 Job askpass pipe；PowerShell build/install/recover 均通过语法解析。

上述结果仍不等同于提升安装、真实 rename/ACL/WFP/CONNECT 或 Git push 集成通过。

原生 Runtime 增量另覆盖：固定 magic/version 的有界二进制执行帧、绝对路径/argv/时限边界、v2 installation state 与 supervisor、WFP manager、Node 24、Runtime entry、compaction worker 五个 SHA-256 复核，以及原生自检成功/任一 Runtime bundle 篡改拒绝。

MSVC 已成功构建同一二进制的 supervisor/bootstrap：固定 self-check/execute/bootstrap 模式、DPAPI 解密、账户/WFP/Runtime bundle 自检、PID 核对 Named Pipe、restricted token、Job、Broker stdin 断连取消和唯一 SID ACE 撤销。

安装脚本通过 PowerShell AST 解析；真实提升安装仍未执行，因此这里只记录“构建、静态安装契约与无管理员副作用回归通过”，不记录产品 E2E 通过。

`sandbox-agent-runtime-launcher.test.ts` 覆盖产品 launcher 的关键状态边界：Runtime started 后才提交共享 grant并将该 execution instance 标为 `sandboxed`；

clean close 后执行 native revoke、commit 和私有目录清理；

启动前 self-check 失败才允许显式宿主 fallback；

started 后 close 返回 orphaned、Broker 未取得可信 Runtime 终态（即使 native shutdown clean）或 generation 摘要不一致时写入 `unknown`、quarantine 并调用整代排空。

`agent-runtime-engine.test.ts` 另证明 Engine 只捕获 `AgentRuntimeFallbackError` 继续宿主 loop，并把 execution instance 记为 `host-process`/`sandboxApplied=false`，同时发出供 Web 徽标使用的实际 `sandbox_stage`；已启动 Broker Git push 即使取消，也保留 `sideEffectsPossible=true`。

C++ 任务 pipe 的 PID、创建时间、Job、账户、restricted SID、固定映像检查及字节代理目前由 MSVC `/W4` 构建覆盖；安装后可用 `pnpm sandbox:runtime:verify` 验证真实完成、取消和 clean release，错误客户端及恢复故障注入仍需提升环境矩阵。

## 自举验收

`tests/bootstrap.test.ts` 覆盖固定测试命令的精确审批及错误路径、参数、shell、非命令请求拒绝。真实源码任务使用独立的手动脚本，不依赖默认 CI 密钥；准备模式不调用模型。运行与判定见 [bootstrap.md](bootstrap.md)。脚本也纳入 TypeScript 检查。

自举实测回归：engine.test.ts 验证读取带引号的凭据赋值源码后工具 JSON、上下文与任务完成仍有效；logging.test.ts 验证同类格式化日志保留关联信息与错误堆栈，含引号/反斜杠的已知密钥与嵌套字段保持脱敏。先在旧实现复现失败，再验证修复。

## 上下文压缩覆盖

context.test.ts 覆盖专用压缩 Worker 编排下的工具定义预算、完整调用批次、用户纠正原文保留、
归档分页和会话隔离、重启加载、多次压缩保留未知操作、无效摘要、事务回滚、
取消、不可压缩输入、超过 12 次摘要的完整材料覆盖及同任务继续压缩、历史工具集成及服务端容量错误只恢复一次。token 测试还核对
主任务以最新实报输入加追加项估算，Worker 对改写候选使用本地计量，提交后清除旧基线并与快照计量一致。e2e/app.spec.ts 验证整理提示、续聊完成和刷新后的原历史。
sandbox-session-boundary.test.ts 验证超过旧 20000 字符上限的摘要说明仍能通过 Runtime IPC 快照校验，并与活动上下文一起保存；跨会话快照和父链仍被拒绝。
测试使用模拟模型；摘要语义质量、真实模型容量与长期压力仍需单独评估。Store 的 Worker 回归使用超过 64 KiB 的真实 SQLite JSON，验证线程外读取不改变数据；压缩回归验证语义和取消，但尚未以压力测试证明任意负载下的 HTTP/SSE 响应延迟上界。

## token 容量与用量

实报基线回归覆盖高估与低估的双向修正、只估算追加项、最新 usage 替换旧值、非法 usage 不污染基线、请求配置/前缀变化失效，以及真实压缩 Worker 提交后的本地计量重建。

tokens.test.ts 覆盖手动窗口覆盖（默认 300000、服务窗口/输入上限较小时的替代）、容量预留、备用模式、中文/代码/工具与特殊 token 字面量、usage 校验、重复计量缓存、追加项增量编码、请求配置变化及压缩后缓存重建、压缩计量一致性、输出预留传参、用量重启持久化和实报校准。session-statistics.test.ts 覆盖 model_request、实报缓存/非缓存聚合、旧 usage 回退、工具成功率和运行时长；e2e/app.spec.ts 覆盖统计默认折叠、展开后 token/LLM/工具展示、预算模式、服务实报用量及刷新保留。

provider.test.ts 用本机 HTTP/SSE 验证模型容量和 usage 提取。真实服务最小探测见 model-tokens.md。

## 渐进压缩覆盖

compaction-policy.test.ts 覆盖超过 20 个来源、每类超过 20 条结论与超过 8000 字符的有效摘要，以及仍拒绝的格式/来源错误；真实 Worker 验证预算 60% 以内且收益不足 10% 的摘要可提交，高于 60% 目标或无收益仍拒绝；普通与强制保底均执行 60% 目标，不能保留用户原文时拒绝提交。

context-stages.test.ts 覆盖长记录中间材料的全文连续送出、默认摘要时重复读取仍保留原文，以及旧文件投影函数对版本、失败/未知结果和来源的兼容契约；默认路径不再执行旧去重或归档阶段。既有 context.test.ts 继续覆盖事务回滚、取消和恢复。

## SWE-bench 评测（仅手动）

`evals/evaluation.test.ts` 保留生产工具、预算、用量缺失、在途模型请求超时、目录隔离，以及当前 `run_command` 的 `{ command, cwd }` 审批描述与工作区约束测试。`scripts/swebench/test_contract.py` 覆盖固定清单合法性、提示词不泄露答案、打包白名单。所有评测测试只在用户要求后执行；不加入默认 test/check、CI 或钩子。

手动入口：`pnpm eval:test` 和 `python -m unittest discover -s scripts/swebench -p 'test_*.py'`。评分使用官方 harness，不以 agent completed 或本地测试退出码冒充解决率。运行说明见 [swebench.md](swebench.md)。

## 完整请求与压缩覆盖

context-request.test.ts 覆盖低于阈值时重复读取结果原样发送、原始输入计量、瞬态重试和新工具轮次保持完整历史。context-stages.test.ts 覆盖达到阈值后默认直接摘要全文以及旧投影数据的兼容回读。context.test.ts 额外覆盖常规摘要在超预算失败时的保底视图：完整快照保留，活动输入保留用户原文与最新结论，并移除超长中间工具输出。

git-tools.test.ts 覆盖 diff 独立输出硬上限；core.test.ts 覆盖模型收到避免无必要全量 diff 的指令。它们均属于普通功能回归，不启动 Evaluation。

评测报告手动回归 `scripts/swebench/test_report.py` 覆盖缺失数据不当作零或失败、官方回归测试失败、补丁头排除、缺失工具结果、非零测试退出、不可解析的脱敏命令参数和分位数样本口径。该套件不进入默认 test/check。另覆盖 list_files 数组形式的工具结果；2026-09-12 用户授权三题评测期间，报告回归 6 项通过。

准备镜像的手动契约用例验证：使用固定 image ID 后不访问 registry 或远程 task spec。仍通过独立手动测试入口执行，不加入默认检查。

### 思考等级配置

配置测试覆盖旧配置默认 high、环境默认值、保存后重载和非法值原子拒绝；模拟 HTTP/SSE 测试核对各等级及缺省值的实际请求体；浏览器测试覆盖默认展示、修改保存与刷新回显。未验证真实模型服务对各等级的接受及计算行为。

镜像刷新手动回归 `scripts/swebench/test_refresh.py` 覆盖新运行包上传与文件校验、镜像结果记录、base_commit 不匹配时不提交镜像且清理容器。本次按 Evaluation 约定仅静态检查，未执行该套件。

- 连接配置：缺少地址/模型时即使有旧 settings.json 也启动报错；API 地址和模型标识只从环境读取并规范化端点，settings.json 只保存偏好且拒绝竞争来源；单元与浏览器测试使用独立模拟配置，并回归验证测试进程只可见固定测试连接且 API key 为空。

### 辅助模型

- `tests/auxiliary-model.test.ts`：旧配置兼容、主模型继承、环境辅助模型来源、可保存推理强度、模型改动拒绝、非法输入拒绝；生产 Engine 路由、辅助模型独立预算、完整摘要来源、摘要失败保留历史。使用模拟模型，不访问真实服务。
- `tests/title-generation.test.ts`：首条 prompt 选择辅助模型、输入分隔和输出清理、未知标题模型故障最多额外重试 3 次、永久失败不阻断主任务、取消结束标题状态，以及旧 SQLite 标题迁移。
- `tests/model-approval.test.ts`：审批请求把后端会话工作区根目录与不可信的工具名、待审批内容分字段发送给无工具、单次关闭思考（不修改辅助等级）、256 token 的低成本模型；`tests/engine.test.ts` 验证审批专属请求路由，`tests/provider.test.ts` 验证真实 Responses 请求为 `reasoning.effort: "none"` 且其它请求保留配置等级；严格 JSON 输出分别自动通过、保留人工点击或直接拒绝并返回理由；检查 prompt 按实际影响优先放行工作区内常用开发命令、只读探索、无害组合及合理的公开网络/工作区外非敏感只读访问；对工作区外写入、敏感内容和重大风险保留人工确认，明确恶意行为才拒绝；Engine 的宿主及 Runtime 请求均携带真实工作区根目录；分类器缺失时不自动放行。
- `tests/e2e/app.spec.ts`：只读展示环境连接、保存思考偏好并在刷新后回显，且不暴露密钥；首条 prompt 完成后在侧栏显示并在刷新后保留自动标题。

评测包装器的辅助模型路由与主模型共用累计用量和调用上限；本次仅静态检查评测改动，未运行 Evaluation。

## 项目内多个对话

- `tests/e2e/app.spec.ts`：通过页面内项目目录表单连接首个项目；点击项目名称右侧加号直接新建第二个对话，验证自动标题、两段历史隔离及刷新后仍可在同一项目下切换；会话快照由 SSE 首个 refresh 读取，单次切换只下载一次初始历史；一个项目超过五段对话时，验证默认隐藏较早记录、可展开、标题的完整悬浮提示和整个项目的折叠/展开。手机视口验证顶部菜单打开完整侧栏，选择会话、点击遮罩或按 Escape 都能收起抽屉。
- 原有跨会话续聊回归保留；重试文本回归还验证部分回复紧随其最后一个 delta、位于重试通知之前，避免旧残片被追加到时间线底部。使用临时目录和模拟模型，不调用真实服务。

## 严格工具契约

- tests/tool-schema.test.ts 检查所有生产工具的 strict 对象声明：属性均列入 required，禁止额外属性；新调用的根节点包含严格的 `execution`（唯一 ID 与依赖列表）及 `arguments` 信封；单一 `git` 工具的每个 discriminated action 仅接受对应字段，diff 必须显式传 staged、paths 和 contextLines。

  此回归防止工具 schema 导致整轮模型请求被拒绝，不连接真实服务。

- tests/tool-graph.test.ts 验证独立根节点的拓扑并发与汇聚、失败节点对子孙的阻断，以及重复 ID、未知依赖和环在任何执行回调前拒绝；engine.test.ts 覆盖模型信封解析、阻断结果回传和批次事件持久化。

统一文件编辑：`files.test.ts` 覆盖 create:true 的嵌套创建、已有路径与创建期间出现路径的覆盖拒绝，以及 create:false 单文件条目中的同快照多处替换和成功修改后必须重新读取；`multi-file-edit.test.ts` 覆盖单/多文件条目的逐文件预检、重复真实路径、外部修改、审批拒绝、行号消歧、重叠拒绝、CRLF、取消，以及单文件预检/写入故障后继续独立文件、汇总全部失败路径和未知状态。

`tool-schema.test.ts` 递归检查唯一 `edit_files` 的 create 分支、无前后锚点的已有文件补丁及 strict 契约；`core.test.ts` 验证模型指令要求将参数已知、互不冲突的同一逻辑改动合并为单次 `edit_files` 调用；`engine.test.ts` 验证单次多文件调用及逐文件进度持久化；`e2e/app.spec.ts` 检查进度、diff 和刷新历史。

已有 core 测试继续覆盖未读取及外部变化拒绝。

行号搜索窗口回归：`multi-file-edit.test.ts` 覆盖行内/跨行片段、周围文本保留、末行 LF/CRLF、窗口内歧义（含重叠出现）、匹配跨出窗口、无范围外回退，以及多文件预检失败时独立有效文件仍可写入。

### 补丁定位与可见空白回归

- `tests/files.test.ts`：读取结果同时验证可复制原文、全文版本哈希和按需生成的 `visibleText` 标记。
- `tests/multi-file-edit.test.ts`：验证普通文件的唯一空白规范化候选、所有文本文件的 CRLF/LF 等价定位与原换行风格、候选行诊断、空白敏感文件对其他空白差异的严格拒绝和显式版本冲突；歧义不会修改磁盘。
- `tests/tool-schema.test.ts` 与 `tests/tracing.test.ts`：验证新工具字段通过严格 schema，且实际执行参数（含默认的 `whitespaceMode`）仍可安全导出到 trace。

## 受监督服务重载

- `tests/shutdown.test.ts`：验证未受 launcher 监督的后端以 409 拒绝重载；并以 `launcher.ts` 启动隔离后端，认证并确认重载，验证旧子进程退出后相同端口出现第二次监听记录、替代进程可取得新会话，随后确认关闭时 launcher 也正常退出。
- `tests/e2e/app.spec.ts`：验证重载需先确认；模拟替代服务使用不同本机会话 token，验证页面等待它后完整刷新。浏览器用例不运行真实编译或长期常驻的生产服务，进程替换由前一条回归覆盖。

### Replay Case

- `tests/replay-case.test.ts`：连续的同哈希 `read_file` 页可重建 `edit_files(create:false)` 的原始文件，并且只允许写入此前不存在的隔离目录；局部读取、哈希不符和已有目录均拒绝。`RecordedModelProvider` 对 input、instructions、工具定义和输出选项严格匹配，避免用旧响应掩盖改动后的行为。
- 任务执行路径的 replay 捕获与 Store 增量持久化属于默认回归；同步与 Worker 写入共用编码，落库不重复保存模型 input 公共前缀，导出恢复完整请求；手动 `pnpm replay:export` 只导出本地材料，不启动模型、工具或 Evaluation。旧历史没有完整模型载荷时导出为 legacy，不能宣称 transcript 可重放。

### Git 模型参数兼容性

模型侧 `git` 参数采用 `{ "request": { "action": "status" } }`，其他 action 的字段也放在 request 内。根节点为严格 object，request 使用嵌套 anyOf；避免服务拒绝根级 oneOf。执行前严格验证各 action 字段，再解包交给原 Git 执行器；历史扁平参数继续受原校验约束。

tool-schema.test.ts 覆盖根节点、oneOf 禁用、包装解包、历史兼容和额外/非法字段拒绝。

### Agent Runtime 阻塞等待 Broker Git push

- `tests/model-tool-batch.test.ts` 用宿主与 Runtime 共享的工具图校验在执行任何节点前拒绝含 push 和其它调用的 Runtime 批次，同时单独 push 可形成有效图。
- `tests/agent-runtime-tools.test.ts` 用真实临时 Git worktree 完成 upstream/OID 查询，随后验证 Runtime 只调用结构化 push adapter、同步取得结果，且不嵌套逐工具 SandboxBroker；Broker 已实时持久化的输出不会被 Runtime 在最终响应后重复发射。
- `tests/runtime-ipc.test.ts` 验证 `git_push` 只携带当前 `toolCallId`、返回值受固定 schema 校验；请求级取消继续只中止对应 handler。
- `tests/agent-runtime-tools.test.ts` 验证 Runtime 不再预检 Git 配置而将调用 ID 交给 Broker；`tests/agent-runtime-engine.test.ts` 验证 Broker 宿主 Git 预检、审批与已启动 push 取消的非 Sandbox 归因。
- `tests/agent-runtime-engine.test.ts` 使用真实 Node 子进程验证取消时先收到 `runtime_complete`，随后 clean 关闭；即使 Runtime 已回报终态，只要原生清理返回 orphaned，任务也记为失败、执行实例保留 unknown。安装态脚本最终核对取消后无 unknown 和活动 generation lease。
- `tests/sandbox-account-generation.test.ts` 与 `tests/sandbox.test.ts` 保留旧 Push Runner 的机制测试，但不证明当前产品 push 的网络或凭据隔离。真实 remote、凭据、hook/helper 和取消清理仍须手动验收。

### Agent Runtime 经审批的 Broker 宿主命令

- `tests/agent-runtime-tools.test.ts` 验证普通 Runtime `run_command` 不请求审批；`run_with_permissions` 只把严格命令、理由和当前 `toolCallId` 交给 adapter。`tests/agent-runtime-service.test.ts` 验证该请求保留普通 DAG 并行语义；Git push 独占由共享工具图测试覆盖。
- `tests/agent-runtime-engine.test.ts` 通过真实 Runtime 子进程验证低成本模型审批后，Broker 宿主命令可写入工作区外标记，且独立记为 `broker-command/host-process`，不会调用 Sandbox runner；命令和理由不进入任务 trace。
- `tests/runtime-ipc.test.ts` 与 `tests/tool-schema.test.ts` 验证命令/理由的有界 schema 与调用关联，并拒绝旧权限字段或其它额外参数。
- `tests/sandbox.test.ts` 和原生构建仍覆盖保留的 Capability/Push Runner 代码，但它们当前不由产品工具触发；其中 ACL、代理及限制断言不能证明现行 Broker 宿主命令或 Git push 的权限边界。

### 上下文默认摘要与旧投影兼容

- tests/context-stages.test.ts、tests/stale-reads.test.ts、tests/tool-projection.test.ts：达到阈值后默认直接摘要重复读取、过期文件读取和长工具结果；不调用哈希探测、不生成新的一级/二级投影，摘要模型收到原始全文。旧投影函数的契约仍独立测试。
- tests/stale-reads.test.ts：真实局部读取记录全文哈希，外部修改未返回行后，默认压缩不按版本归档；未到阈值不探测、不改历史。
- 核对原始事件、执行账本和重启后的快照正文回读；旧投影函数仍检查同路径保留当前版本、小正文无收益时跳过。
- 覆盖旧记录无哈希、失败/截断/编码结果、歧义 ID、无法核实、敏感/越界/缺失/过大文件、取消和探测不授予编辑凭证。
- 使用临时工作区和模拟模型，不证明真实缓存命中、真实模型理解归档提示或所有平台的文件行为。

### 保留的旧第二级工具结果归档（默认关闭）

- tests/tool-projection.test.ts 覆盖旧搜索记录保留所有位置、目录首尾清单和省略计数、失败/截断命令诊断、只读 Git 输出、Git 写操作结果保留、写入 diff 与部分成功状态。
- 覆盖来源缺失/歧义、格式未知、无退出码、已有归档和无收益结果不变；真实 SQLite 测试默认直接摘要、重启分页回读及批次状态不丢失。
- 模拟输出和模型仅验证归档契约，不证明真实模型一定能从摘录发现所有故障；Evaluation 仍仅由用户手动运行。

## Sandbox 审查回归

- `tests/sandbox-session-boundary.test.ts` 以两个真实 SQLite 会话验证 `session_compact` 的严格快照 schema、认证 session 绑定和父快照归属；跨会话写入不会改变任一会话。
- `tests/sandbox.test.ts` 交错最后引用的 native revoke 与新 acquire，确认新 lease 等撤销完成后重装共享 ACE；同时验证 capability 审批后根对象被删除重建时，Runner 在 provision 前拒绝执行。
- `tests/sandbox-account-generation.test.ts` 验证首个 provision 安装者失败会拒绝共享 waiter，且 waiter 可由自己的 AbortSignal 取消；`tests/sandbox-https-relay.test.ts` 验证并发首次 start 共用监听 promise，以及任一 tunnel 端关闭会销毁另一端并等待两端终态再移除账本。
- `tests/sandbox-git-config-graph.test.ts` 用真实临时 Git 配置验证 XDG global 在前、home global 在后的原生覆盖顺序；`tests/recovery.test.ts` 验证 `toolCallId` 与旧 `callId` 兼容，并将 Runtime 内普通工具关联到父 Agent Runtime execution instance；`tests/agent-runtime-engine.test.ts` 验证启动前 fallback 写入 Web 已支持的 `sandbox_fallback` 事件。
- `tests/sandbox-native-windows-runtime.test.ts` 验证缺少原生 rollback/completion 正向证明时一律归类 `cleanup_unknown`。C++ 构建检查 Supervisor 的失败回滚、Job 分配失败终止、askpass 同步 I/O 取消和 WFP 规则精确核对能够编译；这些不替代固定账户下的故障注入、持久 WFP 替换规则、恶意 askpass client 和崩溃恢复验收。
