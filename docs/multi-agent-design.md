# 多 agent 协作设计草案

状态：D111 已授权实施，分阶段开发中，尚未作为可用功能开放。本文针对用户提出的可选 subagent；当前单 agent 能力、同真实工作区串行规则及 Windows Sandbox 的验收限制仍以 [需求](requirements.md)、[架构](architecture.md) 和 [决策记录](decisions.md) 为准。

## 目标和不可混淆的边界

- 用户在**每个新任务提交前**决定是否启用 subagent；默认关闭。主 agent 始终对用户答复、计划、编辑、验证和最终结果负责。
- subagent 是从属于当前任务的短生命周期研究者：可以阅读受控资料、整理结论和提出修改建议，不能执行写入。主 agent 可并行协调它们；不同会话的工作区锁与全局任务并发上限不因 subagent 增加。
- **用户已确认只要求 subagent prompt 与工具层禁止写入**：指令明确不允许修改文件，模型工具声明和执行入口采用只读白名单，写入提案交给主 agent。Node Worker thread 与主 loop 同进程、同 OS 身份；这不抵御恶意线程直接调用 Node `fs` 或启动子进程，也不提供线程级 ACL 隔离。此风险属于已确认方案的非目标，不再作为实施前待确认冲突；不得将工具层约束宣传为 OS 级只读 Sandbox。Windows 专用账户 Sandbox 仍保护整个 Runtime 与宿主之间的边界，而非主、子线程之间的边界。

## 1. 入口和任务级设置

在对话框下方的发送按钮旁增加 `启用 subagent` checkbox，默认不勾选；选择只对**此次新任务**生效，发送后随任务一并保存为不可变 `subagentsEnabled`，排队后也不能改变。发送时把 `{ prompt, subagentsEnabled }` 交给 `/api/sessions/:id/tasks`；旧客户端缺省为 `false`。**契约/迁移阶段不得提前展示可勾选入口**：只有宿主和已启用的 Sandbox 路径均具备完整子任务闭环及恢复/取消后，才开放 checkbox；在功能未就绪的服务上请求 `true` 必须明确拒绝，不能静默当成单 agent。当前任务运行时只显示已保存的实际开关，不在任务中途切换；取消和人工恢复沿用原任务配置，恢复时不可意外开启。UI 不把未发送的选择当作任务实际状态。历史页显示任务是否启用、多 agent 计划和各 subagent 状态。

开关开启不意味着一定创建 subagent：主 agent 在完成必要的初步调查后，决定是否有可独立、只读的分任务；没有则按单 agent 路径继续，并记录 `skipped` 原因。提示词仅说明选择和能力，真正可创建的 subagent 数量、角色、输入大小和工具权限由服务端校验。

## 2. Loop、线程与资源配额

- 主 agent 沿用所在 execution instance 的现有 loop；每个活动 subagent 有**独立模型会话、上下文、轮次上限、AbortSignal 和状态机**，运行在该 execution instance 内专门创建的 Node.js `Worker` 中。Sandbox 启用时该进程是专用账户 Agent Runtime，而不是 Broker；启动前回退宿主后也须在 UI 和会话中保留 `host-process` 事实。Broker 不替 Runtime 执行 subagent loop。
- 不复用“主任务的四个 Worker”。现有 `DEFAULT_TOOL_CONCURRENCY = 4` 是**单轮工具 DAG 的执行槽位**，不是四条 agent 线程；另有最多四条只用于 `read_file` 字节解析的短任务 Worker 池。subagent loop 是持续的异步对话，复用解析池会占满读取槽位且混淆权限。为每个活动 subagent 分配独立 Worker；完成或取消后释放（未来有性能证据才讨论复用**独立的 subagent 池**，不得混用读取池）。模型请求属于 I/O，并不会仅因使用 Worker 加速；线程隔离用于独立 loop 生命周期与故障归属，而不是吞吐保证。
- 建议初始上限：**每任务累计创建最多 4 个、同时活动 2 个；所有任务合计同时活动 4 个**，目前每个子 Worker 最多运行 120 秒（从取得活动租约并进入 running 起算）、执行 12 轮，服务实报的累计 token 超过 32,000 时记为失败；无 usage 时仍使用输入 100,000 字符和轮次的备用限制。超限立即请求取消模型；如 Worker 仍未退出，则在 5 秒宽限后强制终止，确认退出后才归还租约。上述上限尚待实测且不是配置项；全局子模型请求和读取队列的更细配额仍待独立验收。宿主 Engine 可直接调用服务进程的全局资源调度器；每个 Windows Sandbox Runtime 是不同进程，须通过任务绑定的 Broker IPC 申请/释放全局 Worker 与模型请求 lease，不能把各 Runtime 的进程内计数误当全局限额。按任务公平排队；主任务正常结束或取消时，确认 Worker 退出后回收 lease；Runtime 断连或 Broker 关闭时先停止分配，待原 execution instance 清理完成或明确标记未知后再对账，不能提前把仍可能运行的 Worker 额度转借其它任务。现有全局 1～4 个主任务上限仍由 Engine 管理；四个 DAG 槽位仍归每个主任务工具批次使用，subagent 不得借此突破审批或任务超时。

## 3. 主控分工与消息协议

主 agent 在需要分工时返回结构化计划，而非仅靠自然语言触发创建。示意：

```json
{
  "subtasks": [
    {
      "id": "investigate_api",
      "role": "梳理接口和调用方",
      "objective": "给出受影响的入口与证据",
      "scope": ["src/server"],
      "dependsOn": [],
      "deliverable": "简短结论、证据位置、风险和建议"
    }
  ]
}
```

服务端在创建 Worker **之前**校验总数、ID 唯一、依赖无环、范围是已授权工作区/只读根的子集、角色与文本长度、预算以及当前任务状态；无效计划返回可修正错误而非部分启动。只允许主 agent 通过 `plan / message / await / collect / cancel` 请求协调器；subagent 不能再创建 subagent。每个 subagent 的输入包含任务目标、限定范围及必要的已核实事实，不复制完整主对话、密钥或其它 subagent 原始上下文；报告作为**不可信资料**回传，主 agent 复核文件版本和证据后自行确定是否修改。

`postMessage` 用于相同 execution instance 内的**主协调器 ↔ Worker** 通信，不建立任意 Worker 对 Worker 的直连；所谓互相通信是经协调器转发有类型的 `question / reply / progress / report`，避免环状等待、越界广播与绕过审计。所有消息使用版本化判别联合、`taskId/subagentId/messageId/parentId`、上限与 schema 校验；大文本截断或以受控分页读取，队列背压/超时；对同一活动实例的重复 `messageId` 返回已持久化回执；未确认的远程模型请求保留未知状态，不凭消息去重推断服务端从未执行，过期任务或被取消的消息丢弃。当前 Worker 仅能提出三种只读文件请求或 `ask_main` 问题（最多八次、每条 1,000 字符），由可信协调器落盘确认；主代理的 `await` 至多交付四条待答问题并可提前返回，只有主代理的 `message(replyTo)` 能答复原提问者。Worker 不同步等待回复、不能直连或向其它子任务广播。协调器统一完成权限和数据投递，不传递宿主对象、执行器引用、密钥或可用的 Broker IPC 句柄。Broker 模型调用仍通过经认证的 Runtime IPC adapter，新增子 agent 关联字段须逐层绑定 `taskId` 与 execution instance，不信任 Worker 自报身份。

建议生命周期：`planned → queued → running → completed | failed | cancelled | interrupted`。主 agent 可先等待必需结论，也可在 subagent 运行时处理独立事项；每份报告带来源文件版本/读取时刻。依赖失败时阻断下游并向主 agent 报告真实状态，不能把缺失结果当成功。最终结果只由主 agent 对用户发布。

## 4. 只读权限与写入归属

- subagent 模型可见工具采用**显式正向白名单**：三个受控文件读取工具加一个只能发向主协调器、不能写工作区的 `ask_main`；未来的只读历史/状态查询或公开检索仍须另行验收；不注册 `edit_files`、`memory_apply`、`run_command`、`run_with_permissions` 或通用 `git`。`git status/diff/show` 也不能直接复用现有完整 Git 工具，应另做只读命令及参数固定的查询代理并验证实际实现无副作用；首阶段可完全不提供 Git。不要通过“只读 shell”猜测命令是否写文件：测试、构建、重定向、Git、网络命令及插件都只能由主 agent 按原有权限执行。
- 拒绝不仅发生在工具列表：子工具代理先核对协调器持有的 `role=subagent` 与操作白名单，再解析和执行；Worker 不持有主任务 ToolRunner、Runtime IPC peer 或 session 存储引用。Broker 对新增的子模型请求与子事件路由校验身份、任务归属和固定操作类型，不向子路由提供审批升级、push、runner 或 memory 写入；这只是正常工具/协议调用约束，不能阻止同进程恶意代码冒用主线程能力。唯一允许的持久化是可信协调器写入子任务事件/报告，和“subagent 本身写工作区”区分。
- 主 agent 收集只读建议后，按既有读文件、计划、批量编辑、依赖声明、验证流程**独占发起所有写入**；对报告中提及的文件重新读取并校验版本。子 agent 与主 agent 可以并行读，但用户/外部进程仍可能改动文件，现有工作区锁不能替代版本检查。工作区内读写仍受执行实例原有 Sandbox/宿主权限约束；同进程 thread 没有独立 OS 身份，不能把白名单误称为防恶意代码的隔离。

## 5. Sandbox、持久化、恢复与取消

在宿主模式与 Windows Sandbox Runtime 内使用同一协调器抽象，但 **每个 execution instance 只管理自己的 Worker**；Broker 验证任务、instance、消息关联，Runtime adapter 不暴露任意宿主读写能力。Sandbox 的授权根、proxy lease、Job、generation 和清理账本覆盖 Worker 及其活动请求，不新增直连网络或 push 权限；主任务**正常完成、失败、取消、关闭或 Runtime 断连**均须先停止新消息、取消或有界等待尚未完成的模型与只读请求、终止超时 Worker、落盘真实子终态，才允许结束主任务 trace、发布 `task_end` 或释放 instance；主任务不得留下后台继续运行的子线程。断连/未知请求不能因 `terminate()` 就标记成功或声称不存在副作用。固定账户端到端验收完成之前，不得宣称本功能已在 Sandbox 下受保护；fallback 必须明确提示未隔离。

任务保存开关、计划（经校验）、subagent 状态、只读工具调用摘要/结果、报告与消费状态；每轮模型响应必须在继续子 loop 或执行工具前保存有界子上下文检查点，每次只读工具结果也须先落盘再发起下一轮。对模型请求先保存稳定 ID 与 `started`，确认结果后才标记 `completed`；结果未知时不得盲目重发。服务重启和断连将运行中的子任务标为 `interrupted`，不能凭线程消失声称成功；人工恢复先检查已保存结果与报告，只对确认尚未启动、纯只读且经当前文件重新校验的工作重新规划。结果未知时提示主 agent/用户人工判断，遵守原任务不自动重放副作用的规则。主任务失败、取消或关闭必须向全部子任务传播取消；正常完成则按有界等待后取消未结束子任务；子任务个别失败不隐式取消主任务，由主 agent 判断降级或失败。子任务单独限制执行时间与 token，用量汇总到主任务但保留逐个归属。

## 6. Tracing、日志与验证门槛

在 `src/tracing` 的任务根下增加 `subagent.plan / spawn / queue / model / tool.read / message / report / cancel / join` span 和跨轨 flow；记录 `taskId/sessionId/executionInstanceId/subagentId/messageId`、状态、耗时、模型轮次、token 和受限错误类别。不同 Worker 使用各自逻辑轨道/实际 thread ID；跨线程单调时钟映射并校验时间基准，终态按已落盘结果归档。Sandbox Runtime→Broker 固定 trace 事件名称与属性 schema 必须同步扩展和验证，不能把自由文本、提示词、源码、报告、密钥或工具输出作为 Perfetto 属性。日志用相同关联 ID 和脱敏摘要；会话历史可保存完整报告，但遵从历史数据保护规则。

详细代码落点、发布门槛与分阶段验收见第 7 节；本节定义观测边界，不把草案、工具层测试或独立 Runtime IPC harness 当作真实 Windows Sandbox 验收。

## 7. 具体代码落点与接入顺序

以下描述目标落点；任务开关迁移、内部 Store/Worker、宿主协调和 Runtime→Broker 的任务绑定 IPC/lease/bundle 已接入且通过独立进程 harness；前端勾选与历史进度已预置但默认发布门禁仍为 false；固定账户提升环境及恢复/故障矩阵仍待完成，不能按本节目标推断现有功能已经可用：

- **UI/API**：`src/server/app.ts` 的任务 POST 用 Zod `subagentsEnabled: z.boolean().default(false)`，拒绝非布尔值；功能未就绪时显式拒绝 `true`。`src/web/App.tsx` 的 `send` 与输入框下方 `composerActions` 已预置默认 `false` 的 checkbox，但 bootstrap 返回未就绪时完全隐藏，伪造客户端仍会被 Engine/HTTP 拒绝；恢复按钮只提交 instruction，不读取当前 checkbox。更新 `src/shared/types.ts` 的 Task 和 `src/web/Timeline.tsx`，展示实际保存的选择与进度。
- **任务创建与恢复**：在 `src/agent/engine.ts` 的 `start`、`resume`、`run` 和 `runInAgentRuntime` 接入开关。将新增开关及原有 recovery 一并收束到具名 `StartTaskOptions`（而非两个易错的位置参数），迁移已有 `start(sessionId, prompt, recovery?)` 调用方；创建任务和用户事件在同一事务保存选项。`resume` 从来源任务读取开关创建**新任务**，不依据 UI 当前表单状态或重启旧 Worker。主 loop 仅在功能就绪且任务开关为真时提供协调工具。
- **存储/流式展示**：更新 `src/sessions/schema.ts`、`store.ts` 和 `src/server/session-events.ts`。`tasks.subagentsEnabled INTEGER NOT NULL DEFAULT 0`，逐分片 migration 兼容旧历史；子任务状态以 `(taskId, subagentId)` 唯一标识，同会话内保存有界检查点及请求 ID。进度和报告通过现有 `events` 全局游标进入快照/SSE，界面从持久化事件还原。主会话的 `collect` 工具结果与子报告消费状态需在宿主 Store 的同分片事务中提交；Runtime 经 Broker 提供固定的原子 adapter，不允许仅先写“已消费”再异步保存主模型输出。
- **两条执行路径**：宿主 `Engine.run` 与 Sandbox `AgentRuntimeService.run` 都构造同一个任务级 `SubagentCoordinator`；前者用本地 Store/Provider adapter，后者经 RuntimeModelProvider 和有序 session IPC adapter。全局子任务 lease 与已登记子任务验证由服务进程的 Engine/Broker 掌握，Runtime 只持有本任务受限 adapter，Broker 不承载子 loop 或代做工作区工具。必须共用工具层协议与校验，不能只在宿主实现。
- **只读工具**：在 `src/tools/registry.ts`、`tool-runner.ts`、`paths.ts` 与 `read-file-worker-pool.ts` 的既有边界上新增主 agent 协调工具及独立的子工具白名单。子工具只有 `read_file` 和新做的受控 `list_entries`、`search_text`（见下节）。不向 Worker 暴露通用 ToolRunner、shell、Git 或 memory adapter；文件读取复用既有路径检查及行数/大小限制，但不占用 read_file 解析 Worker 执行 agent loop。
- **Runtime IPC/打包**：更新 `src/sandbox/runtime-ipc-protocol.ts`、`runtime-capability-core.ts`、`runtime-model-provider.ts`、`runtime-ipc-broker-session.ts`、`scripts/windows-sandbox/build-runtime.ts`、`src/sandbox/native-windows-runtime.ts` 和 `native/windows-sandbox/restricted-runner.cpp`。`start_task` 传保存的开关；计划先由 Broker 绑定已认证连接的 task/instance，在 Store 登记并确认子任务 ID，才允许 Runtime 为该 ID 请求 lease、模型及固定子事件；不信任 Worker 自报 ID。扩展现有仅 `task | compaction` 的模型 purpose、固定 trace/session 事件枚举及有界帧大小检查，协议/安装版本不兼容时按既有 Sandbox 启动前安全回退条件显式提示 `host-process` 并继续完整子功能；无法证明安全回退时拒绝，不得静默降级为单 agent 或冒称 Sandbox 成功。单独打包 `subagent-worker.mjs`，同步 manifest、原生安装状态/摘要验证、复制和自检路径；Sandbox 不回退到未校验源码 Worker。
- **Tracing/测试文档**：更新 `src/tracing/*`、`tests/*`、`tests/e2e/*`、`docs/testing.md` 和 `docs/verification.md`，分别保存单元、HTTP/SSE、独立 Runtime harness 与真实提升环境验收证据。设计文档不代替上述实现或验收。

### 7.1 主从接口与线程通信

主 agent 的结构化分工通过新增的**主角色专用**函数工具 `subagent` 发起，不解析普通回答中的 JSON。`src/agent/subagent-contracts.ts` 维护 Zod 判别联合、消息版本、长度/数量限制；模型可请求 `plan`（提交第 3 节的 subtasks）、`message`、`await`、`collect`、`cancel`。当前 `src/tools/registry.ts` 会自动暴露 schemas 中的工具，而 `src/tools/model-tool-batch.ts` 只解析已登记工具：实现时须同时改造**按任务条件生成的模型定义、图构建的可用工具校验，以及 Engine/Runtime 的显式执行分派**。通用 ToolRunner 不得接管 `subagent`；未开启时定义不可见，伪造调用即使通过解析也须在执行入口拒绝。`plan` 只返回已登记/跳过的 ID；后续模型轮次才能使用结果，不能在同一 DAG 批次猜测未知 ID。`await` 设超时/取消并且不占执行槽，但仍占本工具批次的活动节点，整个批次会等待它；限制同批等待数量，禁止相互等待，避免阻塞主 agent 的后续轮次。

`src/agent/subagent-coordinator.ts` 持有 taskId、execution instance、配置快照、每个 Worker 句柄、任务内限流器与持久化 adapter；`src/agent/subagent-worker.ts` 只被提供子会话上下文、独立 `runModelLoop` 状态与 `parentPort`，不能通过协议获取主工具或项目密钥。为 Worker 显式设置最小 `env`，避免默认继承父进程环境中的敏感配置；这减少意外传递，但同进程线程仍不是可抵御恶意代码的秘密隔离边界，不声称 Worker 绝对无法读取 API key。`subagentId` 由计划校验/协调器分配，不接收 Worker 自报权限。Worker 来源按 tsx 开发、普通 JS 构建和 Sandbox 安装 bundle 分流；启动前须取得 Broker/Engine 全局 lease，任务内同时至多 2 个活动子任务、每任务累计至多 4 个，跨任务公平排队。同工作区仍是**一个主任务**占锁；子任务不能创建下一层 Worker。

当前内部 `postMessage` v2 的 request/response/finish/stop/message 已核对固定版本、taskId/subagentId 与逐方向单调序号；子→主 `question` 与主→原提问者 `replyTo` 已接入持久回执、全局任务身份和有界队列，跨子任务直接提问及更广的 progress 类型仍未完成。目标消息采用带版本的判别联合：`start | model.request | model.delta | model.result | tool.request | tool.result | question | reply | progress | report | cancel | error`。每条消息具有 `taskId/subagentId/messageId`、必要时 `replyTo` 与单调序号；协调器从自身登记表核对 Worker 句柄和归属，而非信任消息中的身份字符串。只允许协调器转发其他 subagent 的受限 `question/reply`；限制大小、队列、未完成请求数、发送次数和等待时间，避免环形等待。进度不是主 agent 的已验证结论。Worker 异常、退出和迟到回执按已记录状态处理；同一实例的重复消息查持久化状态，已确认的报告不重复写。对于刚发出但未获确认的模型请求，保留 `started/unknown` 记录和原 requestId，不把网络调用误认为可安全幂等重发；主任务在恢复时核对实际结果。

模型调用由 Worker 发 `model.request`，协调器调用当前 execution instance 的 provider（Sandbox 内再由已有认证 Runtime IPC 向 Broker 代理），协调器只通过消息发送模型流片段、结果和 usage，不主动传 API key、Provider 对象或 IPC peer；进程内的 Worker 不构成密钥隔离。Worker 的本地上下文含受限目标、工作区相对范围、已核实的必要事实和子 prompt；报告经 `collect` 进入**主 agent 的工具结果**，不得直接并入主会话原始模型协议记录。只有主 agent 能提交写入和最终用户答复。

### 7.2 只读工具和文件边界

`src/agent/subagent-worker.ts` 独立构造子 prompt：说明只调查/分析、不能写文件、不能要求主协调器代执行隐含命令或绕过用户权限、报告需列出证据文件及其版本；项目 AGENTS.md 等仓库内容仍视作资料，不能扩大工具权限。`src/tools/subagent-readonly.ts` 的正向白名单只接受 `read_file`、`list_entries`、`search_text`；二者新增的读取工具必须直接使用 Node 文件枚举/内容扫描，**不能**以 `run_command`、Git、外部可执行文件或插件包装“只读”搜索。路径按既有 `resolveTarget` 等检查规范化后落在当前任务授权读取范围内，拒绝越界、敏感位置和不安全链接，限制文件数、字节数、匹配数、行数和返回字符数；Sandbox 模式同时接受原有 AccessManifest/OS 限制，宿主模式沿用已有安全路径语义。首次增量不提供 `web_search`、Git、外部根或 memory，确有需要再单独设计权限/回归。

工具声明只对 Worker 的模型请求可见；协调器收到 `tool.request` 时再次核对角色、名称、参数 schema、路径、范围与任务有效性，然后执行受限读取并保存调用状态和有界结果。子 Worker 从不加载 `ToolRunner` 的写入 adapter；即便模型构造 `edit_files`、`run_command`、`git`、`memory_apply`、`run_with_permissions` 或 `subagent` 调用，也在**调用执行之前**拒绝，既不要求主 agent 代行，也不触发审批。主 agent 收集报告后再自行 `read_file`，获取当前内容哈希；直接使用报告中的旧哈希编辑应被现有版本校验拒绝。这是工具/受信任代码层面的限制，不是 OS 级线程隔离。

### 7.3 状态、存储与恢复的提交点

协调器先让宿主 Store 或已认证 Broker 固定 adapter 原子登记合法计划及 `planned` 行，确认后才占全局 lease 启动 Worker。子模型的 `acceptResponse` 必须先保存有界上下文与请求终态才执行只读工具，工具回执也先保存再继续下一轮；Worker 报告先与最终状态原子落盘，`await` 才能看到完成。`collect` 幂等读取**不可变报告**，其“已消费”标记必须与主任务 `function_call_output`/工具结果在同一任务所属 SQLite 分片事务内保存（Runtime 需新增固定 Broker adapter），不能在主模型输出落盘之前先标消费。对原主任务重放 `collect` 时可重读同一报告，不把“已消费”解释为已完成主任务持久化。子请求以 `subagentId + messageId` 唯一登记；持久化已确认回执/用量，未确认模型结果标记未知而不自动重发。模型输入与报告保留在受控 session 历史或子状态，**不**进入 Perfetto 属性；持久化失败使子任务停下并报告真实失败/未知，不让内存成功先于落盘。子上下文检查点是必需且有界的，不复用主会话 context 表。

所有终态都进入同一个 `finally` 收尾：停止接收新消息 → 对正常完成时仍在跑的子任务明确取消或有界等待并记录实际状态，对失败/取消/关闭/断连传播 AbortSignal → 有界等待 Worker 退出 → 超时终止 → 保存子终态并释放 Broker 全局 lease → 才结束主任务 trace、发 `task_end` 并释放 Runtime。不能把子任务未退出的主任务记作已完成，也不能把已经返回但未落盘的子报告算成功。Store 启动时除将主任务标为 `interrupted` 外，还将原 `planned/queued/running` 的子状态标为中断；**不自动重新创建 Worker**。人工 `resume` 创建新主任务，继承原开关但不继承运行中线程；先展示已持久化报告和未知项，主 agent 重读当前文件后才决定是否再次研究。跨任务报告只作为有来源的历史资料，不把它误当成新子任务已完成。保持旧数据库与无子任务历史的读取兼容。

### 7.4 Tracing、Sandbox 与实现验收切片

`src/tracing/recorder.ts` 在主 task 根下建立逻辑 `Subagent <id>` 轨道；`plan/spawn/model/tool.read/message/report/cancel/join` 分别覆盖开始、结束、耗时和状态，并按 `taskId/sessionId/executionInstanceId/subagentId/messageId` 关联。跨 Worker 事件由协调器记录收发时间或映射时钟，Broker trace 只接收协议规定的固定名称、数字用量和受限错误类别；子 prompt、搜索结果、报告、源码和密钥不能进入 trace。Runtime→Broker 的 model purpose、trace 名称与事件属性和 session 事件白名单须同步扩展，并为子身份登记、全局 lease、模型请求与原子 `collect` 回执提供**固定而有界**的 IPC 操作；单帧大小、回压、取消和协议版本不匹配均安全失败。新增 Worker 文件时同步 Windows 构建 manifest、原生安装/状态摘要、自检与故障回退/清理测试；旧安装不兼容时提示更新；仅在现有启动前自检/清理能证明回退安全时标记 `host-process` 后继续完整子功能，不能把宿主 fallback 冒充 Sandbox 下多 agent 可用。当前子轨已有 worker/model/tool.read 以及显式 question/message/cancel 的独立固定安全 span；plan/await/collect 的结果仍由主工具 span 关联，不把预览报告放入 trace。固定账户端到端验收前只称 harness 可用；`pnpm sandbox:runtime:verify` 已添加对已安装 Worker 的显式产品链路验收步骤（发布门禁仍关闭），只有用户在真实安装环境运行才形成平台证据。

实施按以下**可独立验收的增量**推进（每增量同步文件导读、架构、覆盖清单和对应测试），前四项均不向用户显示可用 checkbox，也不接受来自 HTTP 的 `subagentsEnabled:true`；已有内部测试通过直接保存已标记任务验证未开放的宿主路径：

1. **内部契约与存储**：Zod 默认 `false`、旧数据库逐分片迁移、子状态/检查点与模型请求账本、主任务恢复继承；旧客户端与原单 agent 行为不变，服务未就绪时请求 `true` 明确拒绝。覆盖多分片、持久化失败及未知结果。
2. **主代理与全局配额**：按任务工具定义、图解析和两条 loop 的协调工具分派，Broker 子身份登记与跨进程 lease；用假 Worker/Provider 验证计划上限、无效计划零启动、同工作区锁、公平排队、取消与重复消息。
3. **真实子 loop 与只读工具**：独立 Worker、模型代理、受限 list/search/read、强制逐轮检查点与主任务全部终态收尾；宿主和 Runtime IPC harness 验证并发、版本变化、崩溃、超时及注入写入工具被拒（只证明工具层，不证明 OS 隔离）。
4. **一致性与 Sandbox 集成**：`collect` 与主会话工具结果原子落盘、重启后报告可重读、未知模型请求不盲重试、tracing、协议版本和固定事件、Windows 安装 bundle/摘要/清理验收。固定账户提升环境和跨平台验证各记真实证据，不能把 harness 或静态通过描述为已完成。
5. **最后开放 UI**：仅在上述路径可用时展示 checkbox 与历史进度；验证勾选但主 agent 合理跳过分工、单 agent 对照、刷新、排队、取消、人工恢复和实际创建/收集报告。涉及 UI/HTTP/SSE 运行 `pnpm test:e2e`；每个实现增量提交前运行 `pnpm check`。Evaluation 仅在用户明确要求时手动运行。

**已确认而非未决的取舍**：本方案不以恶意 Worker 线程、依赖代码或直接 Node API 为威胁模型；要获得对此类行为的 OS 级不可写承诺属于未来的独立进程/身份方案。D111 已授权实施可选多 agent，但未完成或未验收的增量不改变现有单 agent 能力声明。
