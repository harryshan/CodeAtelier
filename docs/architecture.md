# 架构

当前初版为本机后端、浏览器单页应用、单 agent；不同真实工作目录的会话默认最多两个任务并行，同一目录严格串行。Windows Sandbox 仍处于预览验收态：启用时默认产品组装会由 C++ Sandbox Supervisor 启动常驻 Agent Runtime；Supervisor 创建任务专属 Named Pipe，联合核对 PID、创建时间、Job、账户、restricted SID、capability 与固定 Node 映像后代理 Broker IPC。该路径已有 native build、协议和无管理员副作用回归，但尚未完成固定账户提升环境端到端验收，不能描述为当前稳定可用能力。严格术语和完成判据见 [Windows 专用用户 Sandbox Runtime 与 Broker 架构](windows-integrity-sandbox.md#0-术语进程和完成条件)。Sandbox 模式沿用 1～4 个不同工作区并发和同工作区串行；macOS/Linux 明确不加载这套 Windows 后端。核心机制自行实现，没有引入 agent 编排框架。

## 模块与数据流

下图是已经接入代码、仍待提升环境验收的目标进程边界。`AgentRuntimeService` 与 Engine launcher 承载 agent loop；SandboxBroker 管理 manifest、generation lease、启动前 fallback 与启动后 quarantine；C++ Supervisor 创建并验证真实 Named Pipe 客户端后代理 `runtime-ipc-*` 字节流。独立 Node harness 证明应用协议，native build 证明代码可构建，两者仍不能替代固定账户下的真实联合验收。

```text
Browser / Web UI
  ↕ HTTP、SSE（宿主 Server）
Broker Host（可信宿主边界）
  ├─ 策略、审批、AccessManifest、SandboxProcessRecord、执行账本与 tracing
  ├─ C++ supervisor、专用账户租约与 Job 生命周期
  ├─ 参数受限的 model / storage / network / external adapters
  └─ 经认证、固定 schema 的 IPC
       ↕
Sandbox Process（单一 CodeAtelierSandbox 账户；每实例独立 lease/capability/Job）
  ├─ Agent Runtime：常驻 Node.js agent loop、工具计划、文件工具、本地 Git 与命令；无直接网络（Windows 启动/传输已接入，待提升环境验收）
  ├─ Push Runner：真实 Git 配置与认证 relay；无 agent loop
  ├─ 账户既有读取权 + 工作区、显式 read/write roots 与精确只读 Git config/include 图
  └─ WRITE_RESTRICTED 根 capability、产品依赖与私有临时目录；不继承宿主 profile/凭据
```

Windows 启用时的产品调用链现为 `Broker Engine → SandboxBroker launcher → C++ Sandbox Supervisor → Agent Runtime → 工具子进程`，模型、session、审批和记忆通过 Runtime IPC adapter 回到 Broker。Git push 是这条链的受限分支：`Agent Runtime（loop 阻塞）→ Runtime IPC PushSpec → Broker → Sandbox Supervisor → 独立 Push Runner`；原 Agent Runtime 保持存活，但不取得 Runner 的网络或凭据能力。安装版 Runtime 的 argv 只携带 Supervisor 生成的本机任务 pipe 名，identity/nonce 由有界首帧交付；产品 build 生成面向 Node 24 的单文件 Runtime 与独立 compaction Worker bundle，安装器把 Node 24 和 bundle 固定到受保护目录，TypeScript/native self-check 复核 v2 state 中的 SHA-256。逐工具 Sandboxed Tool Process 路径暂留作启动前 host fallback 后的兼容宿主 loop，不再是启用成功后的目标调用链。只有提升环境证明这条真实链路的身份、取消、清理与恢复后，才满足 Agent Runtime 完成条件。

以下文件职责描述当前实现；专用用户/Broker 目标模块和迁移边界以 [windows-integrity-sandbox.md](windows-integrity-sandbox.md) 为准。无论当前还是目标架构，前端都不能导入文件、进程或密钥实现。

- `src/shared` 仅存浏览器和后端共享的数据契约。
- `src/agent/engine.ts` 管理任务队列、全局并发上限、真实工作目录互斥、模型循环、停止条件与工具结果回传；同一会话也只允许一个运行中或排队任务。`context.ts` 负责上下文恢复，`instructions.ts` 负责根规则与模型指令构建。src/context/ 负责预算、摘要压缩、快照契约与历史原文读取，循环在完整工具批次完成后接入；压缩阶段之间让出事件循环。
- `src/providers` 将 Responses 输出映射为输出项和文本。主任务请求显式声明 `parallel_tool_calls: true`，并附加 OpenAI 内置 `{ type: "web_search" }`，让支持它的服务在模型请求内查询公开网页；它不是本地函数调用或 DAG 节点。`ResponsesProvider` 从 `output_text.annotations` 提取合法 HTTP(S) `url_citation`，去重后追加为可点击 Markdown 来源。工具函数仍要求每项带 `execution.id` 与 `execution.dependsOn`；依赖只能引用同一 Responses 响应内的节点，不能跨轮引用历史 ID。Engine 在任一节点产生副作用前校验整批 DAG，并以稳定拓扑顺序、最多 4 个并发节点调度。自建服务需同时收集 output_item.done；completed.output 有内容时优先使用，不能只依赖 completed。
- `src/tools` 定义 Zod 参数及对应 JSON Schema，提供读取、统一文件编辑、命令和单一受限 `git` 工具；`registry.ts` 还独立声明无本地执行器的 Responses `web_search`。没有本地 `search` 或 `list_files` 工具；`search-commands.ts` 在每次任务建立指令前检测 PATH 和 Windows 系统位置可用的常见搜索程序，按估计性能排序后只向模型给出命令名与内容/文件名用途。模型以 `run_command` 执行目录浏览及首选的已检测工具，尽量把多个关键词合入一次多模式搜索；`run_command` 只公开一条命令文本，`command-shell.ts` 在执行器内部选择平台 shell。模型先由命令浏览/搜索定位，`read_file` 再按行读取；单次硬上限为 500 行，并返回分页/截断状态。`edit_files` 的 create:true 条目只新建不存在的文件，create:false 条目只精确编辑本任务已读取的已有文件。旧会话的 `search`、`list_files` 和 `write_file` 记录只保留展示、归档和快照回读兼容。
- `src/permissions` 用无工具的低成本辅助模型将待审批请求分为自动通过、人工确认或拒绝；人工确认仍在后端等待用户点击，取消会释放待审批 Promise。模型无法自行同意审批。
- `src/server/local-security.ts` 在业务 API 前校验 Host、Origin、可选的环境访问密码与本机会话 token；密码门禁启用后，只有状态/登录路由可在未验证时访问，登录成功写入服务进程有效的 HttpOnly cookie。
- `src/sessions/store.ts` 保存 sessions、tasks、events、context 和新任务的高保真 replay 捕获；`history-shards.ts` 将既有 `history.sqlite` 作为首个兼容分片，并在最新分片（主库加 WAL）达到默认 1 GiB 后让**新会话**进入 `history-000001.sqlite` 等后续文件。单个会话始终留在初始分片，因此保持 SQLite 外键、事务、恢复和 Worker 路径语义；单次不可分割写入或单个超长会话仍可能略超阈值，不承诺自动重新分区既有历史。任务的 createdAt、startedAt、finishedAt 分别表示入队、实际开始和结束，排队时间不计入会话累计运行时间。初始数据库结构位于 `schema.ts`。replay 捕获逐次保存模型 input/instructions/响应及完整脱敏工具参数/结果，导出时可从同一哈希的完整 `read_file` 页拼接 `edit_files` 的原始文件；只读到部分行或旧历史则明确拒绝真实文件物化。会话初始快照读取全量事件，SSE 后续刷新按跨分片仍单调的 event ID 游标只读取新增事件；超过 64 KiB 的任一事件读取范围、活动上下文和历史快照由 `store-worker.ts` 在目标分片的独立 Worker 线程解析或事务写入，小记录避免线程创建开销而同步读取。启动时将 queued/running/waiting 任务标为 interrupted 并记录结束时间。
- `src/config` 将 .env/进程环境中的只读连接配置与 settings.json 中的非连接偏好合成为运行时设置，另管理内存密钥和平台数据目录；`src/sandbox/config.ts` 同时只在启动时严格读取 Sandbox 开关，避免它被浏览器设置或旧持久化偏好改变。访问门禁配置由 server/local-security.ts 在服务启动时单独读取，避免将密码纳入浏览器可见配置。
- Sandbox 的目标模块以 `BrokerHost` 为宿主可信边界。一次性提升安装创建单一 `CodeAtelierSandbox` 本地账户，并按其 SID 安装持久 WFP 默认拒绝规则；独立 C++ supervisor 为每个 execution instance 创建该账户的 `WRITE_RESTRICTED` token、根 capability、私有 desktop、最小环境和 Job。Broker 先建立不可变 AccessManifest，supervisor 再以原对象 handle 和卷/file ID 复核工作区、显式 read/write roots、产品依赖和精确 Git config/include 图并投影最小 ACL；持久 journal 使最终 revoke 或重启恢复可在同卷 rename 后按 file ID 重开原对象。当前产品已把常驻 AgentRuntimeService、C++ Supervisor launcher、身份绑定 Named Pipe、model/session/approval/memory adapter、ACL journal、relay、capability runner 和 generation drain 接到同一生命周期；尚缺固定账户提升环境对 W3/W4 的真实验证。Sandbox 沿用 1～4 个不同工作区并发和同工作区串行；账户 SID 使所有并发实例可能读取活动 manifest 的授权根，同账户 peer 也可能终止、注入或检查其它 Runtime。不同对话不是彼此的 OS 安全边界，每实例 capability 只承诺经验证的直接及后代文件写入限制。专用账户不继承宿主用户私有权限，但既有公共/机器 ACL 仍可能允许额外读取。共享账户 ACE 使用 provision 等待与 prepare/native revoke/commit 两阶段 grant table；任一实例 ACL、Job、代理或账户状态无法对账时隔离 account generation，原生终止整代账户进程并按持久 journal 撤销 ACL。Agent Runtime 已有权限内的全部 Git 与命令在 Runtime 内执行且免审批；越界命令由 Broker 重新审批后在独立 capability runner 中执行，Broker 不运行 Git，也不以宿主 token 执行 LLM 命令。只有 Agent Runtime 启动前可证明完整回滚时才保留宿主 loop fallback。现有 WSL2 `inspect` 和 restricted-token demo 只是历史或局部证据，完整边界见 [windows-integrity-sandbox.md](windows-integrity-sandbox.md)。
- `src/tracing` 默认只在任务运行期间于 Broker 构造性能 timeline：宿主 loop 直接记录上下文计量/压缩、模型请求与退避、响应处理、工具计划、SandboxBroker 阶段、工具真实执行和工具结果持久化；Agent Runtime loop 则以严格 IPC trace event 上报固定的 `context.prepare`、`context.request` 及其计量子阶段，Broker 重建父子 span。该事件只允许固定名称以及 step/attempt/数量/状态等有界属性，不能充当任意 Runtime 日志通道。模型、退避与响应处理仍是独立 span，模型包装器记录长度、数量、usage、错误类别和首包时间。Node 主事件循环执行的上下文、模型、响应、计划和持久化 span 汇集于 `Main thread`，并以 begin/end slice 表示这些内部阶段；`Task` 根是生命周期包络。工具批次/依赖属于 `Tool scheduler` 逻辑轨道，实际执行节点映射到可复用工具轨道。导出事件按时间排序，并用递增整数 ID 连接模型到工具的 flow，保证 Perfetto Trace Event JSON 兼容性。每个实际 tool span 保存经递归凭据脱敏后的结构化执行参数，因此 trace 是不得上传或提交的敏感本机诊断文件；它仍不保存提示词、模型/工具输出或凭据原文。高保真 replay payload 独立保存在 Store 的 `task_replays`，不混入 Perfetto；模型/工具 replay 只用于隔离测试，文件物化还必须验证完整读取版本。任务进入终态时 TraceArchive 以临时文件后 rename 的方式保存 `traces/<sessionId>/<taskId>.json`，然后立即释放内存记录，所以同一会话各任务不覆盖且没有完成 trace 缓存。`GET /api/tasks/:id/trace` 在本机 cookie 保护下只读取该文件；`GET /api/sessions/:id/traces` 只列出实际存在的文件，统计框据此显示下载入口。
- `src/logging` 在 Pino 内部按字段脱敏后输出紧凑格式化纯文本，按级别筛选、保留受控错误详情并轮转文件。

## 文件职责与定位

| 模块                                                                                   | 职责                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tools/registry.ts / tool-graph.ts                                                      | 工具参数和 DAG 调度信封、模型可见定义；调用图的结构校验、稳定拓扑调度、并发上限和失败后继阻断；`edit_files` 以 create 区分新建与已有文件编辑                                                                                            |
| tools/tool-runner.ts                                                                   | ToolRunner：校验、审批、读取与普通命令执行，并将统一文件编辑和单一专用 `git` 工具分流                                                                                                                                                   |
| tools/file-editor.ts                                                                   | FileEditor：逐文件预检、create 存在性/读取版本复核、失败汇总、独立文件继续写入和进度，复用 ToolRunner 的权限与读取哈希                                                                                                                  |
| tools/edit-plan.ts                                                                     | 基于原始快照的行号/文本定位、重叠校验与纯文本转换                                                                                                                                                                                       |
| tools/git.ts                                                                           | GitToolRunner：按 action 分流固定 Git 参数，复核 worktree、路径/revision/upstream 并自动执行                                                                                                                                            |
| tools/paths.ts / command-shell.ts / process.ts                                         | 路径边界、内部 shell 选择与进程生命周期                                                                                                                                                                                                 |
| providers/model-provider.ts                                                            | 与具体服务无关的模型接口和结果契约                                                                                                                                                                                                      |
| providers/responses-provider.ts                                                        | ResponsesProvider：Responses 协议实现                                                                                                                                                                                                   |
| providers/model-error.ts / retry.ts                                                    | 错误分类与有界重试策略                                                                                                                                                                                                                  |
| config/settings.ts / config.ts / data-directory.ts                                     | 连接/偏好参数 schema、仅保存偏好的配置加载、内存密钥与平台数据目录                                                                                                                                                                      |
| tracing/recorder.ts / archive.ts / model-provider.ts                                   | 任务 span、模型安全摘要、Sandbox execution/instance/kind、跨轨道 flow、Trace Event JSON 导出，以及按会话/任务安全落盘；模型包装器保持 Provider 契约与取消语义                                                                           |
| sandbox/broker.ts / runtime-capability-core.ts                                         | Sandbox 优先/宿主 fallback 分流；命令 executionInstance/PID/创建时间账本；Runtime→Broker 的一次性命令审批 grant 与宿主模型代理 capability core                                                                                          |
| sandbox/runtime-ipc-\*.ts / agent-runtime-\*.ts / runtime-model-provider.ts            | 有界双向 framing、instance/nonce 握手、Broker model/session/approval/memory adapter、Runtime 侧完整 agent loop 及 Engine launcher 分流；Windows Supervisor launcher 与联合身份 transport 已接入，独立 harness 已通过，仍待提升环境产品验收 |
| sandbox/native-windows-runtime.ts / C++ supervisor                                     | 受保护安装副本自检、有界二进制执行帧、专用账户/restricted token/ACL/Job/desktop、取消、恢复 journal、Git relay 与同 Job askpass；仍待提升环境产品验收                                                                                   |
| sandbox/supervisor-protocol.ts / supervisor-channel.ts                                 | 更高层 Broker→Supervisor strict typed operation 与私有 handle framing；不暴露任意 SID/ACL/handle。当前产品 launcher 使用更窄的固定原生帧启动 Agent Runtime/Runner；模型、session、审批和 trace 则走已认证 Runtime IPC，不经过该控制协议 |
| logging/logger.ts / redact.ts                                                          | 日志创建、错误详情序列化、格式化输出与轮转、纯文本脱敏                                                                                                                                                                                  |
| permissions/approval-manager.ts                                                        | ApprovalManager：授权等待与取消                                                                                                                                                                                                         |
| server/app.ts                                                                          | 服务组装、业务路由与关闭顺序                                                                                                                                                                                                            |
| server/local-security.ts / session-events.ts                                           | 环境访问密码、来源与本机会话防护；SSE 连接管理与清理                                                                                                                                                                                    |
| server/http-server.ts                                                                  | 保留 Pino 日志类型的 HTTP 服务类型                                                                                                                                                                                                      |
| web/App.tsx / MarkdownTaskEditor.tsx / useSessionConnection.ts / SessionStatistics.tsx | 页面交互与布局、任务输入框的所见即所得 Markdown 编辑和 Markdown 序列化、开发服务完整页面重载、当前会话右上角的折叠统计，以及快照和 SSE 重连生命周期；切换会话时先清除旧快照并显示本地历史加载提示                                       |
| web/Timeline.tsx / MarkdownMessage.tsx                                                 | 事件时间线、工具输出聚合，以及用户和 agent 消息的 GitHub Flavored Markdown 渲染；原始 HTML 不进入页面 DOM                                                                                                                               |

本次全库审查将原 registry.ts 中的 ToolRunner 移出；paths.ts 原本就是路径函数模块。Engine、Store 及其上下文/schema 辅助模块、共享数据契约、测试和开发脚本继续按各自职责组织，不为每个小函数增加文件。

## 一次任务

1. Web UI 创建绑定真实工作目录、标题为“新对话”的会话，然后提交用户文本。
2. 后端将任务保存为 queued，并以 SQLite 条件更新保证同一会话没有另一项 queued/running/waiting 任务；调度器以 createdAt 稳定选择任务，在全局上限内启动不与运行任务共享真实工作目录的项。被同目录锁或全局上限阻塞的项保持 queued，以避免文件、命令、Git 与上下文互相干扰；它与用户消息和首条标题领取在同一事务中保存。
3. 已领取的首条消息先由低成本辅助模型生成无工具的简短标题；该请求有界重试，失败保留占位标题并不阻断主编码任务，取消则中止任务。
4. 主任务加载本地上下文与根 AGENTS.md，模型请求包含当前指令、上下文与工具定义，并请求服务允许多个独立工具调用；复杂任务要求模型先通过只读工具读取相关代码和文件并获得足够当前信息，再在用户可见文本中自行给出“计划摘要”，随后在同轮或后续轮次调用工具执行，实质调整前更新摘要；接收文本及完整输出项。
5. 自研循环先解析每项的 `execution` 信封，并在任一节点执行前拒绝重复 ID、未知依赖或环；旧历史格式作为无依赖调用兼容。通过校验后，Engine 以稳定拓扑顺序准备所有已满足前置条件的节点；参数检查、低成本模型判断和人工审批不占用最多 4 个 `Tool worker` 执行槽，审批通过并完成执行前复核后才排队取得槽位。宿主模式中原本需要审批的调用继续由低成本模型给出自动通过、人工确认或拒绝；Sandbox Agent Runtime 已有权限内的工具直接执行，只有 push 和 `run_with_permissions` 越界命令进入 Broker 审批。`run_with_permissions` 通过两阶段 Runtime IPC 先取得当前连接与 toolCallId 绑定的一次性 authorizationId，Runtime 获得执行槽后才消费授权并启动 Runner。前置失败时所有后继不执行而返回 `dependency_failed`，独立节点继续；每个完成或阻断的节点立即保存 `function_call_output`。DAG 覆盖读取、写入、命令及 Git，不推断共享文件或命令资源冲突，模型必须为需要串行化的调用声明依赖；ToolRunner 的路径、快照、权限和文件编辑复核仍然生效。
6. 每次实际模型请求记录 model_request，服务返回合法 usage 时再记录 model_usage；没有 usage 的请求不虚构 token。TraceRecorder 同时在任务、上下文、模型和实际工具执行边界记录单调时钟 span，模型只写安全计数和 usage，工具审批等待不计入执行 span；任务结束后将 trace 原子写入数据目录的会话/任务独立文件并立即释放内存记录，同一任务可导出 Perfetto JSON 分析轨道、并行度和关键路径。没有工具调用且收到完成文本时任务结束，Store 保存 finishedAt；超时、取消、失败或超过步骤上限时明确停止。前端通过 SSE 得知标题或任务状态变化：首个 refresh 读取完整快照，之后携带最后已见 event ID 只读取新增事件、按 ID 去重合并，任务和审批状态仍每次刷新；在默认折叠的会话统计中聚合服务实报 token、LLM 请求/轮次、工具成功率与累计运行时间，并只为后端清单确认已保存的任务显示 trace 下载入口。Timeline 将未被完整回复收敛的流式文本放回其最后一个 delta 后，避免旧断流残片错误显示在末尾；切换时立即显示“正在打开对话”，不把旧会话内容误当成新会话；重新连接只读状态，不会再次启动任务。

## 历史与恢复

上下文完整存储在本机；不依赖 previous_response_id 或服务端持久化。中断后旧对话可继续提问。先用已持久化工具结果修补缺失输出；没有记录的调用补充“执行结果未知”，不重放它。新任务必须重新读取文件。模型请求由 providers/retry 实施有界重试；人工恢复创建带来源记录的新任务，仅允许恢复会话最后一个失败、取消或中断任务。任务创建与用户消息、工具结果与上下文分别以 SQLite 事务保存。详情见 [恢复机制](recovery.md)。

任务输入框使用 MarkdownTaskEditor 的受限 Tiptap 文档 schema：用户输入 Markdown 触发规则时，标题、强调、列表、引用和代码在原编辑位置转为富文本；编辑器在每次更新后通过 Markdown 扩展序列化为 Markdown，App 将该生成文本作为 prompt 提交。它不保留原始标记字符、预览切换或独立预览区域，也不持久化未发送草稿。编辑器只允许已注册的节点和 mark，生成文本而非富文本 HTML 进入后端。UI 历史包含消息、工具调用、受限工具结果和修改 diff。Timeline 通过 MarkdownMessage 将用户和 agent 文本渲染为 GitHub Flavored Markdown，支持标题、列表、表格、任务列表、链接和代码围栏；不加载原始 HTML，因此会话中不可信的模型或用户文本不能注入页面 DOM。`run_command`、`git` 等有流式输出的工具，将开始、输出与退出状态按调用 ID 聚合为同一可展开卡片；长内容带截断提示，历史不是无限容量的终端录制。

## 文件和命令边界

文件操作解析真实路径，考虑符号链接与 Windows junction；工作区外或敏感路径询问用户。`edit_files` 的 create:true 只能新建不存在的路径，预检、审批等待后和写入前都会复核，拒绝覆盖期间出现的文件；它可创建父目录。create:false 的现存文件须先读取，精确修改时比对内容哈希，拒绝外部并发修改。临时文件写入后重命名，并保留已有文件的原模式。

`run_command` 的模型参数只有 `{ command }`，执行器固定在会话工作区运行。Windows 内部按 `pwsh`、`powershell`、`cmd.exe` 的优先级检测真实可执行文件；macOS/Linux 使用已验证的 `/bin/sh`。执行器追加固定非交互参数，模型不提供或探测 shell。直接 Git 程序名（包括复合命令中的 Git）被拒绝，改由 `git.ts` 提供单一 action 子集。Sandbox 关闭、macOS/Linux 或 Windows 启动前 fallback 仍沿用宿主审批和会话授权，模型只接收宿主工具定义与提示，不会看见 `run_with_permissions` 或 Sandbox 专属说明；Windows Agent Runtime 已实际启动后才接收该工具，且其已有权限的文件工具、命令和非 push Git 不再审批。若 Runtime 中的命令需要额外能力，模型必须改用 `run_with_permissions`，提交命令、最多 16 个现存递归只读根、16 个现存递归可写根、一个公网 HTTPS host 和理由；Broker 重新审批后启动独立 capability runner，声明根进入 AccessManifest，host 进入短期 CONNECT relay，且不允许宿主 fallback。该 Runner 不继承宿主 profile/凭据，不能获得未声明路径、多个 host、私网、监听或任意 socket；短期 proxy token 仅存在于该 Runner 环境。Git push 保持更窄的 PushSpec/Push Runner/WinCred askpass 路径。按账户 SID 的持久 WFP fence 始终只允许固定 Broker relay/proxy 端口；host 边界不限制上传内容、URL path 或命令将哪些可读数据发送出去。supervisor 记录 process handle、PID 和创建时间，以 Job 管理后代。安装器、产品 ACL/WFP/relay、Git 配置投影、恢复 journal、独立 sandbox.log 与 tracing 已实现；固定账户提升安装、真实 remote push、capability runner 的 ACL/代理/取消矩阵和复杂 ACL/崩溃夹具仍待验收。后续边界见 [windows-integrity-sandbox.md](windows-integrity-sandbox.md)。

## 补丁编辑的准确性边界

`read_file` 以全文字节哈希作为任务内版本凭证，并可在不替换原始 `text` 的前提下返回可见空白视图。`edit_files` 的 create:false 条目带 `fileVersion`；模型默认省略行范围，以全文唯一匹配避免旧行号漂移。`FileEditor` 先核对读取凭证、版本和路径，再由 `edit-plan.ts` 在原始快照上依次尝试精确匹配、所有文本文件可用的唯一 CRLF/LF 等价匹配、普通文件可用的唯一宽松空白匹配。已有文件成功编辑后会作废本任务读取凭证，下一次编辑必须重新读取。换行等价定位映射回真实字符区间，并让替换文本延续匹配片段的单一换行风格；显式行范围始终是硬边界。候选不唯一、版本变化或空白敏感路径的宽松空白请求均产生结构化诊断，不会猜测位置。现有 Engine 工具 span 继续记录该工具的开始、结束、失败、取消、耗时和关联 ID；本次不新增独立运行阶段。诊断仍只保存代码、行号和受限摘要。

## HTTP 访问边界

服务默认监听 `127.0.0.1`，可通过 `CODEATELIER_LISTEN_ADDRESS` 切换至 `::1`；显式设为 `0.0.0.0` 或 `::` 时开放对应局域网接口。开发 Vite 服务读取同一环境变量，并将 API 代理固定连接到相应回环地址。默认回环模式拒绝非本机 Host；局域网模式接受 LAN Host，同时继续校验同源 Origin、HttpOnly/SameSite=Strict cookie 与写请求 token，不开放任意来源 CORS。设置 `CODEATELIER_WEB_PASSWORD_ENABLED=true` 时，服务启动还要求非空 `CODEATELIER_WEB_PASSWORD`，未验证访问仅可读取门禁状态或提交密码；匹配后写入独立的 HttpOnly/SameSite=Strict `ca_access` cookie，其他 API（包括 bootstrap 和 SSE）才可使用。该单一密码没有账户、角色、限流或公网安全语义，cookie/token 仍分别只承担门禁状态、本机会话和跨站请求防护；局域网模式仍仅适用于受信任网络，防火墙必须阻止公网入站访问。启动时重新生成访问与本机会话令牌。设置接口不返回 API key；浏览器提交密钥后不持久化它。

`pnpm start` 运行 `launcher.ts` 监督进程，并由它 fork 实际监听端口的 `main.ts` 子进程。经本机 cookie/token 鉴权和 `{ confirm: true }` 确认后，`POST /api/server/reload` 先停止任务、保存可恢复中断并关闭 SSE、HTTP 与 SQLite；旧子进程关闭后仅通过固定 IPC `server.reload` 事件请求父进程 fork 新的构建产物。父进程等待旧进程释放端口，因而不会并行监听。新进程启动时生成新的本机会话 token，UI 轮询到 token 变化后才完整刷新页面。重载不撤销已修改文件，但不能恢复已经关闭的服务；它也不编译源码，生产模式须先 `pnpm build`。开发时 `tsx watch` 与 Vite HMR 仍分别负责源码自动更新。

模型元数据与实际 usage 由 providers/model-metadata.ts 校验，context/token-budget.ts 计算本地 token 估算和输入预算，UI 区分估算与实报；详见 [model-tokens.md](model-tokens.md)。

上下文压缩的触发、持久化、失败边界与模块职责见 [context-management.md](context-management.md)。活动上下文可为摘要与最近原文的组合；压缩前完整输入另存快照，不删除事件历史。

压缩按读取去重与过期版本正文归档、工具正文归档、完整分块摘要逐级执行；Engine 为 ContextManager 注入 ToolRunner.currentFileHash，只在阈值压缩时探测安全工作区文件，对照读取结果中的全文 contentHash；read-projection.ts 负责读取投影，tool-projection.ts 负责其他工具的选择性正文归档，tool-result.ts 共享来源核对与摘录，ContextManager 负责阶段选择与原子提交。常规压缩无法在硬预算内完成时，Worker 构造 `fallback` 活动视图：完整输入仍保存到快照，活动视图保留全部用户原文、最新结论与完整近期批次，不能满足这些保留项时停止。快照记录精确投影以在后续摘要前还原全文，保留已验证来源的旧摘要原文。

## SWE-bench 开发评测

`src/evaluation/` 保留生产 Engine/Store 的无界面入口、预算、审批和执行记录。`scripts/swebench/dataset.py` 校验固定子集并仅生成 issue 提示词；`predict.py` 在官方任务镜像中运行 agent 并提取补丁；`grade.py` 在独立干净环境调用官方评分器；`prepare.py` 打包白名单运行文件。详见 [swebench.md](swebench.md)。

工具结果先持久化到活动上下文，随后在下一次模型请求前重新计量并在超预算时压缩或进入保底视图，避免把超长工具数据直接附加给模型。未触发压缩时，Engine 发送相同的完整历史，估算与 usage 校准也使用这份实际输入。Git `diff` 另有 12000 字符硬输出上限，避免全量补丁绕过通用工具输出配置而占满上下文。

最终报告由 scripts/swebench/report.py 从运行和官方评分产物聚合；predict.py/grade.py 仅在用户手动运行结束时调用。报告可单独离线重建，分开正确性、效率、过程和数据完整性；不引入模型评分或额外评测运行。

### 辅助模型配置与摘要路由

`Config` 在启动时只从 `.env` 或进程环境读取 API 地址、主模型和辅助模型标识；这些部署连接字段不进入 `settings.json`，设置 API 也拒绝其改动。`settings.json` 仅保存思考等级、执行限制和日志级别，保存后会覆盖同名环境默认值；浏览器仅只读展示连接信息。`config/auxiliary-model.ts` 的 `auxiliarySettings` 为辅助调用创建独立配置副本；Engine 保持主任务提供商不变，并通过 ContextManager 的惰性 `summaryModel` 回调为摘要提供独立模型及预算。首条 prompt 的标题生成也使用该选择函数、无工具请求和 64 token 输出上限；空辅助配置沿用主模型。`permissions/model-approval.ts` 对每项待审批请求使用已显式配置的辅助模型、无工具和 256 token 上限，严格解析 `approve`、`human review`、`reject`；空配置、故障或无效输出不使用主模型，而是保守要求人工确认。模型不能自行改变执行器安全边界。

### 项目与对话展示

`src/web/App.tsx` 按服务端保存的真实 `workspace` 路径分组已有会话，展示项目目录、对话数量和独立会话列表。项目名称右侧的加号直接以该路径调用 `POST /api/sessions` 创建独立记录；连接其他项目使用页面内目录表单，不使用“新建项目对话”弹窗。桌面保持双栏布局；最大宽度 650px 的手机视口将侧栏变为从顶部菜单打开的导航抽屉，选择会话、打开项目/设置/服务操作、点击遮罩或按 Escape 都会关闭抽屉。Engine 在每个任务开始时，从平台数据目录按真实路径 SHA-256 隔离的 Markdown 文件检索一次受预算限制的项目记忆 bundle，并固定追加到任务模型指令；模型可调用受限 `memory_apply` 创建、更新或 archive 当前项目条目，FileStore 串行化写入并原子替换文件。该能力不新增项目 SQLite 表、不修改工作区、不需要人工确认，且 tracing、日志、SSE 只记录安全计数、状态和操作 ID。项目记忆 UI、来源失效验证和手工恢复/清空仍待实现，详见 [项目记忆系统设计](memory-system.md)。
