# CodeAtelier 技术与权限方案

本文说明已采用技术的选型依据。当前行为以 [架构](architecture.md)、[开发说明](development.md) 和 [验证记录](verification.md) 为准；历次方案及替代关系保留在 [决策记录](decisions.md)。

## 已确认的模型服务

使用用户自建的 Responses API server，预留其他提供商接口。端点与完整模型标识通过本地 .env 配置；SDK baseURL 使用 /v1 地址，避免重复拼接 /responses。已使用配置的完整模型标识验证工具往返。用户已提供 API key，其值不记录在文档或 Git 中，接入时通过后端本地配置提供；已验证 Bearer 认证与流式工具往返。

使用 OpenAI 官方 TypeScript SDK，通过自定义 baseURL 接入。适配器处理流式输出、工具往返、完成/失败、取消和错误响应；具体兼容性以自建服务实测为准。

上下文由本地管理，不默认依赖 previous_response_id 或服务端历史保存。应保留协议要求的输出项用于后续输入，不只拼接可见文本；可选参数和服务端存储行为经兼容性验证后启用。不在缺少接口资料时猜测 URL 或请求真实服务。

## 已采用技术栈

| 部分 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | Node.js 24/26、TypeScript strict、pnpm | 跨平台、安装路径简单；使用锁文件固定依赖 |
| 前端 | React + Vite + CSS Modules | 本地单页界面，按职责拆分组件，不需要 SSR |
| 后端 | Fastify | 承担 HTTP、输入校验、静态资源和事件传输，不参与 agent 编排 |
| 通信 | HTTP 请求 + SSE | 请求用于创建/取消/审批，SSE 展示流式输出与工具状态 |
| 持久化 | Node 内置 SQLite + 手写 SQL 与迁移 | 保存会话、消息、工具事件和任务状态，不引入 ORM |
| 日志 | Pino + 格式化纯文本输出 | 内部字段脱敏、分级和关联字段，统一入口；文件与终端不输出 JSON |
| 测试 | Vitest + Playwright | 核心行为测试与 Web UI 验收；Playwright 仅用于开发测试，不作为产品工具 |
| 工程 | 单包仓库、ESLint、Prettier | 先保持简单，不引入 monorepo 管理工具 |

核心 agent 循环、上下文策略、工具调度和权限判断自研。上述库为通用基础设施，使用它们不改变 from scratch 的核心边界。

生产启动由单个本机后端提供前端静态资源和 API，开发期 Vite 代理 API。可选访问密码门禁由后端 API 验证，前端构建产物仅包含输入表单，不包含密码或环境值。SSE 断线重连只订阅事件，不触发任务重新执行；用事件序号避免 UI 重复展示。

## 权限机制的选择

文件路径校验、命令审批与 OS 隔离分别承担不同职责：

- 文件工具核对真实路径、敏感文件与读取版本；`edit_files` 不覆盖并发变化的文件。
- 宿主命令在执行前按策略审批，辅助模型可以通过、拒绝或转人工；获准命令仍具有宿主用户权限。
- 产品 Git 使用受限 action 和固定参数，允许合规的暂存、提交和 upstream 推送；不开放任意 Git 参数或强推。
- Windows Sandbox 使用专用账户、restricted token、ACL/WFP 和独立 Runner。该预览仍待提升环境完整验收，不能视为跨平台安全保证。

具体权限规则集中维护在 [开发说明](development.md#权限交互)；Sandbox 边界见 [架构专题](windows-integrity-sandbox.md)。

HTTP/SSE 使用本机服务与浏览器会话校验，默认只监听回环地址；局域网开放和可选共享密码门禁均须显式配置。它们不构成公网服务或多用户权限系统。

## 存储、限制和交付建议

- 数据存入平台用户数据目录下的 CodeAtelier 子目录，支持配置覆盖；SQLite 保存历史，非敏感设置用 JSON，日志单独存放，不放入所操作的代码仓库。
- 初版 API key 通过后端环境变量或 UI 输入后仅驻留后端内存；访问密码同样只保留服务端环境，并仅以 HttpOnly cookie 记录当前验证状态；两者均不写浏览器 localStorage 或普通配置文件。若需要重启后保存密钥，再选择系统凭据库。
- 默认 100 次模型调用/任务、单命令超时 120 秒、模型流空闲超时 60 秒和单请求总超时 300 秒，均可配置；到限暂停或终止并说明原因，不无限重试。
- 工具结果送入模型的默认上限 32000 字符/次，明确标记截断；完整输出仅在受控大小内存储。上下文预算按实际模型配置，不凭模型名称猜容量；到限明确提示，不静默丢弃关键历史。
- 默认 INFO；日志文件按 10 MiB 轮转、最多保留 5 份。格式化行省略固定进程噪声，错误保留脱敏限长的消息、受控元数据、原因链和堆栈；工具历史与诊断日志分别管理。
- 文档中文优先，代码标识符与 commit 使用英文。短功能分支开发，通过相关检查后合入 main；按已有约定间隔批量 push。PR 用于较大的改动，初版不强制每项变更都建 PR。
- 先从源码安装运行，提供 pnpm 安装/构建/启动指引，暂不做安装包。建议验收 Windows 11、受所选 Node.js 24/26 版本支持的 macOS、Ubuntu 24.04；CPU 架构与精确系统最低版本在 CI 和依赖选定后明确。
- 浏览器目标为发布时稳定版 Chrome、Edge、Firefox、Safari；CI 使用 Chromium/Firefox/WebKit，Safari 仍需真实 macOS 冒烟验证，不把 WebKit 测试等同于 Safari 全覆盖。
- 仓库保持私有，公开分发前再确定许可证。

## 官方资料

- [Node.js 发布计划](https://github.com/nodejs/Release)
- [React 从零创建应用](https://react.dev/learn/build-a-react-app-from-scratch)
- [Fastify 日志](https://fastify.dev/docs/latest/Reference/Logging/)
- [SQLite 应用文件格式](https://www.sqlite.org/appfileformat.html)
- [Responses 流式事件](https://platform.openai.com/docs/api-reference/responses-streaming/response/content_part)
- [Playwright 浏览器验证](https://playwright.dev/docs/browsers)
