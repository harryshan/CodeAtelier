# 性能时间线

在对话的“统计”中下载 trace，再用 Perfetto 打开。只有一个简洁版本，轨道和事件都用英文名称，不需要选模式或配置过滤器。

## 怎么看

| Track | 内容 |
| --- | --- |
| `Task` | 整个任务的时间范围 |
| `Model` | 模型请求，区分主任务、标题、摘要与审批用途 |
| `Tools` | `Read file`、`Edit files`、`Run command` 等工具调用 |
| `Waiting` | 排队、依赖、审批与重试退避 |
| `Context` | 准备输入、构建请求、压缩上下文 |
| `Storage` | 保存工具结果和较慢的数据库操作 |
| `Runtime` | Sandbox 启动与清理阶段 |
| `Issues` | 其他内部步骤的失败、取消或未知结果 |

先找最长的片段，再点击查看状态、原操作名、callId/requestId、模型及轮次。异常名称带 `[error]`、`[cancelled]` 或 `[unknown]`，不会因为时间短而隐藏。

Responses 主/子请求还可比较 `promptCacheKeyHash`（所发缓存 key 的 SHA-256 指纹）、`subagentId` 和 `cachedInputTokens`（服务实报缓存输入 tokens）。同一分组的指纹应稳定；缺少 usage 时不补零。这些字段随已有模型开始/终态和耗时保存，不记录 key 原文，也不证明服务采用了该 key 或命中某一实例。

同一进程、同一类别的串行操作复用一行；重叠时才出现 `Tools 2` 等附加行，不按操作名或调用 ID 建轨道。Broker 与 Agent Runtime 分开。行是逻辑分类，不是 CPU 线程；片段是墙钟时间，重叠耗时不能相加。

正常 SQL、JSON 编解码、IPC 帧、读取子步骤、资源采样与因果连线不出现在下载中。等待、数据库往返、模型能力查询和环境步骤小于 10 ms 时省略；主模型、实际工具、上下文、结果保存和异常不按耗时隐藏。下载只留少量定位属性，不带大段工具参数。

## 下载与兼容

- `GET /api/tasks/:id/trace`：已结束任务的简洁时间线。
- `GET /api/tasks/:id/trace/live`：运行中快照或上次检查点，同样简洁，保留 `partial` 和 `no-store`。
- 沿用原入口和本机认证，不提供详细版切换。任务或对应文件不存在时返回 404。
- 新旧文件读取时统一整理，支持异步 b/e 和旧 X、B/E。缺少配对结束时只显示 unknown、零时长，不猜结束时间。
- 下载格式为 `CodeAtelier simple trace v1`；底层采集归档仍为 v2，不迁移、不改写历史。

`metadata.hiddenSpans` 表示展示省略，`droppedRecords` 表示采集时容量丢弃，`unpairedSpans` 表示缺失有效结束；三者不要混淆。partial 不表示任务已完成，读取快照也不会结束任务或重放工具。

实现集中在 `src/tracing/simple-view.ts`，只负责读取投影，不改变执行、审批、恢复或 Runtime IPC。完整会话和 Replay Case 仍另行保存。

## 保存与配置

原始归档位于 `traces/<sessionId>/<taskId>.json`，运行中检查点位于 `trace-checkpoints/<sessionId>/<taskId>.json`。提交时尝试保存初始检查点，之后默认每 30 秒更新；终态成功归档后删除检查点并释放内存。强杀或磁盘失败不保证有完整记录，检查点不参与任务恢复。

在设置页“日志与诊断”调整：

| settings.json 字段 | 默认 | 允许范围 |
| --- | --- | --- |
| `tracing.maxRecords` | 100000 | 100～1000000 |
| `tracing.maxBytes` | 33554432 | 65536～268435456 |
| `tracing.checkpointMs` | 30000 | 5000～3600000 |
| `tracing.retentionDays` | 0 | 0～3650；0 不自动删除 |

记录数和字节数是采集预算，不是进程 RSS 硬上限；超限丢弃新诊断记录，不阻止工具执行。容量下一任务生效，检查点和保留期重启生效。保留期大于 0 时，在成功归档后按 mtime 清理过期普通 JSON，跳过链接和临时文件；缩短保留期须确认，不自动重启或删除当前文件。

## 数据保护与验证

原始归档仍可能包含凭据脱敏后的命令、路径和源码参数，必须作为敏感本机文件保护，不上传或提交。简洁下载虽然排除了工具参数，仍含任务标识和诊断信息，不等于可公开的匿名数据。脱敏不保证识别任意未标记秘密。

底层采集继续保留请求关联、首流/首文本、等待与进程清理、Worker 阶段和每五秒 Broker 资源采样；同进程采样不是各任务的独立资源占用。取消、直子退出和整个进程树清理是不同事实，unknown 不能推导为成功。

采集架构见 [架构说明](architecture.md#性能追踪)，覆盖范围见 [测试清单](testing.md#perfetto-tracing) 与 [验证记录](verification.md)。本次展示调整不要求 Repair；开发测试不代表真实模型、固定账户或全平台实机验证。
