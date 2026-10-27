# 模型协议与配置

CodeAtelier 支持 `responses`（默认）、`chat-completions` 和 `messages`。协议与模型品牌分开配置：服务必须实现所选协议的流式响应和客户端工具调用。第一批新增协议仅验证本机模拟服务，不承诺所有“兼容”服务或模型均可用。

## 配置

在设置页的“模型连接”选择协议并保存，下一任务生效。下面是 `settings.json` 中 `models.main` 的非秘密字段示意；密钥通过 UI 替换控件提交，不要把示例当作完整配置文件。值均为占位，须替换为实际服务信息。Base URL 应包含服务要求的版本路径（通常 `/v1`），不要包含具体调用端点；配置兼容去除末尾 `/responses`、`/chat/completions` 或 `/messages`。

```json
{
  "protocol": "chat-completions",
  "baseUrl": "https://api.example.com/v1",
  "model": "YOUR_MODEL_ID",
  "reasoningEffort": "high"
}
```

使用 Messages 时，将协议改为 `messages`，地址、模型和密钥也换成对应服务值。适配器发送 `x-api-key` 和 `anthropic-version: 2023-06-01`；不使用 Bearer。Chat Completions 与 Responses 使用 Bearer。

辅助连接可在同页启用，关闭“继承主模型连接”后选择独立协议、地址、模型并填写辅助密钥。保存配置不会自动连接或产生模型费用。

- 启用继承时，使用主连接。只有同端点、同协议且未显式设置辅助密钥时才共用主密钥；跨端点或协议缺少独立密钥会明确失败，不能把主密钥发给另一个服务。
- 辅助模型为空时，标题、摘要沿用主模型；审批保留人工确认，不使用主模型替代。辅助调用失败仍沿用既有降级/恢复规则。
- 连接及密钥保存在私有 `settings.json`，UI 不回显已有 key，支持保留/替换/删除；改变端点或协议需重新输入或明确删除原密钥。主/辅助密钥均用于日志、会话事件和 Replay 脱敏，不发送到浏览器或 Sandbox Runtime。
- 启动命令不变：`pnpm build`，然后 `pnpm start`。安装式 Windows Sandbox 需同步更新 Runtime IPC v17；按 Windows 使用指南执行重建/Repair，本功能不会自动操作系统安装。

## 当前能力

| 能力 | Responses | Chat Completions | Messages |
| --- | --- | --- | --- |
| 文字流与本地函数工具 | 保留 | 支持 | 支持 |
| 同轮多个工具调用和结果回传 | 保留 | 支持 | 支持 |
| 主任务、辅助模型、审批、长工具复查 | 保留 | 支持 | 支持 |
| 取消、请求/空闲时限、上层有界重试 | 保留 | 支持 | 支持 |
| 服务实报 usage | 保留 | prompt/completion 转换 | 输入含缓存读取/创建，输出取最终累计值 |
| 思考等级 | 沿用 reasoning.effort | 本批不发送，UI 禁用 | 本批不发送，UI 禁用 |
| 原生网页搜索 | 沿用 web_search | 本批不提供 | 本批不提供 |
| 容量与 tokenizer 查询 | 沿用现有服务扩展 | 未知，字符预算 | 未知，字符预算 |

Chat Completions 请求使用 `max_completion_tokens` 和 `stream_options.include_usage`。服务若不支持这些字段或未提供函数调用能力会报错，不自动改参数或切协议。模型专属 `reasoning_content`、旧 `function_call` 等扩展本批不接入。Messages 暂不支持 extended/adaptive thinking、服务端工具、多模态和 pause_turn 续接。输出截断不会当成完整工具调用执行。

无原生搜索时，不向模型声明 `web_search`；模型可以在既有权限内使用已配置的 MCP 或公开 URL 获取方式，不凭空产生搜索结果或引用。

## Responses prompt cache key

Responses 的主任务及 explorer/reviewer 请求自动发送 `prompt_cache_key`，无需设置项。主任务使用会话 ID 派生的稳定 key，跨轮次、重试、续聊及主任务恢复保持一致；每个 subagent 使用会话 ID、任务 ID 和子任务 ID 派生独立 key。恢复后重新规划的子任务属于新任务，使用新的分组。key 为版本化身份元组的 SHA-256 派生值，不包含原始 ID、工作区、提示词或凭据。

宿主及启动前 fallback 在 Engine 绑定，Sandbox 在 Broker 按认证身份绑定；现有 IPC 已提供所需身份，此功能不改变 IPC 版本、不要求单独 Repair。重新构建并重启后端后生效，不热更新当前进程。Chat Completions、Messages，以及标题、压缩、审批和长工具复查不添加该参数。

key 只是提供给服务的缓存分组提示，不保证命中、不固定上游实例，也不是安全隔离或 `previous_response_id`。服务不支持参数时按正常失败路径报告，不静默删除参数重发。未增加缓存保留期；实际缓存改善需在真实服务上比较，不能从模拟测试推出。

Replay 保存实际请求选项；`llm.request` 和简洁 trace 保留 `promptCacheKeyHash`、`cachedInputTokens` 及 `subagentId`，只记录 key 指纹，不记录 key 原文。缺失缓存 usage 保持未知，不补零。

## 历史与执行边界

内部公共契约位于 `src/providers/conversation.ts`，覆盖文字、函数调用和结果；保留历史的 `function_call` / `function_call_output` 字段名，不依赖某一家 SDK 的类型。`ModelProvider` 的 legacy 数组边界仍允许现有 Responses 原始扩展，避免数据库迁移。

新协议的适配器验证调用 ID、完整 JSON 参数和成组结果，不能丢失未完成调用或不透明协议内容。只在正常完成后向 Engine 返回可执行记录；Engine 保存响应、校验整批 DAG 后才执行工具。流中已展示的部分文字不代表执行成功。失败/取消不重放已执行工具。

已有历史不自动改写。新协议可以读取可表达的公共文字/工具历史，但任意跨协议历史切换不作保证：遇到 Responses reasoning、web_search 等无法安全转换的条目会提示使用原协议或新建会话，不静默删除。建议更换协议后新建对话。

本批不增加自动模型 fallback、模型价格查询或 SDK agent 框架。已有权限、恢复与 Sandbox 边界保持不变；跨会话并发按后续 D173 不限主任务数且允许同目录并行。

## 验证与诊断

- `pnpm test tests/model-protocols.test.ts tests/model-protocol-edges.test.ts tests/provider.test.ts tests/config.test.ts --maxWorkers=2`：本机 HTTP/SSE 多工具往返、断流、截断、参数错误、取消/时限、认证和密钥隔离，以及生产 Engine 文件编辑与续聊。
- `pnpm test tests/agent-runtime-engine.test.ts --maxWorkers=2`：独立 Node Runtime 的三协议能力传递；不是固定账户 OS 隔离验收。
- `pnpm test:e2e tests/e2e/model-protocols.spec.ts`：浏览器协议展示和思考参数禁用。
- Perfetto `llm.request` 增加 `protocol`，仍保留关联 ID、完成状态、耗时与首事件；不写提示词、源码、密钥或模型输出。

具体执行结果见 [验证记录](verification.md)。真实提供商、macOS/Linux 实机以及模型专有扩展未验证；没有运行 Evaluation。
