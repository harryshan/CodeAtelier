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

- 多轮会话、流式回复、历史消息与工具结果持久化；首条用户消息会通过低成本辅助模型自动生成会话标题。
- 列目录、读取文件、代码搜索、新建文件和精确替换，展示 diff。
- 命令执行前审批，支持取消、超时、输出限制和单任务并发保护。
- 模型瞬态错误自动重试；失败、取消和重启中断后可点击“恢复任务”，并补充恢复说明。已完成工具不重放，详见 [恢复机制](docs/recovery.md)。
- 可配置模型、步骤和上下文限制；结构化分级日志。
- 受限 Git 工具：查看状态和差异；提交指定路径、推送当前 upstream 前均展示内容并要求逐次确认。

当前为初版实现。真实模型已在隔离示例项目完成修复 bug、补充测试和运行验证。详细验证范围见 [验证记录](docs/verification.md)。

## 开发

```sh
pnpm dev
# 另一个终端
pnpm dev:web
```

开发界面地址：[http://127.0.0.1:5173](http://127.0.0.1:5173)。

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
```

初版使用应用层审批，不提供操作系统沙箱；获准命令以本机用户权限运行，适用于你信任的项目。产品 Git 提交和推送不是无人值守操作：只能通过受限工具发起，必须逐次确认；不支持强推、指定远程/分支、重置或创建 PR。

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

## 关闭服务

在 Web UI 左侧底部点击 **关闭服务 → 确认关闭服务**。正在执行的任务会被中止并保存为可恢复的中断状态，历史与已修改文件保留；浏览器显示关闭页面并停止自动重连。重新启动请在项目目录执行 `pnpm start`，然后刷新页面。

也可以在启动服务的终端按 `Ctrl+C`，使用同一套清理流程。开发时 `pnpm dev` 的文件监视进程可能仍在等待源码变化；要一并退出监视器，请在终端按 `Ctrl+C`。

所有代码必须便于人类阅读与审核，具体约定见 [代码风格](docs/code-style.md)。

### 在同一个项目下建立多个对话

侧栏按项目目录组织对话。点击项目下的“新建对话”，目录会自动填入；创建后先显示“新对话”，发送首条消息时会由低成本辅助模型自动生成标题。每段对话独立保存消息和执行记录，共用项目文件。同一时间仍只执行一个编码任务。顶部“新建会话”可填写其他项目目录。
