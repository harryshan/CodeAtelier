# CodeAtelier

本机浏览器中的个人 coding agent。TypeScript 实现，自研 agent 循环、上下文和工具调度，通过用户自建 Responses API 服务完成代码阅读、精确修改与验证。

## 快速开始

需要 Node.js 24 和 pnpm 11.22.0。

```sh
pnpm install --frozen-lockfile
# 先复制 .env.example 为 .env，填写实际 API 地址、模型标识和密钥
pnpm build
pnpm start
```

打开 [http://127.0.0.1:4142](http://127.0.0.1:4142)，在「模型与设置」输入 API key，然后新建会话并输入本机项目目录。

API 地址和模型标识没有内置默认值；启动前在本地 .env 中填写 CODEATELIER_BASE_URL 和 CODEATELIER_MODEL。本机访问限制仅针对 UI/API，模型请求会发送到配置的服务。

请复制 `.env.example` 为本地 `.env`，填写实际连接配置及 `CODEATELIER_API_KEY`；该文件被 Git 忽略。不要将密钥写入源码或提交记录。UI 输入的密钥仅保留在后端内存。

## 初版能力

- 多轮会话、流式回复、历史消息与工具结果持久化；任务输入框在每次输入后即时安全渲染 Markdown 预览并保留原文，用户与 agent 消息支持 GitHub Flavored Markdown（标题、列表、表格、任务列表、链接和代码围栏），不执行原始 HTML；首条用户消息会通过低成本辅助模型自动生成会话标题。
- 通过受审批的命令浏览目录和搜索代码；按行读取文件，并以统一的 `edit_files` 批量新建文件或精确替换，展示 diff。
- 原本需要确认的命令和工具使用先由低成本模型分为自动通过、人工确认或拒绝；模型不可用或未配置时保守保留人工确认，支持取消、超时、输出限制和单任务并发保护。
- 模型瞬态错误自动重试；失败、取消和重启中断后可点击“恢复任务”，并补充恢复说明。已完成工具不重放，详见 [恢复机制](docs/recovery.md)。
- 可配置模型、步骤和上下文限制；结构化分级日志。
- 单一受限 `git` 工具：查看状态、差异、历史、文件和分支；自动暂存/提交指定安全路径，并推送当前分支已校验的 upstream。

当前为初版实现。真实模型已在隔离示例项目完成修复 bug、补充测试和运行验证。详细验证范围见 [验证记录](docs/verification.md)。

## 开发

```sh
pnpm dev
# 另一个终端
pnpm dev:web
```

开发界面地址：[http://127.0.0.1:5173](http://127.0.0.1:5173)。`pnpm dev` 的 `tsx watch` 会在后端源码变化后重启服务，`pnpm dev:web` 的 Vite 会更新前端模块。侧栏的 **重载服务** 会先确认、停止任务并保存可恢复中断，再替换后端进程和完整刷新页面；开发时通常由监视器自动完成更新，生产模式则先执行 `pnpm build` 再使用该入口载入新的构建产物。

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
```

初版使用应用层审批，不提供操作系统沙箱；低成本模型的 `approve` 结果也不绕过执行器的路径、Git、提权和并发校验，获准命令仍以本机用户权限运行，适用于你信任的项目。模型可主动自动调用单一、参数受限的 `git` 工具：它检查 worktree、路径、revision 和 upstream，并禁止强推、指定远程/分支目标、重置或创建 PR；Git 仓库配置仍不是系统沙箱。

## 文档

- [AGENTS.md](AGENTS.md)：开发 agent 的工作约定。
- [需求与范围](docs/requirements.md)
- [架构](docs/architecture.md)
- [上下文压缩与历史追溯](docs/context-management.md)
- [模型容量与 token 用量](docs/model-tokens.md)
- [SWE-bench 子集评测](docs/swebench.md)
- [开发、配置与排错](docs/development.md)
- [验证记录](docs/verification.md)
- [技术与权限方案](docs/technical-proposal.md)
- [决策记录](docs/decisions.md)

开发必须配套单元/回归测试并随增量验证，命令与功能覆盖清单见 [测试约定](docs/testing.md)。

## 重载与关闭服务

在 Web UI 左侧底部点击 **重载服务 → 确认重载服务**，会先停止正在执行的任务并保存为可恢复的中断状态，再通过 `pnpm start` 的监督进程替换后端子进程，最后完整刷新浏览器页面以取得新本机会话和 SSE 连接。已修改的文件、历史和任务恢复入口保留。该入口只重新运行已有构建产物：生产模式修改源码后先执行 `pnpm build`，开发模式的 `tsx watch` 和 Vite HMR 仍负责自动编译/更新；关闭后的服务不能通过它恢复。

在 Web UI 左侧底部点击 **关闭服务 → 确认关闭服务**。正在执行的任务会被中止并保存为可恢复的中断状态，历史与已修改文件保留；浏览器显示关闭页面并停止自动重连。重新启动请在项目目录执行 `pnpm start`，然后刷新页面。

也可以在启动服务的终端按 `Ctrl+C`，使用同一套清理流程。开发时 `pnpm dev` 的文件监视进程可能仍在等待源码变化；要一并退出监视器，请在终端按 `Ctrl+C`。

所有代码必须便于人类阅读与审核，具体约定见 [代码风格](docs/code-style.md)。

### 在同一个项目下建立多个对话

侧栏按项目目录组织对话。点击项目下的“新建对话”，目录会自动填入；创建后先显示“新对话”，发送首条消息时会由低成本辅助模型自动生成标题。每段对话独立保存消息和执行记录，共用项目文件。同一时间仍只执行一个编码任务。顶部“新建会话”可填写其他项目目录。
