# 测试约定与功能覆盖

所有功能开发均须配套合理的单元/回归测试，测试和文档属于功能交付的一部分。不要等全部开发结束后才首次运行测试。

## 开发流程

1. 明确功能正常行为、关键失败路径、边界条件；选择能够验证行为的最小测试层次。
2. 修复缺陷先增加能失败的复现用例，再修复，确认该用例通过。
3. 每完成一个可验证增量就运行相关测试。开发时可使用 `pnpm test:watch`，或 `pnpm test -- tests/files.test.ts` 定向验证。
4. 需要评估单元/回归测试的源码覆盖率时运行 `pnpm test:coverage`；在补测前先查看未覆盖分支，避免为提高数字而削弱行为断言。
5. 提交前运行 `pnpm check`（类型、lint、格式、单元/集成回归、构建）。UI、API、SSE 变更额外运行 `pnpm test:e2e`。
6. 新增行为同步维护下表与验证记录；说明平台跳过、外部依赖和未验证范围。CI 在 Windows、macOS、Linux 跑核心检查，在 Linux Chromium 跑 UI 验收。

## 共享执行逻辑回归

- `model-loop.test.ts`：响应先保存再执行工具、轮次推进、普通重试上限、超限恢复的任务级次数及 attempt 连续编号、保存/工具失败不重放、取消与无效图/正常工具耗尽轮次的区分。
- `model-tool-batch.test.ts`：两种执行模式的节点解析与依赖一致、Runtime push 独占而宿主维持原规则、退出码及多文件 failed/unknown 阻断 DAG 后继。
- `execute-runner.test.ts`：Push Runner 和 Capability Runner 的实例标识、进程元数据、事件/账本一致、非零退出、启动前后失败、取消、unknown 优先级、命令构造失败和拒绝 host fallback。
- `engine.test.ts`、`agent-runtime-service.test.ts`、`agent-runtime-engine.test.ts` 继续验证生产组装、真实 Node 子进程、工具结果回传、审批和取消记录；这些测试不替代专用账户提升环境验收。

## 测试分层

- 单元测试验证配置、授权、错误分类等可独立观察的行为。
- 集成回归使用真实临时文件、SQLite、子进程和本机 HTTP；模型通过可控适配器/SSE 服务注入预设请求与回复，验证上下文与副作用，而非只检查 mock 调用次数。
- 浏览器测试操作真实 Web UI 与测试后端，覆盖消息、历史、权限、设置、恢复与重连。
- `pnpm test`、`pnpm test:coverage`、`pnpm test:watch`、`pnpm test:e2e` 和 `pnpm check` 都经 `scripts/test-runner.ts` 启动：Vitest 子进程仅接收固定测试环境白名单，Vite 的 test 模式禁止读取 dotenv；Playwright 测试后端直接以 Node/tsx 启动，不解析包管理器的系统路径。

  测试不继承本机 `.env`、系统中的 CodeAtelier 配置或真实 API key；模型只可使用注入式模拟值和本机测试 HTTP/SSE 服务。

- `pnpm build` 与 `pnpm build:test` 还会生成 `dist/runtime/windows-x64` 下的 Node 24 Agent Runtime、compaction/read_file/subagent 三种 Worker bundle 和 SHA-256 manifest；构建成功只验证 bundle 可生成，不代表安装器已把它复制到受保护目录或 native Supervisor 已核对并启动它。
- `pnpm sandbox:runtime:verify` 是安装完成后显式运行的 Windows 产品链路验收：它使用模拟模型，经默认 Engine/SandboxBroker/native Supervisor 在专用账户 Agent Runtime 内创建工作区文件；

  随后由低成本模型夹具自动批准一次 `run_with_permissions`，让独立 Capability Runner 写入 sibling 目录，并用系统 `curl.exe` 经自身环境中的短期代理 token 请求获准但必须被 relay 以 403 拒绝的 `127.0.0.1`，从而核对外部 ACL、通用代理注入、私网拒绝、结果回传和 lease 清理。

  下一阶段初始化一次性 Git 仓库，对同一私网目标验证独立 Push Runner/askpass 路径；最后验证主动取消。该命令不属于 `test`/`check`，不会访问模型服务、外部网络、真实 remote 或凭据；只有在真实安装环境运行并输出 PASS 才构成对应平台证据。

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

行号/范围/500 行限制、分页与截断元数据、无效范围、文件大小、二进制、链接越界

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

主要测试：process.test.ts、core.test.ts、permissions.test.ts、tool-schema.test.ts。

不存在的命令及子进程实际错误、输出与退出码、截断、UTF-8/ANSI 分块、颜色环境与控制符清理、API key 不继承、内部 Windows/POSIX shell 选择、单一 command 契约、复合命令合并、直接 Git/提权拒绝、取消和超时；输出持久化失败及 stdin 提前关闭不会产生未捕获异常，停止子进程后返回错误。

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

### 网页检索与来源引用

主要测试：provider.test.ts、engine.test.ts、agent-runtime-engine.test.ts、tool-schema.test.ts、core.test.ts。

主任务请求包含 OpenAI 内置 `web_search`，宿主与 Agent Runtime 路径一致；Responses URL 引用只接受 HTTP(S)、按 URL 去重并转为可点击 Markdown 来源；内置工具不注册为本地函数或 DAG 节点

### agent 循环、任务调度与工具 DAG

主要测试：tool-graph.test.ts、tool-status.test.ts、engine.test.ts、core.test.ts、recovery.test.ts、server.test.ts。

复杂任务先读取代码/文件并获得信息后才输出计划摘要的指令与随后执行、已知参数的依赖调用同轮提交指引（依赖只能引用本轮节点，禁止跨轮历史 ID）与过时顺序指令回归、工具往返、同轮 DAG 的稳定拓扑并发、审批准备与执行槽分离、单槽下独立节点越过审批等待、并发上限、重复/未知/环拒绝、失败后继阻断与反馈；跨会话不同工作目录并行、同目录排队、同会话互斥、取消/关闭队列、步骤/上下文预算、参数错误反馈、根规则、输出预算、跨任务重新读取、不重放副作用、工具耗时排除审批等待

### 可选 subagent（内部双执行路径，尚未开放）

主要测试：subagent-contracts.test.ts、subagent-limits.test.ts、subagent-readonly.test.ts、subagent-worker.test.ts、subagent-coordinator.test.ts、model-tool-batch.test.ts、engine-subagent.test.ts、agent-runtime-subagent.test.ts、runtime-subagent-ipc.test.ts、sandbox-native-windows-runtime.test.ts、store.test.ts、session-statistics.test.ts。

已覆盖分工 action 严格校验、计划 DAG 与数量上限、单任务与跨 Runtime 的 Broker 全局 Worker lease、排队和取消；真实 SQLite 子计划、检查点、重复请求拒绝、重启中断与未知模型请求，以及与主工具反馈同分片提交的报告消费。晚完成、反馈截断或持久化失败不能误标已消费；子 Worker 只可用受限读取，读回执落盘失败立即停止，不继续模型轮次，主任务取消中断等待，每子任务消息数有界。宿主 Engine 与真实 Node Runtime 子进程的内部已标记任务均完成计划/等待/收集的模拟模型闭环；Broker IPC 拒绝未经登记的子模型、冒用主模型身份、写工具声明和重复 lease 释放，断连后留存租约直到实例确认清理。Worker 与主线程共用进程/身份，不抵御恶意代码直接使用 Node API；stdio 测试、bundle/MSVC 构建不等于固定账户提升环境或跨平台验收。HTTP/UI 仍拒绝开启，原生取消/恢复/故障矩阵尚需单独验收。

### 项目记忆

主要测试：memory.test.ts、tool-schema.test.ts、engine.test.ts。

按真实工作区 SHA-256 隔离的 Markdown 文件、严格解析/安全降级、关键词检索、archive、版本冲突、敏感内容拒绝；模型无需人工确认的 `memory_apply` 契约、任务内写入、固定检索 bundle 与仅含操作数量的任务事件。项目管理 UI、来源哈希失效验证和手工恢复/清空待后续测试覆盖

### 会话存储、标题与 Replay Case

主要测试：store.test.ts、recovery.test.ts、title-generation.test.ts、replay-case.test.ts。

`store.test.ts` 用第二个真实 SQLite 连接锁住后续历史分片，验证事务取得部分锁后失败会释放前面分片，后续事务仍可提交。

隔离、事件顺序与游标、上下文、事务回滚、queued/running/waiting 重启中断、实际开始时间、标题状态迁移和恢复，以及大 JSON 的 Worker 读取；按小阈值触发的历史 SQLite 分片、新旧分片聚合、重启发现和旧分片 Worker 读取；任务级 subagent 开关的布尔序列化、旧分片迁移默认关闭及未开放请求明确拒绝（UI 尚未启用）；逐次模型/工具捕获、legacy 历史标记、局部读取拒绝、哈希一致的分页读取重建和只写入新隔离目录

### 会话统计

主要测试：session-statistics.test.ts、e2e/app.spec.ts。

服务实报 token 的缓存/非缓存完整性、LLM 请求与任务轮次、工具成功率、任务累计运行时间、旧 usage 历史回退及默认折叠/展开展示

### 模型设置

主要测试：config.test.ts、regressions.test.ts。

连接只来自环境、settings.json 仅保存偏好、端点规范化、连接改动拒绝、参数边界、失败更新保持原状态、密钥内存存储、损坏配置不覆盖

### 日志

主要测试：logging.test.ts、core.test.ts。

级别过滤、紧凑纯文本格式、上下文字段、错误元数据/原因链/堆栈、凭据脱敏、轮转、存储故障降级

### Perfetto tracing

主要测试：tracing.test.ts、agent-runtime-engine.test.ts、runtime-ipc.test.ts、tool-graph.test.ts、e2e/app.spec.ts。

宿主与真实 Runtime 子进程的 `context.prepare`/`context.request` 及计量子阶段、独立模型与响应处理、工具计划/持久化及 instant/flow 事件导出；Runtime trace IPC 只接受固定阶段和有界数值属性，任意名称/文本字段关闭通道；主线程嵌套 begin/end slice、Task 包络、时序排序、整数 flow ID、可复用工具轨道、实际 tool 的完整结构化参数及递归凭据脱敏、按 session/task 独立持久化、终态后释放内存、认证下载、仅显示真实文件的统计框入口、关联元数据与普通长属性限长

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

主要测试：e2e/app.spec.ts、e2e/access-password.spec.ts、timeline-virtualization.test.ts。

访问密码开启时先显示门禁、错误密码不进入主页面且正确密码后加载主页面；

建会话、首条消息标题更新、已完成任务默认只显示输入和最后一轮输出，展开后可检查工具/diff/通知/重试过程且刷新后重新默认折叠、历史续聊及隔离、项目内折叠和最近记录限制、审批与取消、有流式输出工具的卡片聚合与历史重载、设置、人工恢复、Markdown 输入规则原地转换为富文本且不显示独立预览、消息中的标题/链接/代码围栏/表格/任务列表及原始 HTML 拒绝、SSE 失效重连及切换会话时的加载反馈；

手机视口可通过菜单完整打开侧栏，并由会话选择、遮罩或 Escape 收起；

时间线按滚动位置和缓冲范围只创建可视条目，其余历史以准确高度占位

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

- 原生产品构建直接编译 `native/windows-sandbox/network-fence-implementation.cpp` 并定义 `CODEATELIER_PRODUCT_WFP_ONLY`；构建后手工冒烟确认实验参数 `--ipc` 以退出码 2 被拒。实验 demo 通过薄包装编译同一实现但不定义该宏，避免产品源从 experiment 目录反向依赖。

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

`agent-runtime-engine.test.ts` 另证明 Engine 只捕获 `AgentRuntimeFallbackError` 继续宿主 loop，并把 execution instance 记为 `host-process`/`sandboxApplied=false`，同时发出供 Web 徽标使用的实际 `sandbox_stage`；已启动 Push Runner 即使 clean cancellation，也保留 `sideEffectsPossible=true`。

C++ 任务 pipe 的 PID、创建时间、Job、账户、restricted SID、固定映像检查及字节代理目前由 MSVC `/W4` 构建覆盖；安装后可用 `pnpm sandbox:runtime:verify` 验证真实完成、取消和 clean release，错误客户端及恢复故障注入仍需提升环境矩阵。

## 自举验收

`tests/bootstrap.test.ts` 覆盖固定测试命令的精确审批及错误路径、参数、shell、非命令请求拒绝。真实源码任务使用独立的手动脚本，不依赖默认 CI 密钥；准备模式不调用模型。运行与判定见 [bootstrap.md](bootstrap.md)。脚本也纳入 TypeScript 检查。

自举实测回归：engine.test.ts 验证读取带引号的凭据赋值源码后工具 JSON、上下文与任务完成仍有效；logging.test.ts 验证同类格式化日志保留关联信息与错误堆栈，含引号/反斜杠的已知密钥与嵌套字段保持脱敏。先在旧实现复现失败，再验证修复。

## 上下文压缩覆盖

context.test.ts 覆盖专用压缩 Worker 编排下的工具定义预算、完整调用批次、用户纠正原文保留、
归档分页和会话隔离、重启加载、多次压缩保留未知操作、无效摘要、事务回滚、
取消、不可压缩输入、超过 12 次摘要的完整材料覆盖及同任务继续压缩、历史工具集成及服务端容量错误只恢复一次。token 测试还核对
Worker 与主任务使用相同 token 计量和校准配置。e2e/app.spec.ts 验证整理提示、续聊完成和刷新后的原历史。
测试使用模拟模型；摘要语义质量、真实模型容量与长期压力仍需单独评估。Store 的 Worker 回归使用超过 64 KiB 的真实 SQLite JSON，验证线程外读取不改变数据；压缩回归验证语义和取消，但尚未以压力测试证明任意负载下的 HTTP/SSE 响应延迟上界。

## token 容量与用量

tokens.test.ts 覆盖容量预留、备用模式、中文/代码/工具与特殊 token 字面量、usage 校验、压缩计量一致性、输出预留传参、用量重启持久化和实报校准。session-statistics.test.ts 覆盖 model_request、实报缓存/非缓存聚合、旧 usage 回退、工具成功率和运行时长；e2e/app.spec.ts 覆盖统计默认折叠、展开后 token/LLM/工具展示、预算模式、服务实报用量及刷新保留。

provider.test.ts 用本机 HTTP/SSE 验证模型容量和 usage 提取。真实服务最小探测见 model-tokens.md。

## 渐进压缩覆盖

context-stages.test.ts 先复现旧实现遗漏长记录中间材料，再验证全文连续覆盖、完全相同读取零模型调用、文件归档与中间诊断行、不同文件版本不合并、文件读取投影不处理命令/失败/未知输出、归档后再次摘要还原全文、旧摘要原文与来源不漂移。既有 context.test.ts 继续覆盖事务回滚、取消和恢复。

## SWE-bench 评测（仅手动）

`evals/evaluation.test.ts` 保留生产工具、预算、用量缺失、超时和目录隔离测试。`scripts/swebench/test_contract.py` 覆盖固定清单合法性、提示词不泄露答案、打包白名单。所有评测测试只在用户要求后执行；不加入默认 test/check、CI 或钩子。

手动入口：`pnpm eval:test` 和 `python -m unittest discover -s scripts/swebench -p 'test_*.py'`。评分使用官方 harness，不以 agent completed 或本地测试退出码冒充解决率。运行说明见 [swebench.md](swebench.md)。

## 完整请求与压缩覆盖

context-request.test.ts 覆盖低于阈值时重复读取结果原样发送、原始输入计量、瞬态重试和新工具轮次保持完整历史。context-stages.test.ts 覆盖达到阈值后的读取去重、归档和摘要。context.test.ts 额外覆盖常规摘要在超预算失败时的保底视图：完整快照保留，活动输入保留用户原文与最新结论，并移除超长中间工具输出。

git-tools.test.ts 覆盖 diff 独立输出硬上限；core.test.ts 覆盖模型收到避免无必要全量 diff 的指令。它们均属于普通功能回归，不启动 Evaluation。

评测报告手动回归 `scripts/swebench/test_report.py` 覆盖缺失数据不当作零或失败、官方回归测试失败、补丁头排除、缺失工具结果、非零测试退出和分位数样本口径。该套件不进入默认 test/check。另覆盖 list_files 数组形式的工具结果；2026-09-12 用户授权三题评测期间，报告回归 6 项通过。

准备镜像的手动契约用例验证：使用固定 image ID 后不访问 registry 或远程 task spec。仍通过独立手动测试入口执行，不加入默认检查。

### 思考等级配置

配置测试覆盖旧配置默认 high、环境默认值、保存后重载和非法值原子拒绝；模拟 HTTP/SSE 测试核对各等级及缺省值的实际请求体；浏览器测试覆盖默认展示、修改保存与刷新回显。未验证真实模型服务对各等级的接受及计算行为。

镜像刷新手动回归 `scripts/swebench/test_refresh.py` 覆盖新运行包上传与文件校验、镜像结果记录、base_commit 不匹配时不提交镜像且清理容器。本次按 Evaluation 约定仅静态检查，未执行该套件。

- 连接配置：缺少地址/模型时即使有旧 settings.json 也启动报错；API 地址和模型标识只从环境读取并规范化端点，settings.json 只保存偏好且拒绝竞争来源；单元与浏览器测试使用独立模拟配置，并回归验证测试进程只可见固定测试连接且 API key 为空。

### 辅助模型

- `tests/auxiliary-model.test.ts`：旧配置兼容、主模型继承、环境辅助模型来源、可保存推理强度、模型改动拒绝、非法输入拒绝；生产 Engine 路由、辅助模型独立预算、完整摘要来源、摘要失败保留历史。使用模拟模型，不访问真实服务。
- `tests/title-generation.test.ts`：首条 prompt 选择辅助模型、输入分隔和输出清理、未知标题模型故障最多额外重试 3 次、永久失败不阻断主任务、取消结束标题状态，以及旧 SQLite 标题迁移。
- `tests/model-approval.test.ts`：审批请求只将工具名和待审批内容发送给无工具、256 token 的低成本模型；严格 JSON 输出分别自动通过、保留人工点击或直接拒绝并返回理由；检查工作区内常用开发命令被 prompt 明确要求直接 `approve`，分类器缺失时不自动放行。
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
- 任务执行路径的 replay 捕获与 Store 持久化属于默认回归；手动 `pnpm replay:export` 只导出本地材料，不启动模型、工具或 Evaluation。旧历史没有完整模型载荷时导出为 legacy，不能宣称 transcript 可重放。

### Git 模型参数兼容性

模型侧 `git` 参数采用 `{ "request": { "action": "status" } }`，其他 action 的字段也放在 request 内。根节点为严格 object，request 使用嵌套 anyOf；避免服务拒绝根级 oneOf。执行前严格验证各 action 字段，再解包交给原 Git 执行器；历史扁平参数继续受原校验约束。

tool-schema.test.ts 覆盖根节点、oneOf 禁用、包装解包、历史兼容和额外/非法字段拒绝。

### Agent Runtime 阻塞等待 Push Runner

- `tests/agent-runtime-service.test.ts` 在执行任何节点前拒绝含 push 和其它调用的同一工具批次；单独 push 可形成有效图。
- `tests/agent-runtime-tools.test.ts` 用真实临时 Git worktree 完成 upstream/OID 查询，随后验证 Runtime 只调用结构化 push adapter、同步取得结果，且不嵌套逐工具 SandboxBroker；Broker 已实时持久化的输出不会被 Runtime 在最终响应后重复发射。
- `tests/runtime-ipc.test.ts` 验证 `git_push` 只携带有界 PushSpec 和当前 `toolCallId`、返回值受固定 schema 校验；请求级取消继续只中止对应 handler。
- `tests/sandbox-account-generation.test.ts` 验证已占用任务并发名额的 Agent Runtime 可在同一工作区重叠一个 Push Runner，但第二个 Runner 或新任务仍受并发约束。
- `tests/sandbox.test.ts` 验证 Push Runner 后端缺失时不调用宿主 executor。真实 relay、凭据、hook/helper、取消清理和 remote push 仍须在固定账户提升环境手动验收。

### Agent Runtime 扩展权限命令

- `tests/agent-runtime-tools.test.ts` 验证普通 Runtime `run_command` 不请求审批；`run_with_permissions` 只把严格命令/权限/理由和当前 `toolCallId` 交给 adapter。`tests/agent-runtime-service.test.ts` 还验证扩展权限请求保留普通 DAG 并行语义，而 Git push 继续独占批次。
- `tests/agent-runtime-engine.test.ts` 通过真实 Runtime 子进程验证低成本模型可自动批准 capability 请求，Broker 收到规范化读写根、host 与原工具调用 ID，并把独立 Runner 的输出和终态送回 agent loop/session；任务 trace 保留经统一脱敏后的完整工具参数。
- `tests/runtime-ipc.test.ts` 验证扩展权限请求的有界 schema 与调用关联，空权限、额外字段或无效 host 在跨进程处理前拒绝。
- `tests/sandbox.test.ts` 验证一个阻塞 Agent Runtime 可重叠一个 capability runner，审核后的读写根进入该 Runner 的 AccessManifest，且禁止调用宿主 fallback。
- C++ Supervisor 为 capability runner 将短期 host-bound proxy token 仅放进该 Runner 的代理环境，不查询 WinCred；Push Runner 继续使用同 Job askpass。原生构建只验证代码与协议可编译，固定账户下的递归根 ACL、真实 HTTPS client、取消、proxy lease 撤销和 generation drain 仍需提升环境验收。

### 文件版本过期归档

- tests/stale-reads.test.ts：真实局部读取记录全文哈希，外部修改未返回行后，第一级按版本归档；未到阈值不探测、不改历史。
- 核对协议配对、原始事件、执行账本和重启后的快照正文回读；同路径保留当前版本，小正文无收益时跳过。
- 覆盖旧记录无哈希、失败/截断/编码结果、歧义 ID、无法核实、敏感/越界/缺失/过大文件、取消和探测不授予编辑凭证。
- 使用临时工作区和模拟模型，不证明真实缓存命中、真实模型理解归档提示或所有平台的文件行为。

### 第二级工具结果归档

- tests/tool-projection.test.ts 覆盖旧搜索记录保留所有位置、目录首尾清单和省略计数、失败/截断命令诊断、只读 Git 输出、Git 写操作结果保留、写入 diff 与部分成功状态。
- 覆盖来源缺失/歧义、格式未知、无退出码、已有归档和无收益结果不变；真实 SQLite 测试阈值、重启分页回读、后续摘要前展开全文及批次状态不丢失。
- 模拟输出和模型仅验证归档契约，不证明真实模型一定能从摘录发现所有故障；Evaluation 仍仅由用户手动运行。

## Sandbox 审查回归

- `tests/sandbox-session-boundary.test.ts` 以两个真实 SQLite 会话验证 `session_compact` 的严格快照 schema、认证 session 绑定和父快照归属；跨会话写入不会改变任一会话。
- `tests/sandbox.test.ts` 交错最后引用的 native revoke 与新 acquire，确认新 lease 等撤销完成后重装共享 ACE；同时验证 capability 审批后根对象被删除重建时，Runner 在 provision 前拒绝执行。
- `tests/sandbox-account-generation.test.ts` 验证首个 provision 安装者失败会拒绝共享 waiter，且 waiter 可由自己的 AbortSignal 取消；`tests/sandbox-https-relay.test.ts` 验证并发首次 start 共用监听 promise，以及任一 tunnel 端关闭会销毁另一端并等待两端终态再移除账本。
- `tests/sandbox-git-config-graph.test.ts` 用真实临时 Git 配置验证 XDG global 在前、home global 在后的原生覆盖顺序；`tests/recovery.test.ts` 验证 `toolCallId` 与旧 `callId` 兼容，并将 Runtime 内普通工具关联到父 Agent Runtime execution instance；`tests/agent-runtime-engine.test.ts` 验证启动前 fallback 写入 Web 已支持的 `sandbox_fallback` 事件。
- `tests/sandbox-native-windows-runtime.test.ts` 验证缺少原生 rollback/completion 正向证明时一律归类 `cleanup_unknown`。C++ 构建检查 Supervisor 的失败回滚、Job 分配失败终止、askpass 同步 I/O 取消和 WFP 规则精确核对能够编译；这些不替代固定账户下的故障注入、持久 WFP 替换规则、恶意 askpass client 和崩溃恢复验收。
