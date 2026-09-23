# 多 agent 协作设计草案

状态：设计草案，尚未实施或纳入初版功能边界。本文针对用户提出的可选 subagent 功能；现行单 agent 范围、同真实工作区串行规则及 Windows Sandbox 的验收限制仍以 [需求](requirements.md)、[架构](architecture.md) 和 [决策记录](decisions.md) 为准。

## 目标和不可混淆的边界

- 用户在**每个新任务提交前**决定是否启用 subagent；默认关闭。主 agent 始终对用户答复、计划、编辑、验证和最终结果负责。
- subagent 是从属于当前任务的短生命周期研究者：可以阅读受控资料、整理结论和提出修改建议，不能执行写入。主 agent 可并行协调它们；不同会话的工作区锁与全局任务并发上限不因 subagent 增加。
- **用户已确认只要求 subagent prompt 与工具层禁止写入**：指令明确不允许修改文件，模型工具声明和执行入口采用只读白名单，写入提案交给主 agent。Node Worker thread 与主 loop 同进程、同 OS 身份；这不抵御恶意线程直接调用 Node `fs` 或启动子进程，也不提供线程级 ACL 隔离。此风险属于已确认方案的非目标，不再作为实施前待确认冲突；不得将工具层约束宣传为 OS 级只读 Sandbox。Windows 专用账户 Sandbox 仍保护整个 Runtime 与宿主之间的边界，而非主、子线程之间的边界。

## 1. 入口和任务级设置

在对话框下方的发送按钮旁增加 `启用 subagent` checkbox，默认不勾选；选择只对**此次新任务**生效，发送后随任务一并保存为不可变 `subagentsEnabled`，排队后也不能改变。发送时把 `{ prompt, subagentsEnabled }` 交给 `/api/sessions/:id/tasks`；旧客户端缺省为 `false`。当前任务运行时只显示已保存的实际开关，不在任务中途切换；取消和人工恢复沿用原任务配置，恢复时不可意外开启。为防刷新后状态含混，UI 不把输入框的未发送选择当作任务实际状态。历史页显示任务是否启用、多 agent 计划和各 subagent 状态。

开关开启不意味着一定创建 subagent：主 agent 在完成必要的初步调查后，决定是否有可独立、只读的分任务；没有则按单 agent 路径继续，并记录 `skipped` 原因。提示词仅说明选择和能力，真正可创建的 subagent 数量、角色、输入大小和工具权限由服务端校验。

## 2. Loop、线程与资源配额

- 主 agent 沿用所在 execution instance 的现有 loop；每个活动 subagent 有**独立模型会话、上下文、轮次上限、AbortSignal 和状态机**，运行在该 execution instance 内专门创建的 Node.js `Worker` 中。Sandbox 启用时该进程是专用账户 Agent Runtime，而不是 Broker；启动前回退宿主后也须在 UI 和会话中保留 `host-process` 事实。Broker 不替 Runtime 执行 subagent loop。
- 不复用“主任务的四个 Worker”。现有 `DEFAULT_TOOL_CONCURRENCY = 4` 是**单轮工具 DAG 的执行槽位**，不是四条 agent 线程；另有最多四条只用于 `read_file` 字节解析的短任务 Worker 池。subagent loop 是持续的异步对话，复用解析池会占满读取槽位且混淆权限。为每个活动 subagent 分配独立 Worker；完成或取消后释放（未来有性能证据才讨论复用**独立的 subagent 池**，不得混用读取池）。模型请求属于 I/O，并不会仅因使用 Worker 加速；线程隔离用于独立 loop 生命周期与故障归属，而不是吞吐保证。
- 建议首版每任务最多 **2 个**活动 subagent，待容量与延迟测量后调整；同时限制全进程的 agent Worker 数、模型并发、总 token/轮次预算和排队长度。可采用公平限流，避免 1～4 个跨工作区任务各自扩张压垮本地模型服务。四个 DAG 槽位仍归每个主任务工具批次使用；subagent 只读请求另受总读取配额约束，不得借子任务突破审批、速率或任务超时。上述数字是草案默认值，不是现有可配置项。

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

服务端在创建 Worker **之前**校验总数、ID 唯一、依赖无环、范围是已授权工作区/只读根的子集、角色与文本长度、预算以及当前任务状态；无效计划返回可修正错误而非部分启动。只允许主 agent 请求 `create / cancel / await / collect`；subagent 不能再创建 subagent。每个 subagent 的输入包含任务目标、限定范围及必要的已核实事实，不复制完整主对话、密钥或其它 subagent 原始上下文；报告作为**不可信资料**回传，主 agent 复核文件版本和证据后自行确定是否修改。

`postMessage` 用于相同 execution instance 内的**主协调器 ↔ Worker** 通信，不建立任意 Worker 对 Worker 的直连；所谓互相通信是经协调器转发有类型的 `question / reply / progress / report`，避免环状等待、越界广播与绕过审计。所有消息使用版本化判别联合、`taskId/subagentId/messageId/parentId`、上限与 schema 校验；大文本截断或以受控分页读取，队列背压/超时；重复 `messageId` 幂等处理，过期任务或被取消的消息丢弃。Worker 只向协调器发送只读工具请求，协调器统一完成权限和数据投递，不传递宿主对象、执行器引用、密钥或可用的 Broker IPC 句柄。Broker 模型调用仍通过经认证的 Runtime IPC adapter，新增子 agent 关联字段须逐层绑定 `taskId` 与 execution instance，不信任 Worker 自报身份。

建议生命周期：`planned → queued → running → completed | failed | cancelled | interrupted`。主 agent 可先等待必需结论，也可在 subagent 运行时处理独立事项；每份报告带来源文件版本/读取时刻。依赖失败时阻断下游并向主 agent 报告真实状态，不能把缺失结果当成功。最终结果只由主 agent 对用户发布。

## 4. 只读权限与写入归属

- subagent 模型可见工具采用**显式正向白名单**：受控文件读取、已脱敏的只读历史/状态查询、必要时受限的公开检索；不注册 `edit_files`、`memory_apply`、`run_command`、`run_with_permissions` 或通用 `git`。`git status/diff/show` 也不能直接复用现有完整 Git 工具，应另做只读命令及参数固定的查询代理并验证实际实现无副作用；首阶段可完全不提供 Git。不要通过“只读 shell”猜测命令是否写文件：测试、构建、重定向、Git、网络命令及插件都只能由主 agent 按原有权限执行。
- 拒绝不仅发生在工具列表：子工具代理先核对协调器持有的 `role=subagent` 与操作白名单，再解析和执行；Worker 不持有主任务 ToolRunner、Runtime IPC peer 或 session 存储引用。Broker 对新增的子模型请求与子事件路由校验身份、任务归属和固定操作类型，不向子路由提供审批升级、push、runner 或 memory 写入；这只是正常工具/协议调用约束，不能阻止同进程恶意代码冒用主线程能力。唯一允许的持久化是可信协调器写入子任务事件/报告，和“subagent 本身写工作区”区分。
- 主 agent 收集只读建议后，按既有读文件、计划、批量编辑、依赖声明、验证流程**独占发起所有写入**；对报告中提及的文件重新读取并校验版本。子 agent 与主 agent 可以并行读，但用户/外部进程仍可能改动文件，现有工作区锁不能替代版本检查。工作区内读写仍受执行实例原有 Sandbox/宿主权限约束；同进程 thread 没有独立 OS 身份，不能把白名单误称为防恶意代码的隔离。

## 5. Sandbox、持久化、恢复与取消

在宿主模式与 Windows Sandbox Runtime 内使用同一协调器抽象，但 **每个 execution instance 只管理自己的 Worker**；Broker 验证任务、instance、消息关联，Runtime adapter 不暴露任意宿主读写能力。Sandbox 的授权根、proxy lease、Job、generation 和清理账本覆盖 Worker 及其活动请求，不新增直连网络或 push 权限；任务取消/清理必须先阻止新消息、取消模型与只读请求，等待线程退出（超时后终止），再按现有流程释放 instance。不能假设 `terminate()` 已回滚文件或已证明未知操作完成。固定账户端到端验收完成之前，不得宣称本功能已在 Sandbox 下受保护；fallback 必须明确提示未隔离。

任务保存开关、计划（经校验）、subagent 状态、只读工具调用摘要/结果、报告与消费状态；对每个模型请求/工具回执使用稳定关联 ID。服务重启和断连将运行中的子任务标为 `interrupted`，不能凭线程消失声称成功；人工恢复先检查已保存结果与报告，只对确认尚未启动、纯只读且经当前文件重新校验的工作重新规划。结果未知时提示主 agent/用户人工判断，遵守原任务不自动重放副作用的规则。主任务终止必须向全部子任务传播取消；子任务个别失败不隐式取消主任务，由主 agent 判断降级或失败。子任务单独限制执行时间与 token，用量汇总到主任务但保留逐个归属。

## 6. Tracing、日志与验证门槛

在 `src/tracing` 的任务根下增加 `subagent.plan / spawn / queue / model / tool.read / message / report / cancel / join` span 和跨轨 flow；记录 `taskId/sessionId/executionInstanceId/subagentId/messageId`、状态、耗时、模型轮次、token 和受限错误类别。不同 Worker 使用各自逻辑轨道/实际 thread ID；跨线程单调时钟映射并校验时间基准，终态按已落盘结果归档。Sandbox Runtime→Broker 固定 trace 事件名称与属性 schema 必须同步扩展和验证，不能把自由文本、提示词、源码、报告、密钥或工具输出作为 Perfetto 属性。日志用相同关联 ID 和脱敏摘要；会话历史可保存完整报告，但遵从历史数据保护规则。

按以下顺序增量实施并验证，不以本文代替实现授权：

1. API / UI / 存储：checkbox 只在提交前可选、旧客户端默认关闭、排队/刷新/人工恢复保持原选择；关闭时与单 agent 行为一致。
2. 计划校验与状态机：无效结构拒绝、上限/依赖/预算、跳过分工、消息去重、崩溃/取消与进度持久化。
3. 独立 Worker loop 与只读代理：模拟模型并发报告、跨线程通信、背压、版本变化；恶意模型尝试 `edit_files`、shell、Git、memory、审批和 IPC 越权时在所有入口拒绝且工作区不变。注明：这只验证**工具层**，无法证明同进程 Node 线程的 OS 级不可写。
4. Tracing / Sandbox 分层测试：宿主模式、Runtime IPC harness 和 Windows 固定账户提升环境分别验证关联、取消/清理、fallback、Job 与未知状态。UI/HTTP/SSE 交互运行 `pnpm test:e2e`，提交前 `pnpm check`；持续维护 [测试覆盖](testing.md) 与 [验证记录](verification.md)。

## 7. 具体代码落点与接入顺序

以下均为计划改动，尚未实现：

- **UI/API**：在 `src/web/App.tsx` 的 `send` 与输入框下方 `composerActions` 增加默认 `false` 的 checkbox；`src/server/app.ts` 的任务 POST 使用 Zod `subagentsEnabled: z.boolean().default(false)`，拒绝非布尔值。恢复按钮只提交 instruction，不读取当前 checkbox。更新 `src/shared/types.ts` 的 Task，以及 `src/web/Timeline.tsx` 的时间线，显示实际保存的选择与子任务进度。
- **任务创建与恢复**：在 `src/agent/engine.ts` 的 `start`、`resume`、`run` 和 `runInAgentRuntime` 接入开关。建议 `start(sessionId, prompt, options?, recovery?)` 在创建任务和保存用户事件的同一事务写入开关；现有仅以第三参数传 recovery 的调用方要逐一迁移，避免位置参数歧义。`resume` 从来源任务读取开关创建**新任务**，而非依据 UI 当前表单状态或重启旧 Worker。主 loop 仅在开关为真时提供协调工具。
- **存储/流式展示**：更新 `src/sessions/schema.ts`、`store.ts` 和 `src/server/session-events.ts`。`tasks.subagentsEnabled INTEGER NOT NULL DEFAULT 0`，逐分片 migration 兼容旧历史；子任务状态以 `(taskId, subagentId)` 唯一标识。进度、受限请求和报告通过现有 `events` 全局游标进入快照/SSE，界面从持久化事件还原，不另开不可恢复的内存流。
- **两条执行路径**：宿主 `Engine.run` 与 Sandbox `AgentRuntimeService.run` 都构造同一个任务级 `SubagentCoordinator`。前者使用宿主模型 Provider 和 Store adapter；后者经现有 RuntimeModelProvider 与有序 session IPC adapter。校验、协议和只读工具实现应共用，不能只在宿主完成；Broker 仍只承担模型、历史和 trace 的跨进程职责。
- **只读工具**：在 `src/tools/registry.ts`、`tool-runner.ts`、`paths.ts` 与 `read-file-worker-pool.ts` 的既有边界上新增主 agent 协调工具及独立的子工具白名单。子工具只有 `read_file` 和新做的受控 `list_entries`、`search_text`（见下节）。不向 Worker 暴露通用 ToolRunner、shell、Git 或 memory adapter；文件读取复用既有路径检查及行数/大小限制，但不占用 read_file 解析 Worker 执行 agent loop。
- **Runtime IPC/打包**：更新 `src/sandbox/runtime-ipc-protocol.ts`、`runtime-model-provider.ts`、`runtime-ipc-broker-session.ts`、`scripts/windows-sandbox/build-runtime.ts`、`src/sandbox/native-windows-runtime.ts` 和 `native/windows-sandbox/restricted-runner.cpp`。`start_task` 传保存的开关；Runtime 内协调器代理子模型请求/进度。子模型请求须带协调器绑定的 subagentId，Broker 验证认证连接的 task/instance 与子任务登记关系；固定 session/trace event schema 同步扩展。单独打包 `subagent-worker.mjs`，同步 manifest、安装状态/摘要验证、复制和自检路径，不得在 Sandbox 回退到未校验的源码 Worker。
- **Tracing/测试文档**：更新 `src/tracing/*`、`tests/*`、`tests/e2e/*`、`docs/testing.md` 和 `docs/verification.md`，分别保存单元、HTTP/SSE、独立 Runtime harness 与真实提升环境验收证据。设计文档不代替上述实现或验收。

### 7.1 主从接口与线程通信

主 agent 的结构化分工通过新增的**主角色专用**函数工具 `subagent` 发起，而不是解析普通回答中的 JSON。`src/agent/subagent-contracts.ts` 维护 Zod 判别联合、消息版本、长度/数量限制；模型可请求 `plan`（提交本节第 3 部分的 subtasks）、`message`（指定子任务提问/答复）、`await`（等待指定集合的终态或超时）、`collect`（取已保存报告）、`cancel`（终止指定子任务）。`plan` 在一轮工具结果中只返回已创建/跳过及 ID；后续工具轮才能引用该结果，不能在同一 DAG 批次猜测未知 ID。其他工具节点可与等待节点并行；`await` 必须可取消、有超时，不长占四个工具执行槽。未勾选时连工具定义也不发送，执行分派仍拒绝伪造的调用。

`src/agent/subagent-coordinator.ts` 持有 taskId、execution instance、配置快照、每个 Worker 句柄、限流器和持久化 adapter；`src/agent/subagent-worker.ts` 仅持有子会话上下文、独立 `runModelLoop` 状态与 `parentPort`。`subagentId` 由计划校验/协调器分配，不接收 Worker 自报权限。新建 Worker 的来源按 tsx 开发、普通 JS 构建、Sandbox 安装 bundle 分流，并限制每任务最多 2 个活动子任务、全局模型请求与 Worker 总量；跨工作区公平排队，同工作区仍是**一个主任务**占锁。子任务不能创建下一层 Worker 或请求主 agent 工具。

内部 `postMessage` 消息采用带版本的判别联合：`start | model.request | model.delta | model.result | tool.request | tool.result | question | reply | progress | report | cancel | error`。每条消息具有 `taskId/subagentId/messageId`、必要时 `replyTo` 与单调序号；协调器从自身登记表核对 Worker 句柄和归属，而非信任消息中的身份字符串。只允许协调器转发其他 subagent 的受限 `question/reply`；限制大小、队列、未完成请求数、发送次数和等待时间，避免环形等待。进度不是主 agent 的已验证结论。Worker 异常、退出和迟到回执按已记录状态处理；重复消息不重复写报告或触发模型请求，无法确认模型调用结果时标记未知并由主任务决定后续动作。

模型调用由 Worker 发 `model.request`，协调器调用当前 execution instance 的 provider（Sandbox 内再由已有认证 Runtime IPC 向 Broker 代理），Worker 只能拿到流式文本、结果和 usage，不能拿到 API key、Provider 对象或 IPC peer。Worker 的本地上下文含受限目标、工作区相对范围、已核实的必要事实和子 prompt；报告经 `collect` 进入**主 agent 的工具结果**，不得直接并入主会话原始模型协议记录。只有主 agent 能提交写入和最终用户答复。

### 7.2 只读工具和文件边界

`src/agent/subagent-instructions.ts` 独立构造子 prompt：说明只调查/分析、不能写文件、不能要求主协调器代执行隐含命令或绕过用户权限、报告需列出证据文件及其版本；项目 AGENTS.md 等仓库内容仍视作资料，不能扩大工具权限。`src/tools/subagent-readonly.ts` 的正向白名单只接受 `read_file`、`list_entries`、`search_text`；二者新增的读取工具必须直接使用 Node 文件枚举/内容扫描，**不能**以 `run_command`、Git、外部可执行文件或插件包装“只读”搜索。路径按既有 `resolveTarget` 等检查规范化后落在当前任务授权读取范围内，拒绝越界、敏感位置和不安全链接，限制文件数、字节数、匹配数、行数和返回字符数；Sandbox 模式同时接受原有 AccessManifest/OS 限制，宿主模式沿用已有安全路径语义。首次增量不提供 `web_search`、Git、外部根或 memory，确有需要再单独设计权限/回归。

工具声明只对 Worker 的模型请求可见；协调器收到 `tool.request` 时再次核对角色、名称、参数 schema、路径、范围与任务有效性，然后执行受限读取并保存调用状态和有界结果。子 Worker 从不加载 `ToolRunner` 的写入 adapter；即便模型构造 `edit_files`、`run_command`、`git`、`memory_apply`、`run_with_permissions` 或 `subagent` 调用，也在**调用执行之前**拒绝，既不要求主 agent 代行，也不触发审批。主 agent 收集报告后再自行 `read_file`，获取当前内容哈希；直接使用报告中的旧哈希编辑应被现有版本校验拒绝。这是工具/受信任代码层面的限制，不是 OS 级线程隔离。

### 7.3 状态、存储与恢复的提交点

协调器先在 `Store` 中原子保存合法计划及 `planned` 行，再依预算领取槽位并标记 `queued/running`，收到 Worker 报告时先保存报告和最终状态，再回复主 agent 的 `await`；调用 `collect` 时独立保存报告消费标记并幂等返回已保存报告。子请求以 `subagentId + messageId` 唯一登记；持久化已确认的工具回执与模型用量，避免重连重放；只允许可信协调器追加 `subagent_*` 事件。模型原始输入、自由文本报告保留在受控 session 历史或子状态中，**不**进入 Perfetto 属性。对每种写入失败，立即停止该子任务并向主任务报告失败/未知，不能让内存中的“完成”先于持久化结果显示成功。子上下文可保存有界检查点供人工恢复核对，不复用主会话 context 表作为子模型会话。

取消顺序为：停止接收新消息 → 取消子模型/读取请求 → 有界等待 Worker 退出 → 超时终止 → 保存子终态 → 结束主任务并释放 Runtime。主任务 `close`/取消沿用 Engine 的 AbortSignal；Runtime 断连按任务中断处理，不把已经返回但未落盘的子报告算成功。Store 启动时除将主任务标为 `interrupted` 外，还将原 `planned/queued/running` 的子状态标为中断；**不自动重新创建 Worker**。人工 `resume` 创建新主任务，继承原开关但不继承运行中线程；先展示已持久化报告和未知项，主 agent 重读当前文件后才决定是否再次研究。跨任务报告只作为有来源的历史资料，不把它误当成新子任务已完成。保持旧数据库与无子任务历史的读取兼容。

### 7.4 Tracing、Sandbox 与实现验收切片

`src/tracing/recorder.ts` 在主 task 根下建立逻辑 `Subagent <id>` 轨道；`plan/spawn/model/tool.read/message/report/cancel/join` 分别覆盖开始、结束、耗时和状态，并按 `taskId/sessionId/executionInstanceId/subagentId/messageId` 关联。跨 Worker 的事件由协调器记录收发时间或映射时钟，Broker trace 只接收协议规定的固定名称、数字用量和受限错误类别；不能把子 prompt、搜索结果、报告、源码或密钥写入 trace。Sandbox 既有 Runtime→Broker trace schema 需要与工具事件、模型 purpose/关联字段同步扩展；未通过真实固定账户验收前只称 harness 可用。若新增 Worker 文件，除 JS/TS 测试外还要同时扩展 Windows 构建 manifest、原生安装/状态摘要、自检和故障回退/清理测试，不得只给 Node build 添加入口。

实施按以下**可独立验收的增量**推进（每增量同步文件导读、架构、覆盖清单和对应测试）：

1. **契约/存储/UI**：任务开关的 Zod、旧客户端默认值、Store 全分片 migration、刷新/排队/取消/恢复继承、checkbox 与历史显示；服务端未开启时主 loop 与原单 agent 行为一致。HTTP/SSE 与 UI 跑 `pnpm test:e2e`。
2. **主 agent 协调工具**：主工具定义与两条 loop 的同名派发、Zod 计划/消息校验、状态机、去重与等待取消；先用假 Worker 和假 provider 测试无效计划零启动、并发上限、公平队列、重复报告和旧 ID 不能跨任务引用。
3. **真实 Worker + 只读代理**：独立子 loop、跨线程模型代理、受限 list/search/read 和子 prompt；分别在宿主、独立 Runtime IPC harness 测试并发、文件更新重读、Worker 崩溃、超时和取消；对写入工具注入调用证明既无审批也无文件改动（不将其表述为 OS 隔离证明）。
4. **恢复/trace/Sandbox 打包**：子状态检查点与主报告消费、持久化失败/未知结果恢复、任务终止全部 Worker、Perfetto 轨道与流关联、Sandbox 安装文件摘要/IPC/Job/代理清理；先跑受控测试，再在满足提升环境前提时做 Windows 端到端验收并在 `docs/verification.md` 如实记录未覆盖平台。每个实现增量提交前跑 `pnpm check`，涉及 UI/HTTP/SSE 再跑 `pnpm test:e2e`；Evaluation 仅在用户明确要求时手动运行。

**已确认而非未决的取舍**：本方案不以恶意 Worker 线程、依赖代码或直接 Node API 为威胁模型；要获得对此类行为的 OS 级不可写承诺属于未来的独立进程/身份方案，不阻塞当前工具层实现计划。除该边界取舍外，多 agent 功能仍未获现行初版范围的实施授权，本文不改变现有单 agent 能力声明。
