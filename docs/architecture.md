# 架构

初版为单进程本机后端、浏览器单页应用、单个同时运行的任务。核心机制自行实现，没有引入 agent 编排框架。

## 模块与数据流

```text
web (React)
  → HTTP 操作 / SSE 变更通知
server (Fastify)
  → agent/engine
      → providers/model-provider ← providers/responses-provider (官方 OpenAI SDK)
      → tools/tool-runner → tools/registry + permissions/approval-manager
      → sessions/store (SQLite)
  → logging (Pino)
```

- `src/shared` 仅存浏览器和后端共享的数据契约，前端不能导入文件、进程或密钥实现。
- `src/agent/engine.ts` 管理单任务锁、模型循环、停止条件与工具结果回传；`context.ts` 负责上下文恢复，`instructions.ts` 负责根规则与模型指令构建。src/context/ 负责预算、摘要压缩、快照契约与历史原文读取，循环在完整工具批次完成后接入。
- `src/providers` 将 Responses 输出映射为输出项和文本。自建服务需同时收集 output_item.done；completed.output 有内容时优先使用，不能只依赖 completed。
- `src/tools` 定义 Zod 参数及对应 JSON Schema，提供目录、读取、搜索、写入、精确编辑和命令工具。
- `src/permissions` 在后端等待用户批准，取消会释放待审批 Promise。模型无法自行同意审批。
- `src/sessions/store.ts` 保存 sessions、tasks、events、context；初始数据库结构位于 `schema.ts`。启动时将 running/waiting 任务标为 interrupted。
- `src/config` 管理非敏感设置、内存密钥和平台数据目录。
- `src/logging` 输出结构化 JSON，按级别筛选、脱敏并轮转文件。

## 文件职责与定位

| 模块 | 职责 |
| --- | --- |
| tools/registry.ts | 工具参数 schema、描述和模型可见定义 |
| tools/tool-runner.ts | ToolRunner：校验、审批、文件与命令执行 |
| tools/paths.ts / process.ts | 路径边界与进程生命周期 |
| providers/model-provider.ts | 与具体服务无关的模型接口和结果契约 |
| providers/responses-provider.ts | ResponsesProvider：Responses 协议实现 |
| providers/model-error.ts / retry.ts | 错误分类与有界重试策略 |
| config/settings.ts / config.ts / data-directory.ts | 参数 schema、配置持久化、平台数据目录 |
| logging/logger.ts / redact.ts | 日志创建与轮转、纯文本脱敏 |
| permissions/approval-manager.ts | ApprovalManager：授权等待与取消 |
| server/app.ts | 服务组装、业务路由与关闭顺序 |
| server/local-security.ts / session-events.ts | 本机请求防护、SSE 连接管理与清理 |
| server/http-server.ts | 保留 Pino 日志类型的 HTTP 服务类型 |
| web/App.tsx / useSessionConnection.ts | 页面交互与布局、快照和 SSE 重连生命周期 |

本次全库审查将原 registry.ts 中的 ToolRunner 移出；paths.ts 原本就是路径函数模块。Engine、Store 及其上下文/schema 辅助模块、共享数据契约、测试和开发脚本继续按各自职责组织，不为每个小函数增加文件。

## 一次任务

1. Web UI 创建绑定真实工作目录的会话，然后提交用户文本。
2. 后端拒绝同时启动第二个任务，记录用户消息，加载本地上下文与根 AGENTS.md。
3. 模型请求包含当前指令、上下文与工具定义，接收文本及完整输出项。
4. 自研循环检查工具参数和权限，执行工具，记录工具事件与 diff，再将 function_call_output 回传模型。
5. 没有工具调用且收到完成文本时任务结束；超时、取消、失败或超过步骤上限时明确停止。
6. 前端通过 SSE 得知状态变化，重新读取带事件 ID 的快照；重新连接只读状态，不会再次启动任务。

## 历史与恢复

上下文完整存储在本机；不依赖 previous_response_id 或服务端持久化。中断后旧对话可继续提问。先用已持久化工具结果修补缺失输出；没有记录的调用补充“执行结果未知”，不重放它。新任务必须重新读取文件。模型请求由 providers/retry 实施有界重试；人工恢复创建带来源记录的新任务，仅允许恢复会话最后一个失败、取消或中断任务。任务创建与用户消息、工具结果与上下文分别以 SQLite 事务保存。详情见 [恢复机制](recovery.md)。

UI 历史包含消息、工具调用、受限工具结果和修改 diff。长内容带截断提示，历史不是无限容量的终端录制。

## 文件和命令边界

文件操作解析真实路径，考虑符号链接与 Windows junction；工作区外或敏感路径询问用户。现存文件须先读取，精确修改时比对内容哈希，拒绝覆盖外部并发修改。完整覆盖现有文件另行审批；临时文件写入后重命名并保留原文件模式。

命令使用参数数组和 shell:false，显式 shell 也必须审批。对少量固定验证命令允许会话授权；绑定参数、cwd 及受限扫描得到的项目内容指纹。超大项目无法计算指纹时退回单次审批。此机制不等同于系统隔离；命令的实际副作用由获准程序决定。

## 本机 HTTP 边界

服务仅监听 127.0.0.1。校验 Host/Origin，使用 HttpOnly、SameSite=Strict cookie 及写请求 token，不开放任意来源 CORS。启动时重新生成本机会话 token。设置接口不返回 API key；浏览器提交密钥后不持久化它。

模型元数据与实际 usage 由 providers/model-metadata.ts 校验，context/token-budget.ts 计算本地 token 估算和输入预算，UI 区分估算与实报；详见 [model-tokens.md](model-tokens.md)。

上下文压缩的触发、持久化、失败边界与模块职责见 [context-management.md](context-management.md)。活动上下文可为摘要与最近原文的组合；压缩前完整输入另存快照，不删除事件历史。

压缩按读取去重、文件归档、完整分块摘要逐级执行；read-projection.ts 负责确定性的读取投影，ContextManager 负责阶段选择与原子提交。快照记录精确投影以在后续摘要前还原全文，保留已验证来源的旧摘要原文。

## SWE-bench 开发评测

`src/evaluation/` 保留生产 Engine/Store 的无界面入口、预算、审批和执行记录。`scripts/swebench/dataset.py` 校验固定子集并仅生成 issue 提示词；`predict.py` 在官方任务镜像中运行 agent 并提取补丁；`grade.py` 在独立干净环境调用官方评分器；`prepare.py` 打包白名单运行文件。详见 [swebench.md](swebench.md)。

每次主任务模型请求前由 context/mechanical-input.ts 生成无损请求视图，重复只读结果与相同正文采用向前引用。Engine 的估算与 usage 校准使用该视图，持久化和有损压缩继续使用原始输入；此阶段独立于容量阈值。

最终报告由 scripts/swebench/report.py 从运行和官方评分产物聚合；predict.py/grade.py 仅在用户手动运行结束时调用。报告可单独离线重建，分开正确性、效率、过程和数据完整性；不引入模型评分或额外评测运行。

### 辅助模型配置与摘要路由

`config/auxiliary-model.ts` 的 `auxiliarySettings` 为辅助调用创建独立配置副本；Engine 保持主任务提供商不变，并通过 ContextManager 的惰性 `summaryModel` 回调为摘要提供独立模型及预算。后续标题生成或辅助审批可复用配置选择函数，当前未实现这两条模型调用流程，权限规则仍独立执行。

### 项目与对话展示

`src/web/App.tsx` 按服务端保存的真实 `workspace` 路径分组已有会话，展示项目目录、对话数量和独立会话列表。项目内新建入口预填目录，继续使用 `POST /api/sessions` 创建独立记录，不引入新的项目表或跨会话上下文共享。
