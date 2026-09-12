# 开发、配置与排错

## 环境与命令

Node.js 24，pnpm 11.22.0（packageManager 固定）。提交 pnpm-lock.yaml，使用 pnpm install --frozen-lockfile 重现依赖。esbuild 的安装脚本在 pnpm-workspace.yaml 中明确允许。

| 命令 | 用途 |
| --- | --- |
| pnpm dev | 后端源码监听，4142 端口 |
| pnpm dev:web | Vite 前端，5173 端口 |
| pnpm build | 编译后端和前端 |
| pnpm start | 运行构建后的本机服务 |
| pnpm typecheck / lint / test | 类型、静态规则、核心测试 |
| pnpm check | 类型、lint、核心测试、生产构建 |
| pnpm test:e2e | 启动独立模拟服务并验证浏览器交互 |
| node --env-file=.env --import tsx scripts/probe-model-capabilities.ts | 检查模型窗口、计数接口及真实 usage（少量模型调用） |
| pnpm exec tsx scripts/probe-responses.ts | 使用环境变量密钥测试真实服务工具往返 |
| pnpm exec tsx scripts/smoke-agent.ts | 在 .local 下创建隔离项目，真实模型修复并运行测试 |

脚本只接受环境变量密钥，不内置真实凭据；真实验证会消耗配置服务的模型额度。smoke-agent 只自动批准它自己创建的示例项目内固定 node --test 命令。

## 配置

后端启动时读取可选的 .env。推荐通过 Web UI 输入密钥或使用环境变量；本地 .env 仅供开发使用，不提交 Git。

| 环境变量 | 默认 / 用途 |
| --- | --- |
| CODEATELIER_BASE_URL | http://jp.harryshan.com:4141/v1 |
| CODEATELIER_MODEL | codex/gpt-5.6-luna |
| CODEATELIER_REASONING_EFFORT | high；可选 low、medium、high |
| CODEATELIER_API_KEY | 无默认值 |
| CODEATELIER_DATA_DIR | 平台用户数据目录 |
| CODEATELIER_PORT | 4142 |
| CODEATELIER_LOG_LEVEL | info |

非敏感设置保存为 settings.json。已保存设置优先于环境变量默认值；通过 UI 修改。密钥始终来自环境或当前进程内存，不写 settings.json。任务运行时禁止修改配置。

思考等级在“模型与设置”中选择，保存为 reasoningEffort，每次 Responses 请求显式发送 reasoning.effort，主任务和上下文摘要共用。默认 high，旧配置缺少字段时采用环境默认值或 high。例如 .env 中设置 CODEATELIER_REASONING_EFFORT=high；已保存设置优先，保存后用于后续调用。服务或模型不支持所选等级时按现有错误流程报告，不静默降级。

默认限制：30 次模型调用、命令 120 秒、模型请求总计 300 秒、流空闲 60 秒、上下文 180000 字符、单工具输出 32000 字符。这是可配置字符预算，不是精确 token 计量。发现服务容量和支持的 tokenizer 后改用 token 预算，contextChars 仅备用；maxOutputTokens 默认 16384。输入预算扣除输出与安全余量后，达到 80% 时尝试压缩至 60% 以内。失败保留原历史，超过硬上限则停止。实测值和用量展示见 [model-tokens.md](model-tokens.md)。详见 [上下文管理](context-management.md)。高级字段可在停机时编辑 settings.json 或通过设置 API 更新。

## 数据与日志

- Windows：%LOCALAPPDATA%/CodeAtelier
- macOS：~/Library/Application Support/CodeAtelier
- Linux：$XDG_DATA_HOME/CodeAtelier，未设置则 ~/.local/share/CodeAtelier

目录包含 history.sqlite（及 SQLite WAL 文件）、settings.json、logs/app.log。历史会话与运行日志分开保存，不写入用户代码项目。

日志支持 trace/debug/info/warn/error，默认 info。每条带时间、模块和事件；任务日志带 sessionId/taskId，工具日志包含 toolCallId、耗时和成功状态。日志按约 10 MiB 轮转，共最多 5 个文件。DEBUG 可查看模型步骤；不将完整源码、提示词或原始响应作为常规诊断日志输出。已知密钥和认证信息脱敏。

## 权限交互

普通工作区文件操作自动执行。工作区外访问、敏感文件、修改 AGENTS.md、完整覆盖已有文件需确认；直接修改 .git 被拒绝。外部读取当前采用逐次确认，尚未提供额外只读目录授权管理界面。

命令均首次确认；简单 pnpm/npm 的 test/build/lint/typecheck 或 node --test 在可计算项目指纹时可授予本次会话重复执行。复杂 shell 不支持会话放行。Windows 的 pnpm.cmd 应显式通过 cmd.exe 调用，因此按单次审批处理。没有系统沙箱、回滚、提权工具或自动 Git 写操作。请只操作可信项目。

## 常见问题

- 5.6-luna 返回“不支持 Responses”：服务公布的完整标识是 codex/gpt-5.6-luna；设置页会规范化该简称。
- 请求结束但无结果：检查服务是否发送完成事件。适配器支持从 output_item.done 收集结果。
- 找不到 pnpm 命令：Windows 命令脚本应显式使用 cmd.exe /d /s /c；UI 会展示完整请求。
- 文件已变化：重新读取后再编辑；不要关闭并发修改检测。
- 刷新后需要重新认证：服务重启会轮换本机会话 token，刷新页面。
- 任务中断：在会话底部点击“恢复任务”，可先填写恢复说明。密钥或模型配置错误先到设置修正，超时可调整模型请求/空闲超时。模型自动重试记录 model.retry（含步骤、尝试次数、错误分类、HTTP 状态、等待时间）；耗尽后保留失败状态。详见 [恢复机制](recovery.md)。
- 数据目录不可写：先检查该目录所有权和 ACL，或使用 CODEATELIER_DATA_DIR 指定可写目录；不要扩大系统目录权限。
- 端口占用：用 CODEATELIER_PORT 指定其他端口；开发时也同步修改 Vite 代理地址。

## 贡献流程

按职责划分文件，保持 strict 类型检查；协议边界的动态结构应由 schema 验证。变更前读 AGENTS.md 与需求文档。核心行为修改添加对应行为测试，纯文档不写形式化测试。每个独立可验证增量创建 commit，同步更新文档；隔一段时间批量 push。

CI 使用 GitHub 托管的 Windows、Linux、macOS runner 执行 pnpm check，Linux Chromium 执行 UI 验收。测试不需要真实 API key；真实服务 smoke 手动运行。

## 开发中的测试要求

所有功能开发必须配套合理的单元/回归测试。每个可验证增量后运行相关测试，修复缺陷先复现再修正，提交前运行 pnpm check；涉及 UI、API 或 SSE 的变更还需 pnpm test:e2e。测试分层、运行命令、功能覆盖与限制见 [testing.md](testing.md)。

## 服务退出

Web 侧栏的“关闭服务”需确认。`POST /api/server/shutdown` 接受 `{ "confirm": true }`，沿用 cookie/token 校验。关闭期间拒绝新业务请求，先停止模型/命令并记录任务中断，响应确认后关闭 SSE、HTTP 和 SQLite。请求方提前断开时仍继续清理。生命周期关闭操作幂等；日志事件为 server.stopping/server.stopped，异常为 server.shutdown_failed。

`Ctrl+C`、SIGTERM 调用同一个 shutdown。开发模式还需退出 tsx watch 监视器时，在启动终端按 Ctrl+C。

## 代码阅读与审核

可读性是长期交付要求，见 [code-style.md](code-style.md)。运行 `pnpm format` 统一格式，`pnpm format:check` 只检查不修改。`pnpm check` 已包含格式检查；源码、测试、脚本和根目录工具配置一并检查。段落、命名与关键原因注释仍需要人工审核。

## 自举开发验证

`pnpm exec tsx scripts/bootstrap-agent.ts --prepare-only` 只准备隔离源码副本并复现缺陷；移除该参数后使用环境变量密钥执行真实模型任务。数据发送范围、审批限制和证据判定见 [bootstrap.md](bootstrap.md)。

结构化事件、工具结果和日志先解析 JSON，对字段值脱敏后重新序列化；不直接用正则替换 JSON 转义文本。纯文本诊断仍通过统一脱敏函数处理。
