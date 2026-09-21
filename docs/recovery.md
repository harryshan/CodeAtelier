# 错误与任务恢复

## 操作方式

模型网络异常、请求/空闲超时、HTTP 408/409/429/5xx、流式响应缺失完成事件或空响应会自动重试，最多额外两次。等待采用约 1 秒、2 秒的指数退避与抖动，参考 Retry-After，单次等待最多 30 秒。每次尝试使用独立超时；重试不占新的工具循环步骤，最坏每步三次模型请求。首条会话标题没有工具或文件副作用；对可重试或未提供 HTTP 状态、协议错误码的模型调用错误，在首次失败后最多额外重试 3 次。可能产生多次模型服务计费。

认证、参数、模型配置、明确的输出限制等错误停止自动重试；修正原因后可人工恢复。模型服务只提取协议错误对象的实际 message/reason/code（脱敏且最多 1200 个字符），与错误分类、HTTP 状态和脱敏请求标识一起保存、展示和记录日志；不保存任意服务端错误正文、完整响应或提示词。命令启动失败保留子进程实际错误，非零退出码的 stderr 保留在命令输出中。

失败、用户取消、服务关闭或进程崩溃后，打开原会话，在底部点击 **恢复任务**。可先在输入框补充说明。恢复创建新任务并保存来源关系，保留原失败记录和已有对话。只能恢复会话最后一个未成功任务，避免从旧状态分叉；较早任务通过当前会话继续提问。恢复任务也遵循全局并发与工作目录互斥，可能先显示 queued；恢复前可修改设置；上下文接近上限时先自动压缩；无法安全压缩时需调整容量或另开会话，恢复不自动清空历史。压缩快照与活动上下文原子保存，取消或失败保留旧上下文，详见 [context-management.md](context-management.md)。

主动取消立即取消请求或退避等待，不自动继续。后端重启不会自行执行任务；重新配置内存密钥（或使用环境变量）后人工恢复。浏览器重连可重新获取本机会话凭据，不会重复提交已被服务器接受的操作。

当前 `run_command` 已将命令级 execution instance ID、实际模式、PID/类型与 completed/cancelled/unknown 追加到 session。若进程已启动但工具结果未落盘，下次模型请求会收到该实例的安全摘要和 `replayAllowed:false`；不携带命令、路径或输出原文。

后续专用用户 Sandbox 保持同一产品语义：取消只终止目标 execution instance，不回滚已经发生的工作区或 Git 副作用，也不影响其它健康并发任务；确认终止和本实例 lease 清理记为 `cancelled`，无法确认进程、代理或 ACL 清理记为 `unknown`/`orphaned`。目标记录使用统一 `executionInstance`，包含 `mode: windows-sandbox-user | host-process`、`instanceId`、可空 `pid`、`createdAt`；Sandbox 模式另保存 `kind: agent-runtime | push-runner`，并二选一关联 `agentRuntimeInstanceId` 或 `pushRunnerInstanceId`，同时保存专用账户 generation/SID、capability SID 和 lease epoch 摘要。另保存执行是否开始、取消与终止时间、受限部分输出、`sideEffects: may_have_occurred` 和 `replayAllowed: false`。正常 Push Runner 结果返回仍在同步等待的原 Agent Runtime，但恢复不能把 Push Runner 自身当作 Agent Runtime。任一实例进入 orphaned 时冻结新 Sandbox 任务并排空该 account generation 的其它活动实例，对账完成前不得启动替代任务；非 Sandbox 模式不伪造专用账户字段。当前 `run_command` 已将命令级 instance ID、实际模式、PID/类型与 completed/cancelled/unknown 追加到 session；专用账户 generation、Job/lease/ACL 对账和重启后复证仍未实现。完整身份和进程边界见 [windows-integrity-sandbox.md](windows-integrity-sandbox.md)。

## 各中断阶段

| 阶段                                     | 恢复行为                                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 模型请求前/连接中/接收部分文本或工具参数 | 瞬态故障重试同一步；部分输出只留历史，不加入模型上下文，不执行部分工具调用                                                         |
| 模型完整回复已保存，尚未执行工具         | 调用图先整体校验后才执行；人工恢复时把每个未有 function_call_output 的节点标为状态未知，要求先检查现场                             |
| 等待审批                                 | 取消/关闭释放等待；恢复后模型可重新提出操作，继续按权限规则审批                                                                    |
| 文件、命令或其他 DAG 节点执行中          | 不自动重放原工具。已完成或已阻断的节点结果继续使用；没有完整结果的节点明确标注未知，先核实文件或进程状态                           |
| 工具已完成但上下文未写入                 | 兼容旧记录：从工具结果事件补齐；新记录将结果事件和上下文放在同一事务                                                               |
| 模型重试耗尽、步数上限、配置错误         | 保存失败状态，人工修正原因并恢复；新任务获得新的步数预算                                                                           |
| 排队中                                   | 用户可取消，记录 cancelled；服务关闭、重载或进程重启则标记 interrupted。队列不自动恢复执行，人工恢复时重新进入调度并遵守同目录互斥 |
| 后端关闭/崩溃                            | queued/running/waiting 任务标记 interrupted，人工恢复；不自动重启后端、不假设原命令已退出                                          |

文件系统副作用和 SQLite 无法组成同一事务：例如文件重命名后立即断电，结果可能未保存。这种情况不能保证恰好执行一次，必须检查现场。硬崩溃后子进程可能仍然运行，恢复说明会要求检查；应用未提供操作系统级隔离或进程接管。

## 实现与验证

- `src/providers/model-error.ts`：错误归一化与可重试分类；`src/providers/retry.ts`：有限退避与取消。
- `src/providers/responses-provider.ts`：独立请求/空闲超时、终结事件检查、SDK 错误归一化。SDK 自带重试关闭，避免多层叠加。
- `src/agent/engine.ts`：每步模型重试、恢复来源、持久化故障兜底；`src/agent/context.ts`：缺失工具结果修补和新任务上下文保存。
- `POST /api/tasks/:id/resume`：请求体 `{ "instruction": "可选恢复说明" }`；沿用本机身份与写请求 token 校验。
- 重试流式文本按 taskId/step/attempt 分开显示；失败尝试保留为未完成回复，不与成功回复拼接。
- 故障注入测试见 `tests/recovery.test.ts`，UI 恢复入口见 `tests/e2e/app.spec.ts`。使用可控服务制造断流和超时，无需真实 API key。

## 统一文件编辑

唯一的 `edit_files` 工具逐文件校验并写入；单文件调用同样按此流程处理。create:true 仅允许新建不存在的文件，并在预检及写入前复核存在性；create:false 必须使用已读取的原始快照精确编辑，成功编辑后会作废该文件的任务内读取凭证，继续修改前必须重新读取。单个文件的审批拒绝、快照/存在性校验或写入故障不会取消其他独立条目，最终错误一次列出所有失败或结果未知的路径及实际错误。`edit_progress` 以 batchId 和 callId 关联记录，预检失败记 failed，写入前记 unknown、成功后记 written；因取消或历史持久化故障未开始的文件为 not_attempted。UI 合并展示各文件最新状态和错误。取消、写入故障或崩溃可能留下部分完成，已写文件不回滚。整次工具结果未保存时，恢复仍将该调用标为未知，不把进度记录当作完整成功结果；先重新读取现场，不自动重放整个批次。文件重命名与进度事件不能组成同一事务，因此不能保证断电时最后一个文件的结果已记录。
