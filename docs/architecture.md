# 架构

初版为单进程本机后端、浏览器单页应用、单个同时运行的任务。核心机制自行实现，没有引入 agent 编排框架。

## 模块与数据流

```text
web (React)
  → HTTP 操作 / SSE 变更通知
server (Fastify)
  → agent/engine
      → providers/responses (官方 OpenAI SDK)
      → tools/registry → permissions/approvals
      → sessions/store (SQLite)
  → logging (Pino)
```

- `src/shared` 仅存浏览器和后端共享的数据契约，前端不能导入文件、进程或密钥实现。
- `src/agent` 管理单任务锁、模型循环、停止条件、工具结果回传。上下文预算目前在循环中判断，尚无单独 context 模块。
- `src/providers` 将 Responses 输出映射为输出项和文本。自建服务需同时收集 output_item.done；completed.output 有内容时优先使用，不能只依赖 completed。
- `src/tools` 定义 Zod 参数及对应 JSON Schema，提供目录、读取、搜索、写入、精确编辑和命令工具。
- `src/permissions` 在后端等待用户批准，取消会释放待审批 Promise。模型无法自行同意审批。
- `src/sessions` 保存 sessions、tasks、events、context，启动时将 running/waiting 任务标为 interrupted。
- `src/config` 管理非敏感设置、内存密钥和平台数据目录。
- `src/logging` 输出结构化 JSON，按级别筛选、脱敏并轮转文件。

## 一次任务

1. Web UI 创建绑定真实工作目录的会话，然后提交用户文本。
2. 后端拒绝同时启动第二个任务，记录用户消息，加载本地上下文与根 AGENTS.md。
3. 模型请求包含当前指令、上下文与工具定义，接收文本及完整输出项。
4. 自研循环检查工具参数和权限，执行工具，记录工具事件与 diff，再将 function_call_output 回传模型。
5. 没有工具调用且收到完成文本时任务结束；超时、取消、失败或超过步骤上限时明确停止。
6. 前端通过 SSE 得知状态变化，重新读取带事件 ID 的快照；重新连接只读状态，不会再次启动任务。

## 历史与恢复

上下文完整存储在本机；不依赖 previous_response_id 或服务端持久化。中断后旧对话可继续提问。先用已持久化工具结果修补缺失输出；没有记录的调用补充“执行结果未知”，不重放它。新任务必须重新读取文件。模型请求由 providers/recovery 实施有界重试；人工恢复创建带来源记录的新任务，仅允许恢复会话最后一个失败、取消或中断任务。任务创建与用户消息、工具结果与上下文分别以 SQLite 事务保存。详情见 [恢复机制](recovery.md)。

UI 历史包含消息、工具调用、受限工具结果和修改 diff。长内容带截断提示，历史不是无限容量的终端录制。

## 文件和命令边界

文件操作解析真实路径，考虑符号链接与 Windows junction；工作区外或敏感路径询问用户。现存文件须先读取，精确修改时比对内容哈希，拒绝覆盖外部并发修改。完整覆盖现有文件另行审批；临时文件写入后重命名并保留原文件模式。

命令使用参数数组和 shell:false，显式 shell 也必须审批。对少量固定验证命令允许会话授权；绑定参数、cwd 及受限扫描得到的项目内容指纹。超大项目无法计算指纹时退回单次审批。此机制不等同于系统隔离；命令的实际副作用由获准程序决定。

## 本机 HTTP 边界

服务仅监听 127.0.0.1。校验 Host/Origin，使用 HttpOnly、SameSite=Strict cookie 及写请求 token，不开放任意来源 CORS。启动时重新生成本机会话 token。设置接口不返回 API key；浏览器提交密钥后不持久化它。
