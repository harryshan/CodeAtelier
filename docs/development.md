# 开发、配置与排错

## 环境与命令

Node.js 24，pnpm 11.22.0（packageManager 固定）。提交 pnpm-lock.yaml，使用 pnpm install --frozen-lockfile 重现依赖。esbuild 的安装脚本在 pnpm-workspace.yaml 中明确允许。

| 命令                                                                  | 用途                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| pnpm dev                                                              | 后端源码监听，默认 `127.0.0.1:4142`；tsx watch 在源码更新后重启后端       |
| pnpm dev:web                                                          | Vite 前端，默认 `127.0.0.1:5173`；读取相同监听地址并通过 HMR 更新前端模块 |
| pnpm build                                                            | 编译后端和前端                                                            |
| pnpm start                                                            | 运行构建后的本机服务；由监督进程支持 UI 确认后的后端重载                  |
| pnpm typecheck / lint / test                                          | 类型、静态规则、核心测试；test 只使用白名单测试环境                       |
| pnpm check                                                            | 类型、lint、核心测试、测试模式构建                                        |
| pnpm test:e2e                                                         | 先进行不读取 dotenv 的测试模式构建，再启动独立模拟服务验证浏览器交互      |
| node --env-file=.env --import tsx scripts/probe-model-capabilities.ts | 检查模型窗口、计数接口及真实 usage（少量模型调用）                        |
| node --env-file=.env --import tsx scripts/probe-responses.ts          | 使用环境变量密钥测试真实服务工具往返                                      |
| node --env-file=.env --import tsx scripts/smoke-agent.ts              | 在 .local 下创建隔离项目，真实模型修复并运行测试                          |

脚本只接受环境变量密钥，不内置真实凭据；真实验证会消耗配置服务的模型额度。smoke-agent 只自动批准它自己创建的示例项目内固定 node --test 命令。

## 配置

后端启动时读取本地 `.env`。API 地址、主模型和可选辅助模型的唯一来源是 `.env` 或进程环境；无论是否已有 `settings.json`，都必须提供 API 地址和主模型，否则启动明确报错。设置界面只读显示连接字段，修改 `.env` 后须重启或重载服务。访问密码门禁也只在服务启动时读取环境变量，修改后同样须重启或重载。推荐通过 Web UI 为当前进程输入密钥，或使用环境变量；本地 `.env` 仅供开发使用，不提交 Git。

| 环境变量                         | 默认 / 用途                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| CODEATELIER_BASE_URL             | 无默认值；在 .env 填写实际 API Base URL                                             |
| CODEATELIER_MODEL                | 无默认值；在 .env 填写服务公布的完整模型标识                                        |
| CODEATELIER_REASONING_EFFORT     | high；可选 low、medium、high                                                        |
| CODEATELIER_API_KEY              | 无默认值                                                                            |
| CODEATELIER_DATA_DIR             | 平台用户数据目录                                                                    |
| CODEATELIER_PORT                 | 4142                                                                                |
| CODEATELIER_LISTEN_ADDRESS       | `127.0.0.1`；可选 `::1`、`0.0.0.0`（开放 IPv4 局域网）或 `::`（开放 IPv6 局域网）   |
| CODEATELIER_WEB_PASSWORD_ENABLED | false（未设置或空值）；显式值只能为 `true` 或 `false`，启用 Web UI 单一访问密码门禁 |
| CODEATELIER_WEB_PASSWORD         | 无默认值；开关为 `true` 时必须为非空密码，不写入设置、浏览器配置或日志              |
| CODEATELIER_LOG_LEVEL            | info                                                                                |
| CODEATELIER_SANDBOX_ENABLED      | false；只接受明确的 `true` 或 `false`；启动后不可动态切换                           |

### 配置来源与优先级

`settings.json` 只保存非连接偏好：主/辅助模型的思考等级、任务限制（包括 `maxConcurrentTasks`）和日志级别；通过 UI 修改。已保存偏好优先于同名环境默认值。API 地址、主/辅助模型标识绝不写入该文件；旧版本留下的同名字段会在读取时忽略，并在下一次保存偏好时移除。密钥始终来自环境或当前进程内存，不写 `settings.json`。存在运行中或排队任务时禁止修改配置。

### Windows Sandbox 配置与启动

`CODEATELIER_SANDBOX_ENABLED` 在 Windows 启用专用账户原生预览后端；macOS/Linux 明确保持关闭。关闭时 `run_command` 完全沿用原有宿主 shell、审批、取消和恢复路径。启用后，缺少后端、工作区 preflight 或 Runtime 自检在命令启动前失败会产生 `host-process-fallback` 时间线警告，并以原宿主 shell 自动继续；同一任务后续命令保持宿主模式。

Runtime 执行开始后的错误标为 `unknown`，绝不自动重放；ACL/Job 清理失败即使同时收到取消也优先记为 unknown/orphaned，冻结 account generation，调用原生账户进程终止和 ACL journal 对账。服务监听前主动执行同一恢复路径，以清理上次进程崩溃遗留；恢复失败会记录安全错误并使后续 Sandbox self-check fallback，不阻止宿主服务启动。

实际模式按 task/execution instance 保存并通过工具结果公开，不读取并发任务共享的“最近状态”。Sandbox 生命周期另写入平台数据目录的 `logs/sandbox.log`。

Runtime IPC 失败在会话中显示具体 operation、requestId、错误码和脱敏后的实际原因，保留最多三层 cause；不序列化异常附带的请求/响应正文。错误消息最多 1000 字符，截断会标明。模型总超时指出 `requestTimeoutMs` 的毫秒数和未收到完成事件，流空闲超时指出 `idleTimeoutMs` 及无事件时长；两者继续沿用现有有界重试。总时限不会随流事件延长。校验失败指出字段路径和校验代码，不回显请求值；没有详细异常时明确说明处理程序未提供详情，并保留操作和关联 ID 供定位。Broker 模型失败日志只增加显式脱敏、限长的错误摘要，trace 继续只保存受控错误码/类型等元数据。

`runtime-capability-core.ts` 提供传输无关的一次性 command grant 与模型代理核心；`runtime-ipc-*`、`AgentRuntimeService` 和 Runtime 侧 adapter 已实现完整 agent loop 的应用层边界。

Windows 且 Sandbox 开启时，`createApp` 默认注入 `SandboxBroker` 作为 `AgentRuntimeLauncher`：Engine 通过 C++ Sandbox Supervisor 启动每任务一个常驻 Agent Runtime，模型、session、审批和 memory 经任务专属 Runtime IPC 返回 Broker；禁用、非 Windows 或可证明启动前完整回滚的 fallback 才由 Broker Host 运行 loop。

独立 Push Runner 和 Capability Runner 代码保留但暂不用于产品路径；获批 `run_with_permissions` 命令与全部 Git 工具 action 在 Broker 宿主用户权限下运行并分别归因。固定账户提升环境的身份、崩溃/取消/恢复矩阵尚未完成，因此仍不能宣称 W3/W4 完成。

严格术语、目标完成判据与分层验收见 [Windows 专用用户 Sandbox Runtime 与 Broker 架构](windows-integrity-sandbox.md#0-术语进程和完成条件)。

每个已批准的 `run_command` 启动的受限子进程，在执行前创建不可复用的 `executionInstanceId`，并复用同一 SandboxBroker 与宿主 fallback 规则；Git 工具在 Broker 宿主进程中另行记录 `broker-git`/`broker-git-push` execution instance。

子进程获得 PID 时立即把 PID 和 `host-process | runtime-launcher | runtime` 类型追加到 session，并把 created/running/completed/cancelled/unknown 状态同步写入 `sandbox.log` 和 Perfetto trace；记录不包含命令、路径或输出。

取消与 cleanup unknown 同时发生时，session 状态必须为 `unknown`，不能被取消信号覆盖。Windows 原生 supervisor 回传 launcher 与真实 Runtime PID；当前 push 使用 `broker-git-push/host-process` kind/mode。

`supervisor-protocol.ts` 保留 Broker→长期控制面候选的 strict schema；当前产品执行链使用固定 supervisor argv 加有界二进制 stdin 帧，Agent Runtime 再通过任务专属 Named Pipe 与 Broker stdin/stdout 字节代理通信。

C++ 已核对安装副本摘要以及 Runtime 客户端 PID、创建时间、Job、账户 SID、restricted execution/root capability、固定映像、instance/nonce；协议和 native build 回归已覆盖代码路径，但仍须在固定产品账户提升环境完成错误客户端、PID 复用、断连和故障注入，不能把 schema 或构建成功当成平台验收。

`supervisor-channel.ts` 在已建立的私有 input/output handle 上提供 64 KiB 上限的 JSONL 帧、并发 requestId 路由和 AbortSignal 等待取消。超限、非法 JSON、缺失或未请求 requestId 会使整条通道失败，上层必须把可能已启动的实例记为 unknown/orphaned。

Abort 只表示 Broker 不再等待，不等于 Runtime 已终止；取消仍必须另发 `terminate_runtime` 并获得清理结果。

### Web 访问密码

访问门禁在服务启动时读取 `CODEATELIER_WEB_PASSWORD_ENABLED` 与 `CODEATELIER_WEB_PASSWORD`：默认关闭；设为 `true` 时密码不能为空，否则服务拒绝启动。启用后，浏览器必须先在门禁页提交正确密码，服务才会发放仅本进程有效的 HttpOnly、SameSite=Strict cookie，并允许读取 bootstrap、会话、SSE 及其他 API；密码不会发送到前端构建环境、持久化设置或日志。

关闭或重启服务会轮换该 cookie，需再次验证。它是单一共享密码，不提供账户、用户身份、角色、找回密码、限流或公网安全保证。

### 模型思考等级与限制

思考等级在“模型与设置”中选择，保存为 `reasoningEffort`；主任务 Responses 请求显式发送 `reasoning.effort`。未配置辅助模型时标题和上下文摘要沿用主模型设置。默认 high，旧配置缺少字段时采用环境默认值或 high。例如 `.env` 中设置 `CODEATELIER_REASONING_EFFORT=high`；已保存偏好优先，保存后用于后续调用。

辅助模型标识由 `CODEATELIER_AUXILIARY_MODEL` 决定，其推理强度 `auxiliaryReasoningEffort` 可按同一规则保存，供标题和上下文摘要使用。自动审批仍选用辅助模型，但仅在该次 Responses 请求覆盖为 `reasoning.effort: "none"`，不修改已保存的辅助等级；服务或模型不支持 `none` 时降级到人工确认，不用原思考等级重试，也不以主模型替代未配置的辅助模型。其它模型请求不支持所选等级时按现有错误流程报告，不静默降级。

默认限制：每任务 100 次模型调用、命令 120 秒、模型请求总计 300 秒、流空闲 60 秒、备用上下文 1000000 字符、单工具输出 32000 字符；全局 `maxConcurrentTasks` 默认 2，允许 1～4。这是可配置字符预算，不是精确 token 计量。发现服务容量和支持的 tokenizer 后改用 token 预算，contextChars 仅备用；已保存的自定义值继续生效，缺失时使用新默认值。maxOutputTokens 默认 16384。

输入预算扣除输出与安全余量后，达到 80% 时尝试压缩；完整输入不超过实际预算的 60% 且比压缩前更小才提交，不另设 10% 收益门槛。失败保留原历史，超过硬上限且保底整理仍失败则停止。实测值和用量展示见 [model-tokens.md](model-tokens.md)。详见 [上下文管理](context-management.md)。高级字段可在没有运行中或排队任务时编辑 settings.json 或通过设置 API 更新。

## 数据与日志

- Windows：%LOCALAPPDATA%/CodeAtelier
- macOS：~/Library/Application Support/CodeAtelier
- Linux：$XDG_DATA_HOME/CodeAtelier，未设置则 ~/.local/share/CodeAtelier

目录包含首个兼容历史分片 history.sqlite（及其 SQLite WAL 文件）、按需新增的 history-000001.sqlite 等后续分片、settings.json、logs/app.log 和 traces/<sessionId>/<taskId>.json。Store 统计每个分片主库与 WAL 的实际字节数；默认到 1 GiB 后，下一次**新建会话**写入新的分片。

已有会话始终位于其初始分片，避免跨文件外键与恢复语义变化；因此单个超长会话或不可分割的大写入可以略超该阈值，现有超限历史不会自动重分区。历史会话、运行日志与 Perfetto trace 分开保存，不写入用户代码项目。

历史升级到增量上下文格式时，每个含会话的旧 SQLite 分片会在首次打开、变更 schema 前，使用 SQLite 一致性备份写入数据目录的 `backups/<原分片文件名>.<时间>.<随机 ID>.sqlite`；备份失败会阻止启动及迁移，不应删除或绕过该目录。备份包含完整会话和工具结果，按原始历史文件保护，定期按需要自行归档，不会自动清理。迁移将旧 `context` 的原始 JSON 作为首批协议项；新写入仅追加批次，压缩则原子替换当前基线与压缩快照。读取、续聊和导出时按顺序重建完整活动上下文，历史事件、旧快照和 replay 不会重写。

### Perfetto tracing

tracing 默认启用：每个实际开始的任务在当前服务进程内生成一条性能 timeline。

宿主 loop 的模型请求、上下文准备/压缩、模型重试退避、响应处理、工具计划及工具结果的 SQLite 持久化都在 `Main thread` 轨道记录；Runtime 的上下文计量、结果持久化等待与线程池清理归于已验证 PID 的 `Agent Runtime` 轨道，实际数据库提交仍归 Broker 的 Store worker。Runtime 压缩的异步 session 事件时间只是 Broker 观察时刻，单列于同进程的 `Agent Runtime compaction` 轨道，不冒充 Runtime 精确执行区间。主线程和 Runtime 的上下文轨道均以可嵌套的 begin/end slice 导出：`context.prepare` 保持在实际准备/压缩边界内，其子阶段记录预算输入计量与压缩；`context.request` 保持在实际请求边界内，其子阶段记录完整输入计量。

模型请求、退避及响应处理保持独立，以便区分上下文处理与模型服务耗时，且不会产生完整事件交叠。`Task` 是任务生命周期包络；工具批次、参数检查、审批等待与依赖阻塞保留在 `Tool scheduler` 逻辑轨道，只有审批通过并准备实际执行的调用才排队取得最多 4 条可复用 `Tool worker 1` 至 `Tool worker 4` 轨道，后续节点复用最先空闲的槽位。

这些槽位表示并发操作而不是 Node 物理线程，人工审批耗时不会显示为 worker 占用。`read_file` 的路径授权与解析发生在执行槽取得之前，不另建准备片段；取得槽位后，文件检查、字节读取、Worker 排队、冷启动等待和响应阶段在调用对应的 `Tool worker`（Agent Runtime 路径为可复用的 `Agent Runtime tool 1`～`4`）轨道上嵌套显示于 `tool.read_file`。这些工具轨道是逻辑并发槽，不是物理线程；Worker 的计算不再另建 trace 轨道，响应片段仍附纯计算耗时 `computeMs`，不能把响应总耗时当作磁盘或 CPU 耗时。`read_file.worker.startup` 从首次向刚创建的 Worker 分派请求起计，到调用侧收到该 Worker 的 `ready` 消息为止，包含剩余线程启动、模块加载和消息调度等待，并非纯文件处理耗时；开发环境的 `.ts` Worker 还需加载 `tsx`。池在任务内按需扩展至最多 4 条真实线程，已创建线程跨模型轮次复用，不在空闲时释放；成功、失败或取消后的任务收尾显式等待全部线程退出，记录 `read_file.pool.close` 耗时与终态，清理失败将任务标为失败。热 Worker 没有冷启动阶段；尚无具体 trace 时不能把某次偏长归因于其中单一因素。阶段仅附 callId、有界字节数及计时，不保存路径或内容；Runtime IPC v4 的 trace span 必须携带单调时间戳（旧版本拒绝握手），固定白名单上报这些阶段及取得执行槽后的工具执行边界；Broker 校验任务时间窗、以已验证 Runtime PID 分组、按槽号分配复用轨道、从已保存的 tool_start 提取参数，统一导出落盘。Runtime 的 `Agent Runtime` 主轨道展示上下文和池关闭；`tool_start` 到取得执行槽之间是排队/准备时间，不冒充实际执行；尚未开放的 subagent `await` 在槽位之前等待，不把事后取得槽位误记为工具执行。获批 Broker 命令仍在 Broker 的宿主执行轨道记录，Runtime 工具片段表示等待其结果，不能称为在 Sandbox 内执行命令。每个实际 tool span 的 `args.parameters` 保存传给执行器的完整结构化参数，递归遮盖 API key、token、password、authorization、cookie 及 Bearer 值；因此 trace 文件可能含命令、路径和编辑文本，必须按敏感本机诊断数据保护，不能上传或提交。

导出会按时间排序，并以递增整数而非 UUID 标识 flow，保证 Perfetto Trace Event JSON importer 可解析。任务进入 completed、failed、cancelled 或 interrupted 终态后，安全 JSON 原子写入 `traces/<sessionId>/<taskId>.json`，同一会话的任务各用独立文件，绝不覆盖；写入完成或失败后立即释放该任务的内存记录，不保留完成 trace 缓存。

统计框通过受保护的 `GET /api/sessions/:id/traces` 查询实际存在的文件，只有已保存 trace 才显示下载入口；`GET /api/tasks/:id/trace` 也只读取该文件并可在 [ui.perfetto.dev](https://ui.perfetto.dev) 打开。接口不接受写入，也沿用 cookie 校验；任务不存在、仍在执行或尚未成功保存 trace 时返回 404。

常规 SQLite 请求在 `Store queue` 和 `Store worker` 两条独立 Perfetto 轨道展示排队和执行/提交回执；轨道只记录任务与请求 ID、操作类别、耗时和失败类别，不记录 SQL 参数或持久化正文。Worker 故障会使当前及待处理写入失败，不自动重放；诊断后人工恢复。未迁移的同步兼容入口及未开放的 subagent 账本不走此队列，与 Worker 写同一分片时主线程连接最多等待 SQLite 写锁 1 秒；仍可能短暂阻塞主线程，不能将其计入 Store worker 轨道。

trace 含关联 ID、模型名称、步骤/尝试、字节/项目数量、usage、退出/错误类别、耗时及已脱敏的完整工具参数；不含完整提示词、模型输出、工具输出或服务错误正文。tool 参数中的源码、命令与路径会持久化到本机 trace，API key、认证头、cookie、token 与 password 等值会递归遮盖。它不是会话历史、运行日志或高保真 replay 存档；服务重启不影响已结束任务的 trace 文件下载。

Replay Case 已独立实现脱敏、存储与手动导出，见 [任务 Replay Case](replay-cases.md)；原始模型 payload 不进入 Perfetto 属性。

新增或修改 agent、模型、工具、审批、上下文、存储或跨进程执行功能时，开发者必须同步增加合理 tracing，至少覆盖开始/结束、失败或取消、耗时、任务/调用关联及安全摘要；若确实不适用，须在设计或决策记录中说明原因。测试应覆盖新增 span 的可导出行为及敏感原文不进入事件属性。

日志支持 trace/debug/info/warn/error，默认 info。文件和终端均为紧凑纯文本，例如 `2026-09-15T12:00:00.000Z INFO  agent task.started | session=… task=…`，不输出 JSON；固定的应用、进程和主机字段不重复写入。任务日志带 sessionId/taskId，工具日志包含 toolCallId、耗时和成功状态。

错误记录保留脱敏且限长的名称、实际错误消息、受控错误码/状态、原因链和堆栈，不能只写 errorName；模型服务只提取协议错误对象的 message/reason/code，命令保留 shell 的 stdout/stderr，均不记录完整响应正文、完整源码或提示词。日志按约 10 MiB 轮转，共最多 5 个文件；DEBUG 可查看模型步骤。已知密钥和认证信息在格式化前脱敏。

## 代码阅读策略

模型先用受审批的 `run_command` 浏览目录，再执行任务指令中预先检测、按估计性能排序的搜索命令，按符号名、错误文本、测试名或配置键定位。普通代码或文件读取只要可由这些目标定位，就必须先搜索，并围绕命中行号读取最小必要范围；仅在搜索不适用、命中内容或当前上下文不足时扩大读取范围。

检测覆盖常见的 `rg`、`ugrep`、`ag`、`pt`、`ack`、`grep`、PowerShell `Select-String`、`findstr` 内容搜索，以及 `fd`、`fdfind`、POSIX `find` 文件名搜索，只报告当前 PATH 实际可用的项目；Windows 的 `findstr` 还检查系统位置，`Select-String` 仅在已选中的 PowerShell shell 可用时报告。

优先使用列表中首个适合内容或文件名目的的工具；性能排序是通用估计，不代替具体工作区的基准。一个命令支持时应以多模式参数一次搜索多个相关关键词，而不是逐个关键词重复调用；随后用 `read_file` 围绕输出行号读取。普通代码定位默认从 80～200 行开始，只在上下文不足时继续扩展；短文件、`AGENTS.md` 或确有全局分析需要时才读取完整文件。

同一任务内可复用未变化文件的已读取范围；已有文件每次被 `edit_files` 成功修改后，必须再次 `read_file` 才能继续修改。新任务、外部变化、编辑冲突或上下文不足时同样必须重新读取。

`read_file` 必须提供 `startLine` 和 `endLine`，每次最多返回 500 行。结果额外携带全文字节的 SHA-256 `contentHash`，供阈值压缩识别过期版本；它不代替编辑前的读取凭证与并发检查。

结果的 `returnedEndLine` 表示实际最后一行，`truncated` 表示请求因行数上限未完整返回，`hasMore` 表示文件后面还有行，`nextStartLine` 给出继续读取的位置（没有后续行时为 `null`）。执行器当前为检查 UTF-8、二进制、行数和编辑前的内容哈希，仍会在后端读取不超过 2 MiB 的整个文件；行范围限制的是发送给模型和保存到会话的文本，不承诺同等粒度的磁盘 I/O。

对于需要多步骤调查、跨文件修改或验证的复杂任务，模型采用 plan-and-execute：先用只读工具读取项目约定、相关目录、代码和文件，获得足够的当前事实后，才以中文 Markdown 向用户显示简洁的“计划摘要”，列出目标、有序步骤、预期验证以及重要假设或审批边界；不得在读取代码或文件前凭假设产出计划。然后无需等待计划确认，立即通过工具执行这份基于证据的计划。该文本和同轮后续工具调用一起返回时，Engine 会先持久化并推送文本，再开始工具执行。

后续证据要求实质偏离原计划时，模型应在走新路径前发送修订摘要。简单问答、一次直接读取或琐碎修改不要求单独计划；计划不会取代已有的权限确认。

模型在每轮响应前，应找出参数已知且安全的相关调用，一次返回，而不是为下一项已知调用再请求模型。独立调用使用空 `dependsOn`；若后项参数已知、只需前项成功，则在同一响应中声明依赖。例如精确修改和验证命令都已确定时，把 `edit_files` 与 `run_command` 一起返回，让后者依赖前者；独立验证也可共同依赖修改。只有需要前项结果来构造后项参数、解释结果或决定下一步是否合适时，才另开模型轮次。

不得猜测参数、预先提交未经复核的变更、并行写入冲突资源，或为凑批次扩大工作范围。

### 工具批次与依赖

模型可在一次 Responses 请求中返回多个工具调用（包含读取、写入、命令和 Git），每项统一使用 `{ execution: { id, dependsOn }, arguments: { ...工具原参数 } }`。

`id` 在该响应中唯一；`dependsOn` 只可引用**本轮响应内**其他工具调用的 `execution.id`，不能引用上轮或更早响应的 node ID、`execution.id` 或工具调用 ID；历史结果不是本轮 DAG 节点。它只列出必须成功完成的前置 ID，不能用前置工具结果填充本调用参数。Engine 在任一节点执行前校验整批 DAG 的 ID、引用和环，以模型返回顺序作为同层稳定次序，最多并发执行 4 个前置条件满足的节点。

返回顺序本身不保证串行；不会按工具类型、文件路径或命令文本推断冲突，模型必须为共享资源、写后读取或命令顺序显式声明依赖。前置失败、拒绝或部分失败会阻断其全部后继，后继返回 `dependency_failed` 而不执行；无关节点继续。旧的无信封历史调用按无依赖节点兼容。

所有已有文件的精确修改应尽量使用一个 `edit_files` 调用：参数已知、互不冲突且不依赖其他工具结果的同一逻辑改动，必须将不同文件合入同一个调用，而不是按文件拆分；同一路径的多处修改合并在一个文件条目，单文件也使用一个文件条目。已知的顺序命令或管道仍可写入一条 `run_command`；独立验证或依赖已知修改的验证优先使用同一 DAG 响应中的单独调用。搜索在支持时合并多个关键词。

`run_command` 的模型参数只有 `{ command }`，工作目录固定为会话工作区。服务内部在 Windows 检查 `PATH`、`SystemRoot` 和 `ComSpec`，按 `pwsh`、`powershell`、`cmd.exe` 的优先级选择第一个真实存在的 shell；macOS 和 Linux 使用已验证的 `/bin/sh`。

执行器追加固定的非交互参数（PowerShell 为 `-NoLogo -NoProfile -NonInteractive -Command`，cmd 为 `/d /s /c`，POSIX shell 为 `-c`），模型既不提供也不探测这些细节。完整复合命令仍作为一次副作用审批；不要求或保存命令间的人工分隔标记。

`run_command` 和 `git` 的每次流式输出都以工具调用 ID 保存。Web UI 将有流式输出工具的开始、所有输出分块和退出状态聚合在同一可展开卡片中，任务完成或刷新历史后仍可查看。工具结果和诊断日志的耗时从执行器真正开始读取、写入或启动子进程时计算，不包含用户在审批界面的等待时间；因拒绝或预检失败而未实际执行的调用显示为 0 ms。

Windows 专用账户 Agent Runtime 的普通命令使用实例私有 TEMP 中的独占临时文件承接 stdout/stderr，每 100 ms 读取并按原输出上限推送，进程结束后删除。这样避免 Node/libuv 在 restricted token 下创建默认 stdio 命名管道时可能同步卡住，导致取消与超时器均无法运行；临时输出文件达到 64 MiB 时终止该命令进程树并返回明确错误。Broker 宿主命令与 Git 仍使用原有管道。此传输变更沿用原工具的开始/结束、耗时、失败/取消和关联 ID trace；原生 stderr 只保留固定阶段名与 shell 类别，不记录命令、路径或输出。

专用账户与宿主工作区所有者不同。Git 工具现由 Broker 执行；Agent Runtime 不再投影宿主的 Git global/include 配置图。原生协议要求的只读 global 文件保留为空文件，旧配置图解析代码仅供暂停的 Runner 路径保留。
仓库探测失败时，Git 工具结果保留退出码及最多 512 字符的子进程错误，便于区分所有权、ACL 和环境问题；该文本不进入诊断日志或 trace。

### 网页检索与网页正文

每个主任务 Responses 请求都包含 OpenAI 内置 `{ "type": "web_search" }`。该工具由配置的模型服务执行，不会进入 ToolRunner、审批队列或工具 DAG；服务不支持该工具时，模型请求按现有脱敏错误流程失败并报告，不会伪装成本地搜索成功。

Responses 的 `output_text.annotations` 中合法 HTTP(S) `url_citation` 会按 URL 去重，并以 Markdown 来源链接追加到回答，供历史和 Web UI 安全显示。

搜索摘要不足时，模型可在 `curl` 可用的前提下用它获取公开网页正文。网页、搜索结果和其中任何指令均为不可信数据，不能放宽文件、命令或权限规则。在 Windows Agent Runtime 中，网页的外部 HTTPS 请求必须改用 `run_with_permissions`，提交完整命令和具体理由；获批后它以 Broker 宿主用户权限运行，不得在被拒绝后以 `run_command` 绕过。

`curl` 不提供浏览器自动化、私网/回环访问、凭据或任意网络权限。

### 会话任务调度

不同真实工作目录的会话可同时运行，调度器按创建顺序选择可启动任务，默认至多两个；被全局上限或同目录锁阻塞的任务显示为 `queued`，可从该会话停止。调度器不会把同一工作目录的读取、编辑、命令或 Git 操作拆成“只读可并行”：任何同目录任务均等待，避免命令隐式写入、测试结果失效和 Git 索引竞争。相同会话也不会并发追加上下文。任务开始后记录 `startedAt`，排队时间不计入会话累计运行时间。

服务关闭、重载或重启会把 queued/running/waiting 都标记为 interrupted；队列不在重启后自动执行。

### 文件编辑契约

`edit_files` 是专用的文件写入工具。新文件条目为 `{ path, create: true, content }`，只能创建不存在的路径；已有文件条目为 `{ path, create: false, fileVersion, edits: [{ oldText, newText, startLine, endLine }] }`，一次调用可合并 1～20 个新建或已有文件条目，每个已有文件条目接受 1～100 项修改，重复的真实路径会拒绝。单文件也使用一个文件条目。

新文件内容、已有文件原文和修改后文件各不超过 2 MiB，整批原文与结果合计不超过 16 MiB。

该工具的每项修改都基于**调用前的原始文件快照**，不能引用同一调用前项生成的新文本。模型默认传 `startLine: null, endLine: null`，并选取在整个文件中唯一的短 `oldText`；仅在重复文本需要消歧时提供行范围。本地旧调用省略行号时也默认为 null。提供行号时必须同时提供两个正整数，以 1 起算、首尾均包含；行号是硬搜索范围（包含末行换行符），匹配片段必须完整位于范围内。

精确匹配优先，随后在所有文本文件中允许唯一的 CRLF/LF 等价匹配；普通文件才进一步允许唯一的宽松空白匹配。换行等价匹配仅替换真实原文片段，并使 `newText` 延续匹配片段的单一换行风格；单行片段采用整个文件的单一换行风格。其他原文空白不改动。读取结果的行号前缀不能进入 `oldText`。候选缺失或不唯一时拒绝，不向指定范围外搜索，不自动修正行号。重叠区间拒绝；从后向前应用已定位区间，因此插入行不会移动其他修改的位置。

### 批量文件编辑

多文件工具逐项完成路径审批、读取哈希和编辑校验，并在全部预检结束后逐项复核：create:true 在预检、审批等待后与写入前都必须确认目标不存在，拒绝覆盖期间出现的文件；create:false 复核真实路径和已读取的原文快照。某个文件被拒绝、旧文本不匹配、目标出现、路径/版本变化或超出批次大小时，记录该文件失败但仍写入其他独立且已核实的文件。

创建时可建立父目录；每次写入都使用同目录临时文件并发出 diff。新建优先通过硬链接原子发布，目标若在最后一次检查后出现仍拒绝覆盖；不支持硬链接的文件系统使用独占复制，也拒绝已有目标，但不保证复制期间内容完整可见。已有文件仍用 rename 替换。新建成功后记录读取哈希，已有文件成功编辑后作废读取哈希；写入阶段的单文件故障同样继续后续文件，取消和历史持久化故障才停止批次。结果一次列出所有失败或结果未知的路径及实际错误，不回滚、不自动重放。逐文件状态为：`written` 已写入、`failed` 未进入写入、`not_attempted` 因批次停止而未开始、`unknown` 曾进入写入阶段但结果需核实。

历史 `edit_progress` 在写入前记录 unknown，成功后记录 written，UI 合并显示最新状态及单文件错误；进程崩溃后必须结合当前文件核实。跨文件没有事务保证，权限/路径复核也不是操作系统级沙箱。

以下为 `edit_files` 的 `arguments` 示例；外层 `execution` 信封见工具批次约定。两处 `fileVersion` 是格式占位值，执行时必须替换为本任务读取对应文件得到的 `contentHash`。

```json
{
  "files": [
    { "path": "src/new.ts", "create": true, "content": "export {};\n" },
    {
      "path": "src/a.ts",
      "create": false,
      "fileVersion": "0000000000000000000000000000000000000000000000000000000000000000",
      "edits": [
        { "oldText": "1", "newText": "2", "startLine": 1, "endLine": 1 }
      ]
    },
    {
      "path": "src/b.ts",
      "create": false,
      "fileVersion": "1111111111111111111111111111111111111111111111111111111111111111",
      "edits": [
        {
          "oldText": "oldName",
          "newText": "newName",
          "startLine": null,
          "endLine": null
        }
      ]
    }
  ]
}
```

旧历史参数保留展示，不重放旧工具调用。

### 安全补丁定位与空白诊断

`read_file` 的 `contentHash` 是全文字节 SHA-256 版本。`edit_files` 的已有文件条目应将它作为 `fileVersion` 传回；执行器仍以本任务保存的读取凭证和写入前复核为准，拒绝版本不一致或外部变化。为兼容旧历史和旧模拟调用，省略时解析为 `null`，但新的模型工具定义要求显式传递版本。

每项已有文件编辑以 `oldText` 和可选行范围定位。先在指定行窗口（或全文）作字面精确匹配；失败后在同一窗口中尝试 CRLF/LF 等价匹配，最后仅对普通文件尝试删除空白差异后的**唯一**候选。规范化只用于定位真实原文字符范围。若匹配片段同时含 CRLF 和 LF，则保留模型给出的替换文本换行，不猜测混合风格。多个候选、无候选和版本冲突均返回结构化诊断并拒绝写入；不得选择第一个候选或盲目重试。

Python、YAML、TOML、Makefile、Make 片段和 Markdown 默认是空白敏感文件：允许 CRLF/LF 等价定位，但其他空白差异仍拒绝。遇到 `EDIT_TARGET_NOT_FOUND`、`EDIT_TARGET_AMBIGUOUS`、`EDIT_WHITESPACE_FALLBACK_DISALLOWED` 或 `EDIT_FILE_VERSION_MISMATCH`，先按返回的候选行重新读取。

调用 `read_file` 时设 `whitespaceMode: true`，结果保留可复制的 `text`，并额外以 `visibleText` 标记普通空格（`·`）、Tab（`→`）、CR（`␍`）和行尾（`↵`）。

## 权限交互

普通工作区文件操作自动执行。工作区外文件操作、敏感文件或修改 AGENTS.md 进入审批；直接修改 .git 被拒绝。create:true 永不覆盖已有文件，已有文件只能通过 create:false 的读取后精确编辑修改。工作区外读取逐次分类，可对低风险读取自动批准；尚未提供额外只读目录授权管理界面。

每个原本需要审批的命令或工具使用先由已配置的低成本辅助模型作单次、无工具的三级分类：`approve` 自动通过，`human review` 显示现有人工点击审批，`reject` 直接拒绝并把简洁理由返回任务与时间线。

分类请求把后端从会话读取的工作区根目录 `workspaceRoot` 与工具名、待审批内容分字段传给无工具的模型，不从命令描述中采信工作区路径；关闭该次模型思考，输出严格限制为 JSON 决定及理由，最多 256 token。新版 prompt 按可预见的实际影响而非命令形式优先放行没有明显负面影响的请求：工作区内普通阅读、搜索、测试、构建、格式化及预期写入可直接 `approve`，无害管道和复合命令不单独触发人工确认；合理的公开网页读取、公开依赖获取或工作区外非敏感只读访问也不因网络或路径本身转人工。仍逐段辨别重定向、子进程和实际副作用；工作区外写入（含间接写入）、敏感内容、重大破坏或系统修改、来源不明的远程代码等具体风险要 `human review`，明确恶意窃密、破坏或绕过安全边界才 `reject`；对普通程序的抽象不确定性不等于风险证据。`run_with_permissions` 须按 Broker 宿主用户拥有的完整文件、网络和凭据权限审查，cwd 不约束命令访问的路径；分类仍是模型建议，不是静态只读证明。

无辅助模型、服务故障或无效输出一律保守转为人工确认，不调用主模型替代。模型分类不影响现有授权：简单的 `pnpm`/`npm` test/build/lint/typecheck 或 `node --test` 在可计算项目指纹时仍可授予本次会话重复执行，包含更多 shell 语法的命令仍不支持会话放行。执行器内部选择 shell，不改变命令的权限边界；直接 Git 程序名（包括复合命令中的 Git）和提权命令会在审批模型之前直接拒绝。

子进程环境设置 `NO_COLOR=1`、`FORCE_COLOR=0`、`CLICOLOR=0`、`CLICOLOR_FORCE=0` 和 `TERM=dumb` 请求工具禁用颜色；执行器还会跨输出分块移除 ANSI、OSC 等控制序列，只保存、展示和回传纯文本。没有系统沙箱、回滚或提权工具。请只操作可信项目。

Git 不经 `run_command` 执行，而使用单一 `git` 工具；模型可以主动调用允许的 action，不等待人工审批。`status`、`diff`、`log`、`show`、`branch` 只读；`add`、`commit`、`push` 会写入索引、仓库或已配置远程。

`diff` 显式传 `staged`、`paths` 和 `contextLines`，空 paths 的全量差异先列出全部变更路径并拒绝敏感内容；`log` 传安全 revision、paths 与 limit；`show` 必须传安全 revision 和明确 paths；`add`/`commit` 必须传明确 paths，commit 另传非空 message；`push` 没有额外参数。

### Git 权限

每次调用先确认会话工作区恰好是非 bare Git worktree 根目录。所有路径必须为非选项式的相对路径，解析真实位置后仍在工作区，且不含 `.git`、硬敏感组件或敏感目录后代；`.env` 及其运行时变体始终拒绝。

仅完整匹配 `.env.example`、`.env.sample`、`.env.template`、`.env.dist`（以及 `config.env.example` 等同类后缀）的普通 UTF-8 模板文件可进入额外校验：敏感变量必须为空或使用明确占位值，并拒绝私钥、JWT、常见 token、Bearer token 及带密码 URL。

该检测不能证明发现任意秘密，无法判定为安全的敏感变量值会保守拒绝；普通文件访问仍把所有 dotenv 变体视为需确认的敏感路径。目录递归执行同一校验；涉及已校验模板的 diff/show 先缓冲并扫描输出，再写入历史和 UI，防止旧版本泄露凭据。revision 仅接受保守的分支、标签或提交哈希字符。

Git commit 固定禁用 hooks 和 GPG 签名；push 保留真实仓库的 pre-push hook 语义，并在确认 UI 明示 hook/子进程会在网络窗口内运行。外部 diff/textconv、交互终端、分页和编辑器保持禁用。

push 从当前分支配置读取唯一 remote、当前 source OID 与 `refs/heads/*` upstream，拒绝本地、`ext::` 及其他非 HTTPS/SSH/SCP 风格地址，并用已确认 OID 而不是可变化的 `HEAD` 形成显式 refspec，不接受 remote、branch、force 或其他选项。应用层校验不等于操作系统沙箱，可信项目中的 Git clean filter、hook 等仓库配置仍可能以当前身份运行。

add、commit 或 push 中断时结果可能未知，恢复前必须用 status/diff/log 重新检查，不自动重放。

### Sandbox 工具权限

本节宿主命令与 Git 规则适用于未启用 Sandbox 的任务和启动前 fallback。宿主任务以及 Windows Sandbox 启动前 fallback 的模型请求只接收宿主工具定义和提示，**不会公开或建议 `run_with_permissions`**。

只有实际已启动的 Sandbox Agent Runtime 才会收到该工具及其 Sandbox 专属提示：其已有 AccessManifest/WFP 权限内的文件工具、普通命令不再进入审批；全部 Git 工具 action 经 Broker 宿主执行，push 逐次审批。越界普通文件工具直接拒绝。

任意越界命令必须调用 `run_with_permissions`，给出完整命令和具体理由；该调用只阻塞自身 DAG 节点，无依赖的同批工具可并行执行。

Broker 不信任 Runtime 自报审批，把完整命令、理由和“将使用宿主用户权限”的说明交给现有低成本模型三级审批；自动通过或人工批准后返回只绑定当前认证连接与 `toolCallId` 的一次性 authorizationId。Runtime 获得 Tool worker 执行槽后才消费授权，Broker 随即启动宿主进程；拒绝时不启动。取消、断连或重复消费都使授权失效，授权本身不授予 Runtime 新权限。

获批命令由 Broker 以当前宿主用户权限执行，不附加 Sandbox 文件根、网络 host、WFP 或 Job 限制；可访问该用户的文件、网络和凭据。它单独记录为 `broker-command/host-process`，不能标成 Sandbox 内命令。Capability Runner、其权限 schema 和原生路径保留，但当前工具不触发它。

审批时必须考虑命令在宿主用户权限下可能访问多个 host、私网、设备、注册表、服务或凭据；这些不再由 Sandbox 额外拦截。

Sandbox 模式下全部 Git 工具 action 在 Broker 中以宿主用户权限运行，工作区内部不保护 `.git`、`.env` 或其他子路径。非 push action 沿用受限参数契约但不逐次审批；push 另经 Broker 预检和逐次审批。

Broker Git 正常加载宿主用户可见的 system、global/include、local 和 worktree 配置。Agent Runtime 不再取得宿主 global/include 图的精确只读 ACL；原生协议仍要求的 `GIT_CONFIG_GLOBAL` 指向逐租约空文件。

空配置文件及父目录都不能由 Runtime 替换；Sandbox 的 `HOME`/`USERPROFILE`/`XDG_CONFIG_HOME` 仍指向逐租约私有可写目录，不授予整个宿主 profile。Broker Git 的 helper、证书或签名程序使用宿主用户权限。

普通 Agent Runtime 无直接命令网络；push 前由 Broker 宿主 Git 查询当前 upstream/URL/OID/ref，并沿用低成本模型的自动通过、移交人工或拒绝三级审批。审批展示预检 URL、目标和宿主权限。

Push 必须是当前工具批次的唯一节点；Agent Runtime 保持存活，其 agent loop 通过认证 IPC 同步等待 Broker Git push，不调度其它工具，也不获得宿主凭据。Broker 使用真实仓库配置预检，再以预检 URL、源 OID 和目标 ref 构造一次 push；该应用层固定参数不构成对 Git 配置、hook/helper 或网络出口的 Sandbox 限制。

持久 WFP fence 只约束专用账户 Runtime，不约束 Broker 宿主命令或任何 Git 工具 action；旧 relay/CONNECT 代码暂停用于产品 push。取消记录以 executionInstance 及 `agent-runtime | broker-command | broker-git | broker-git-push` kind 保存 cancelled/unknown/orphaned、部分输出和“副作用可能已发生/禁止重放”；非 Sandbox 进程不伪造专用账户字段。

Windows 原生安装命令是显式维护入口，不属于服务启动或默认测试：先在普通终端运行 `pnpm sandbox:native:build` 与 `pnpm sandbox:runtime:build`；若当前 `PATH` 中的 `node` 不是 v24，通过 `CODEATELIER_SANDBOX_RUNTIME_NODE` 指定可信 Node 24 executable。

随后必须由用户**先打开“以管理员身份运行”的 PowerShell**，进入仓库目录，再运行 `pnpm sandbox:install`、`sandbox:repair`、`sandbox:verify`、`sandbox:uninstall` 或 `sandbox:recover`；`run.ts` 使用非 shell `spawn`，不会自行触发 UAC 或重新提升。

安装器校验 v3 build manifest 后，把 supervisor/WFP manager、Node 24、Agent Runtime entry 和 compaction、read_file、subagent 三种 Worker 复制到受保护的 ProgramData 目录，并在 v4 state 记录安装副本摘要；旧 v3 安装须由用户显式运行 `pnpm sandbox:repair`（转交 `install.ps1 -Mode Repair`），TypeScript 启动前与 native self-check 均拒绝旧状态或不匹配的摘要。安装器还配置专用账户的网络、batch、service 和远程交互拒绝登录权；服务不得自行提权或自动安装。

macOS/Linux 调用这些命令只输出 `SKIP`，不启动 PowerShell 或任何 Windows 原生代码；设置 `CODEATELIER_SANDBOX_ENABLED=true` 也保持 non-isolated 宿主路径。Windows 上提升验收完成前，启用开关若自检失败仍按既有契约提示并回退宿主。

## 常见问题

- 模型返回“不支持 Responses”：核对服务公布的完整模型标识；配置原样传递，不自动转换简称。任务通知会显示服务实际返回的错误 message/reason/code（脱敏、最多 1200 个字符）；服务未给出细节时明确提示，避免猜测原因。
- 命令无法启动：工具结果会包含子进程实际错误；非零退出码的 shell stderr 已在同一命令输出卡片中保留。
- 请求结束但无结果：检查服务是否发送完成事件。适配器支持从 output_item.done 收集结果。
- 找不到 Windows shell：服务会按 `pwsh`、`powershell`、`cmd.exe` 检查环境；若三者均不可用，`run_command` 会明确失败。模型无需也不得提供、探测或回退 shell；使用内部检测到的 `cmd.exe` 运行 pnpm 的 `.cmd` 脚本仍按单次审批处理。
- 文件已变化：重新读取后再编辑；不要关闭并发修改检测。
- 刷新后需要重新认证：服务重启会轮换本机会话 token，刷新页面。
- 任务中断：在会话底部点击“恢复任务”，可先填写恢复说明。密钥或模型配置错误先到设置修正，超时可调整模型请求/空闲超时。模型自动重试记录 model.retry（含步骤、尝试次数、错误分类、HTTP 状态、等待时间）；耗尽后保留失败状态。详见 [恢复机制](recovery.md)。
- 数据目录不可写：先检查该目录所有权和 ACL，或使用 CODEATELIER_DATA_DIR 指定可写目录；不要扩大系统目录权限。
- 端口占用：用 CODEATELIER_PORT 指定其他端口；开发 Vite 代理会自动读取同一个环境变量。
- IPv6 回环：设置 CODEATELIER_LISTEN_ADDRESS=::1 后使用 `http://[::1]:端口` 访问；开发 Vite 代理会自动使用相同地址。
- 局域网访问：设置 `CODEATELIER_LISTEN_ADDRESS=0.0.0.0` 或 `::` 后，后端和 `pnpm dev:web` 都在相应通配地址监听；用运行服务电脑的局域网 IP 和对应端口访问，不要在浏览器中使用 `0.0.0.0` 或 `::`。

  默认任何可达设备都可操作 agent；可设置 `CODEATELIER_WEB_PASSWORD_ENABLED=true` 和非空 `CODEATELIER_WEB_PASSWORD` 要求先通过单一密码门禁，但这不替代受信任网络、防火墙或公网入站限制。

## 贡献流程

按职责划分文件，保持 strict 类型检查；协议边界的动态结构应由 schema 验证。变更前读 AGENTS.md 与需求文档。核心行为修改添加对应行为测试，纯文档不写形式化测试。每个独立可验证增量创建 commit，同步更新文档；隔一段时间批量 push。

CI 暂时仅允许在 GitHub Actions 页面手动触发，不随 push 或 pull request 自动运行。触发后使用 GitHub 托管的 Windows、Linux、macOS runner 执行 pnpm check，Linux Chromium 执行 UI 验收。

`pnpm test`、`pnpm test:watch`、`pnpm test:e2e` 和 check 中的测试模式构建均由 `scripts/test-runner.ts` 以固定白名单环境启动，Vitest 不继承父进程配置、Vite 的 test 模式不读取 dotenv，Playwright 测试后端也不经包管理器路径启动；因此不使用真实 API key、生产 `.env` 或系统中的 CodeAtelier 配置。

真实服务 smoke 手动运行。

## 开发中的测试要求

所有功能开发必须配套合理的单元/回归测试。每个可验证增量后运行相关测试，修复缺陷先复现再修正，提交前运行 pnpm check；涉及 UI、API 或 SSE 的变更还需 pnpm test:e2e。测试分层、运行命令、功能覆盖与限制见 [testing.md](testing.md)。

## 服务退出

Web 侧栏的“关闭服务”需确认。`POST /api/server/shutdown` 接受 `{ "confirm": true }`，沿用 cookie/token 校验。关闭期间拒绝新业务请求，先停止模型/命令并记录任务中断，响应确认后关闭 SSE、HTTP 和 SQLite。请求方提前断开时仍继续清理。

生命周期关闭操作幂等；日志事件为 server.stopping/server.stopped，异常为 server.shutdown_failed。

`Ctrl+C`、SIGTERM 调用同一个 shutdown。开发模式还需退出 tsx watch 监视器时，在启动终端按 Ctrl+C。

## 开发服务重载

`pnpm start` 先运行常驻的 `launcher.ts`，它 fork 实际提供 HTTP 服务的子进程。侧栏的“重载服务”必须在确认框选择“确认重载服务”，随后以与关闭相同的任务中断持久化和资源清理流程停止旧子进程；旧进程通过固定 IPC 请求 launcher 在端口释放后 fork 新子进程。UI 通过新生成的本机会话 token 确认替代服务已监听，才完整刷新页面。

请求沿用 cookie/token 与 `{ "confirm": true }` 校验；无监督启动时接口返回 409，不自行生成游离进程。重载保留历史和已修改文件，但当前任务须从恢复入口继续。

重载只重新执行已有构建产物，不会编译源码。生产模式修改后先执行 `pnpm build`，再点击入口即可替换 `pnpm start` 当前的服务；若服务已经关闭仍须在终端重新运行 `pnpm start`。同时运行 `pnpm dev` 和 `pnpm dev:web` 时，tsx watch 负责后端源码变化后的进程重启，Vite HMR 负责前端模块更新；重载入口可在需要完整重建本机会话时使用。

## 代码阅读与审核

可读性是长期交付要求，见 [code-style.md](code-style.md)。运行 `pnpm format` 统一格式，`pnpm format:check` 只检查不修改。`pnpm check` 已包含格式检查；源码、测试、脚本和根目录工具配置一并检查。段落、命名与关键原因注释仍需要人工审核。

## 自举开发验证

`pnpm exec tsx scripts/bootstrap-agent.ts --prepare-only` 只准备隔离源码副本并复现缺陷；移除该参数后使用环境变量密钥执行真实模型任务。数据发送范围、审批限制和证据判定见 [bootstrap.md](bootstrap.md)。

结构化事件和工具结果先解析 JSON，对字段值脱敏后重新序列化；不直接用正则替换 JSON 转义文本。Pino 内部记录同样先按字段脱敏，再格式化为纯文本日志；格式化后的诊断文字继续通过统一脱敏函数处理。

## 可选低成本辅助模型

设置界面只读显示“辅助模型（低成本，可选）”，并可保存“辅助模型推理强度”。模型 ID 必须在本地 `.env` 设置（示例为占位值，须替换为服务实际提供的 ID）：

```dotenv
CODEATELIER_AUXILIARY_MODEL=your-low-cost-model-id
CODEATELIER_AUXILIARY_REASONING_EFFORT=low
```

辅助模型共用主模型的 API 地址与密钥，默认不指定模型；空值时标题和摘要沿用主模型及其思考等级，而审批保留人工确认。模型标识只能修改 `.env` 并重启或重载服务；已保存的推理强度优先于环境默认值。推理强度可选 low/medium/high，指定辅助模型时默认 low；程序不推断价格或自动选择模型。

上下文摘要和首条用户 prompt 的标题生成均使用 `auxiliarySettings`：创建会话后先显示“新对话”，Engine 对首条消息发起无工具、64 token 上限的标题请求，成功后通过 SSE 更新侧栏；失败保留占位标题而不阻断编码任务，取消会中止任务。

审批也复用已显式配置的辅助模型，但不在其为空时回退主模型：每个待审批请求使用无工具、256 token 上限的 JSON 分类，自动通过、人工确认或直接拒绝均会记录在时间线；模型故障和无效输出保留人工确认。配置不意味着服务兼容性已经实测。

### Git 模型参数兼容性

模型侧 `git` 参数采用 `{ "request": { "action": "status" } }`，其他 action 的字段也放在 request 内。根节点为严格 object，request 使用嵌套 anyOf；避免服务拒绝根级 oneOf。执行前严格验证各 action 字段，再解包交给原 Git 执行器；历史扁平参数继续受原校验约束。

tool-schema.test.ts 覆盖根节点、oneOf 禁用、包装解包、历史兼容和额外/非法字段拒绝。
