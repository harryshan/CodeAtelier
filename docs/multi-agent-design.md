# 多 agent 协作设计草案

状态：设计草案，尚未实施或纳入初版功能边界。本文针对用户提出的可选 subagent 功能；现行单 agent 范围、同真实工作区串行规则及 Windows Sandbox 的验收限制仍以 [需求](requirements.md)、[架构](architecture.md) 和 [决策记录](decisions.md) 为准。

## 目标和不可混淆的边界

- 用户在**每个新任务提交前**决定是否启用 subagent；默认关闭。主 agent 始终对用户答复、计划、编辑、验证和最终结果负责。
- subagent 是从属于当前任务的短生命周期研究者：可以阅读受控资料、整理结论和提出修改建议，不能执行写入。主 agent 可并行协调它们；不同会话的工作区锁与全局任务并发上限不因 subagent 增加。
- 用户所说的“严格不能写文件”包含两个层次：应用层工具权限可以硬性拒绝任何写入请求；**同一进程的 Node Worker thread 不提供 OS 级只读身份**，不能阻止被攻陷的线程绕过工具直接调用 `fs` 或启动子进程。若要求对恶意/失控线程也保证不可写，必须改为独立低权限进程/独立身份与文件 ACL 等边界，不能同时承诺“同进程线程”和此级别的安全保证。Windows 专用账户 Sandbox 目前也不能为同账户线程赋予独立文件 ACL。本文的同进程方案只承诺对受信任实现和模型工具调用的强制只读策略，不冒充 OS 隔离。

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
- 拒绝不仅发生在工具列表：解析和执行入口都须核对不可变 `role=subagent` 与调用能力；IPC / Broker 路由也拒绝任何子角色的写操作、审批升级、push、runner 或 memory 写入。禁止 subagent 直接调用主任务的工具执行器与 session 存储接口；唯一允许的持久化是由可信协调器写入子任务事件/报告，和“subagent 本身写工作区”区分。
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

**需另行确认的冲突**：如果“严格不能写任何文件”是对恶意线程、任意 npm 依赖或直接 Node API 都成立的安全要求，则应选择独立低权限进程（必要时独立账户/ACL 与单独 IPC 代理），而不是按本草案把 subagent 放在同一进程的 Worker thread。无论选择哪一种，用户显式开启、主 agent 协调及只读工具接口仍可沿用。
