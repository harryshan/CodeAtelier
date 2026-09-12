# CodeAtelier 技术与权限方案

日期：2026-09-07。状态：用户已授权按推荐方向实现。本文保留选型依据，实际实现与偏差见 development.md 和 verification.md。

## 已确认的模型服务

使用用户自建的 Responses API server，预留其他提供商接口。端点与完整模型标识通过本地 .env 配置；SDK baseURL 使用 /v1 地址，避免重复拼接 /responses。已使用配置的完整模型标识验证工具往返。用户已提供 API key，其值不记录在文档或 Git 中，接入时通过后端本地配置提供；已验证 Bearer 认证与流式工具往返。

建议使用 OpenAI 官方 TypeScript SDK，通过自定义 baseURL 接入。先验证文本流式输出、工具调用参数、call_id 与 function_call_output 回传、完成/失败事件、取消和错误响应。具体兼容性以自建服务实测为准。

上下文由本地管理，不默认依赖 previous_response_id 或服务端历史保存。应保留协议要求的输出项用于后续输入，不只拼接可见文本；可选参数和服务端存储行为经兼容性验证后启用。不在缺少接口资料时猜测 URL 或请求真实服务。

## 推荐技术栈

| 部分 | 推荐 | 理由 |
| --- | --- | --- |
| 运行时 | Node.js 24 LTS、TypeScript strict、pnpm | 跨平台、安装路径简单；使用锁文件固定依赖 |
| 前端 | React + Vite + CSS Modules | 本地单页界面，按职责拆分组件，不需要 SSR |
| 后端 | Fastify | 承担 HTTP、输入校验、静态资源和事件传输，不参与 agent 编排 |
| 通信 | HTTP 请求 + SSE | 请求用于创建/取消/审批，SSE 展示流式输出与工具状态 |
| 持久化 | SQLite + 手写 SQL 与迁移 | 保存会话、消息、工具事件和任务状态，不引入 ORM；驱动在锁定运行时后验证选择 |
| 日志 | Pino + 开发时格式化显示 | JSON 结构化日志、分级和关联字段，统一入口 |
| 测试 | Vitest + Playwright | 核心行为测试与 Web UI 验收；Playwright 仅用于开发测试，不作为产品工具 |
| 工程 | 单包仓库、ESLint、Prettier | 先保持简单，不引入 monorepo 管理工具 |

核心 agent 循环、上下文策略、工具调度和权限判断自研。上述库为通用基础设施，使用它们不改变 from scratch 的核心边界。

生产启动由单个本机后端提供前端静态资源和 API，开发期 Vite 代理 API。SSE 断线重连只订阅事件，不触发任务重新执行；用事件序号避免 UI 重复展示。

## 推荐权限默认规则

| 操作 | 默认行为 |
| --- | --- |
| 工作区内普通文本读取、搜索、新建及精确修改 | 自动允许，路径和文件类型检查通过后执行 |
| 工作区外读取 | 询问，可对明确的额外目录授予会话内只读权限 |
| 删除文件/目录、覆盖大批文件、工作区外写入 | 每次显示具体影响并确认 |
| 读取凭据文件，修改 .git、权限策略或项目 AGENTS.md | 作为敏感操作单独确认，不跟随普通文件规则自动允许 |
| 构建、测试、lint 等项目命令 | 首次确认，可授权当前会话内同一具体命令重复执行 |
| 安装依赖、联网脚本、任意 shell 命令、命令串联/重定向 | 每次确认，不按命令前缀宽泛放行 |
| 产品自动 commit/push/PR、提权、破坏性系统操作 | 初版不提供对应自动能力 |

项目命令本质上可执行任意代码，不能仅因名称是 test/build 就认定安全。会话授权绑定可执行文件、参数、工作目录和有关脚本/配置版本；脚本或配置变化后重新确认。默认用参数数组启动进程，确需 shell 的请求明确展示 shell 与完整命令。

审批在后端暂停具体操作，拒绝或取消后不执行；关闭页面不会跳过审批。检查规范化真实路径、符号链接/junction 和新文件父目录，避免工具路径越界。命令授权并不是操作系统沙箱，获准命令仍以本机用户权限执行；此初版适用于用户信任的本地项目。

UI/API 仅回环监听，校验 Host/Origin 和本机会话凭据，不开放任意来源 CORS；前端不接触模型密钥。配置好的模型请求是产品必要出站流量，不逐次弹窗。

## 存储、限制和交付建议

- 数据存入平台用户数据目录下的 CodeAtelier 子目录，支持配置覆盖；SQLite 保存历史，非敏感设置用 JSON，日志单独存放，不放入所操作的代码仓库。
- 初版 API key 通过后端环境变量或 UI 输入后仅驻留后端内存；不写浏览器 localStorage 或普通配置文件。若需要重启后保存密钥，再选择系统凭据库。
- 默认 30 次模型调用/任务、单命令超时 120 秒、模型流空闲超时 60 秒和单请求总超时 300 秒，均可配置；到限暂停或终止并说明原因，不无限重试。
- 工具结果送入模型的默认上限 32 KiB/次，明确标记截断；完整输出仅在受控大小内存储。上下文预算按实际模型配置，不凭模型名称猜容量；到限明确提示，不静默丢弃关键历史。
- 默认 INFO；日志文件按 10 MiB 轮转、最多保留 5 份。调试等级仍脱敏限长，工具历史与诊断日志分别管理。
- 文档中文优先，代码标识符与 commit 使用英文。短功能分支开发，通过相关检查后合入 main；按已有约定间隔批量 push。PR 用于较大的改动，初版不强制每项变更都建 PR。
- 先从源码安装运行，提供 pnpm 安装/构建/启动指引，暂不做安装包。建议验收 Windows 11、受 Node.js 24 支持的 macOS、Ubuntu 24.04；CPU 架构与精确系统最低版本在 CI 和依赖选定后明确。
- 浏览器目标为发布时稳定版 Chrome、Edge、Firefox、Safari；CI 使用 Chromium/Firefox/WebKit，Safari 仍需真实 macOS 冒烟验证，不把 WebKit 测试等同于 Safari 全覆盖。
- 仓库保持私有，公开分发前再确定许可证。

## 官方资料

- [Node.js 发布计划](https://github.com/nodejs/Release)
- [React 从零创建应用](https://react.dev/learn/build-a-react-app-from-scratch)
- [Fastify 日志](https://fastify.dev/docs/latest/Reference/Logging/)
- [SQLite 应用文件格式](https://www.sqlite.org/appfileformat.html)
- [Responses 流式事件](https://platform.openai.com/docs/api-reference/responses-streaming/response/content_part)
- [Playwright 浏览器验证](https://playwright.dev/docs/browsers)
