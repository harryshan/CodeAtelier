# 性能 trace 的关联、边界与维护

CodeAtelier 在任务提交后建立有界 trace，按任务保存为 Perfetto Trace Event JSON。诊断数据不参与权限、任务恢复或工具重放；完整历史和 Replay Case 另行保存。当前格式为 v2，Runtime IPC 为 v14。

## 怎样定位等待

| 事件 | 含义与关联 |
| --- | --- |
| `task.queue` | 提交至领取，reason 为 workspace、capacity 或 ready；取消排队也有归档 |
| `llm.capabilities` / `llm.request` | 能力查询与模型调用分别计时；请求有独立 requestId、spanId、用途、step/attempt |
| `llm.first_event` / `llm.first_output` | SDK 首个流事件和首文本分别记录，共享所属请求 ID/逻辑轨道；没有该里程碑就不伪造零延迟 |
| `lastEventToCompleteMs` | 最后流事件到 Provider 返回的尾部墙钟时间；不等于服务端推理耗时 |
| `tool.dependency_wait` / `tool.prepare` / `tool.slot_wait` | 依赖、参数及权限准备、执行槽等待；Runtime 状态标 broker-observed，包含上报排队时间 |
| `approval.classify` / `approval.human_wait` / `approval.reused` | 分类、人工决定或取消、已有授权复用；不保存 subject、理由或 grant key |
| `mcp.queue` | 同服务串行等待，使用数字服务索引与 callId；连接和操作延续既有片段 |
| `store.queue` / `store.<operation>` | 主线程排队与 dispatch 到回执；后者的逻辑归属是 Store roundtrip |
| `store.worker.*` | Worker 内 connect、execute、SQL prepare/execute、JSON parse/stringify、transaction acquire/commit/rollback；不是主线程等待的别名 |
| `sandbox.*` | Windows workspace、self_check、prepare_access、manifest、acquire、shared_provision、native_launch、handshake、revoke_access、cleanup；POSIX 延续 MXC 生命周期 |
| `ipc.request` / `ipc.handler` / `ipc.frame` | requestId 关联往返和本地 handler；帧只记录方向、类型、字节数。不能由此计算跨进程单向网络延迟 |
| `process.cancel` / `process.termination` / `process.direct_exit` | stop 至直子 close、终止发送结果与退出；宿主/Broker 和 Runtime 均有对应记录 |
| `session.event_committed` / `session.sse_refresh` / `session.snapshot` | 后端持久化、向已连接 SSE 写 refresh、快照读取；事件 ID/after 游标可关联，不表示浏览器已接收或渲染 |

模型结果按实际 `call_id` 绑定工具，辅助标题、审批或压缩请求不会抢占来源。flow 依次覆盖 `llm_to_tool`、成功的 `tool_dependency`、`tool_to_result`、`result_to_model`。没有已知源片段或结果时不猜关系。每任务关联索引最多 10000 个 callId，超出记录 `tracing.relations_overflow`；诊断缺失不会阻止工具执行。

生命周期使用独立 ID 的异步 b/e；flow 使用同名同分类 n 端点和整数 bind_id。逻辑轨道及 parentSpanId 保留于属性，Perfetto 可按操作重新组织异步轨道。它们不是物理 CPU 调用栈，不应把交叉区间或父子耗时相加。Worker 阶段每次回执最多 256 条，截断数见 roundtrip 的 droppedTimings；replay 编码器内部 JSON 仍包含在其 SQL/execute 包络中，不单列全部内部计算。

取消请求、远端收到取消、handler 返回和进程清理是不同事实。IPC 断连后的未完成请求保持 unknown；process 记录的 treeCleanup 保持 unknown。只有独立 Sandbox 清理账本确认 clean 时，cleanup 才成功；orphaned 不转为成功，也不触发重放。

## 容量、检查点和资源采样

默认每任务最多 100000 条记录、32 MiB 估算保留预算。预算涵盖 span、instant、counter、flow 和属性估算；不等于 V8 实际 RSS 硬上限。超限后丢弃新诊断数据，仍返回可结束的轻量句柄，避免 Runtime 收尾协议被破坏。metadata 提供 droppedRecords、retainedBytesEstimate、maxRecords、maxRetainedBytes 和 exportDurationMs。参数递归遮盖凭据，深度最多 20、每组属性最多 2048 个节点/131072 个输入字符；单字符串超过 65536 字符用截断标记替代。截断属性标为 traceAttributesTruncated。完整输入不再为统计 inputChars 而 JSON.stringify。

有任务时每 5 秒采样 Broker 进程 CPU、RSS、heap、event-loop 最大延迟、活动/排队 trace 数，导出 C counters；同一进程的数值会出现在各任务文件中，不能累加成任务 CPU，也不包括子进程资源。IPC 另有在途计数。短任务可能没有周期采样点。

提交后写初始检查点，之后默认每 30 秒最多一份原子覆盖，路径为 `trace-checkpoints/<sessionId>/<taskId>.json`。检查点显式标记 partial 和 checkpointAt；服务异常结束最多丢失上次成功检查点之后的记录，强杀/磁盘失败不保证有检查点。终态先等待在途检查点，再保存 `traces/<sessionId>/<taskId>.json`，成功才删除检查点，最后释放内存。检查点不用于任务恢复。归档自身序列化及磁盘耗时写 `tracing.archive_written` DEBUG 日志；它发生在导出之后，不伪造写入自身文件的完整 span。

| 环境变量 | 默认 | 允许范围 |
| --- | --- | --- |
| `CODEATELIER_TRACE_MAX_RECORDS` | 100000 | 100～1000000 |
| `CODEATELIER_TRACE_MAX_BYTES` | 33554432 | 65536～268435456 |
| `CODEATELIER_TRACE_CHECKPOINT_MS` | 30000 | 5000～3600000 |
| `CODEATELIER_TRACE_RETENTION_DAYS` | 0 | 0～3650，0 禁用自动删除 |

例如在 `.env` 中配置以下非凭据值，重启后生效：

```dotenv
CODEATELIER_TRACE_MAX_RECORDS=100000
CODEATELIER_TRACE_MAX_BYTES=33554432
CODEATELIER_TRACE_CHECKPOINT_MS=30000
CODEATELIER_TRACE_RETENTION_DAYS=0
```

保留期大于 0 时，成功终态归档后按 mtime 清理 traces 和 trace-checkpoints 中过期的普通 JSON 文件；跳过符号链接和临时文件。默认不删除旧文件，不转换或重新脱敏旧归档。清理失败只警告，不影响产品任务。

## 下载与验证

统计框继续列举实际存在的完整文件。`GET /api/tasks/:id/trace` 只下载终态归档；新增 `GET /api/tasks/:id/trace/live` 在同样的本地认证下返回当前 partial 快照，或重启前留下的 partial 检查点，并设置 no-store。无任务/无相应文件返回 404。运行中快照不结束内存 span，不改变任务状态。

trace 仍可能包含脱敏后的工具命令、路径和源码参数，是敏感本机诊断文件。密钥/认证头/cookie/token 等已识别字段递归遮盖；不能保证识别任意未标记秘密。IPC、审批、模型和 Store 新事件均不记录正文或凭据。

Runtime v14 增加固定 process 阶段和审批 callId 元信息，旧安装需正常重建/Repair；开发测试不自动修复本机安装。测试、真实 Perfetto 合成导入和平台边界见 [测试清单](testing.md#perfetto-tracing) 与 [验证记录](verification.md)。浏览器 JS 渲染计时、所有 SQLite 同步兼容路径的逐语句计时及全平台实机性能不属于本次证据。
