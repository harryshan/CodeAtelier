# CodeAtelier

**在浏览器里描述需求，让 AI 帮你读代码、改代码、跑测试。**

CodeAtelier 是一个运行在本机的个人 AI 编程助手。连接模型服务、选好项目目录，就可以开始对话。它会直接操作项目文件，你可以随时查看修改和执行过程，或停止任务。

Git 项目可以通过侧栏 `⑂` 显式创建 Worktree 对话，选择起始提交并在独立目录工作；原有 `＋` 仍直接使用项目目录。对话与目录持久绑定，项目记忆共享，不自动复制未提交文件或清理目录。使用方式、Sandbox 和恢复边界见 [Worktree 指南](docs/worktrees.md)。

Riftri、CoW 和 overlay 文件隔离实验已移至 [overlay-development](https://github.com/harryshan/CodeAtelier/tree/overlay-development)，不属于 main 功能。分支切换与旧数据边界见 [D172](docs/decisions.md#d172将工作区隔离实验移出-main)。

## 项目亮点

- **Windows Sandbox**：让 agent 和普通命令在专用低权限账户下运行，限制文件访问与直接联网，减少对日常系统账户的依赖。已通过持续实际使用验证，可用于日常开发。
- **不只给建议，也动手完成任务**：阅读代码、修改文件、运行测试、查看差异，还能提交和推送 Git。每一步的执行过程和结果都可以查看。
- **能并行的工作不必排队**：独立工具同时执行，需要先后顺序的操作按顺序完成。不同工作目录（包括同一项目的独立 worktree）可以并行处理，同一实际目录的任务依次执行，避免同时改文件。
- **长任务可以接着做**：自动整理长对话，跨会话保留项目记忆；长时间命令由模型定期检查进度，任务中断后可手动恢复，不盲目重放结果不明的操作。
- **支持 Skill 和 MCP**：自动发现本地 Skill，按需加载工作方法；通过 MCP 接入本地或远程工具和服务，连接与凭据由本机后端管理。
- **过程可查，等待可诊断**：对话阅读器按任务查看模型调用和工具结果；会话统计与性能 trace 帮助了解用量、执行耗时和等待原因。
- **核心机制自己实现**：使用 TypeScript 开发，不依赖 agent 编排框架。任务循环、工具调度、上下文和权限管理都在项目内，便于理解和修改。

## 快速开始

需要 **Node.js 24 或 26**、[项目指定版本的 pnpm](package.json)，以及支持流式响应和工具调用的 **Responses、Chat Completions 或 Anthropic Messages API 服务**。项目需要用到的 Git、编译器等工具也应在本机安装。

已有旧版数据库时，先按 [SQLite 完整迁移步骤](docs/database-migration.md#9-已实现的运行与离线操作) 停机备份、转换和验证；当前版本使用 schema v11，不在启动时隐式升级。已激活的数据目录通过 `history-active.json` 定位运行库，备份和搬迁时须一并保留目标目录。安装式 Windows Sandbox 还需更新到匹配的 Runtime IPC v17。

### 1. 安装依赖

取得源码后，在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
```

### 2. 配置模型

不再需要 `.env`。首次启动后打开 **模型与设置 → 模型连接**，填写服务地址、完整模型名和密钥；未配置时仍可进入设置和查看历史，但不能启动任务。

配置统一保存在宿主数据目录的 `settings.json`。模型密钥和 MCP 凭据保存在私有 JSON 中（**不是加密保险库**），访问密码仅保存加盐验证材料。旧版本用户请先阅读 [迁移与生效规则](docs/settings-system.md#8-当前实现与操作)，不要直接覆盖旧配置。

协议可选 `responses`（默认）、`chat-completions`、`messages`；主/辅助模型可独立连接。新增两种协议首批支持文字和本地工具，暂不提供思考参数或内置搜索，也不代表所有兼容服务已验证。示例和限制见 [模型协议](docs/model-protocols.md)，其他偏好见 [配置说明](docs/development.md#配置)。

### 3. 启动并开始对话

```sh
pnpm build
pnpm start
```

浏览器打开 `http://127.0.0.1:4142`，输入本机项目目录，点击 **连接项目并新建对话**。可以先试试：

> 看看这个项目怎么启动、怎么测试，先不要修改文件。

或者给它一个具体任务：

> 修复这个错误，补上回归测试，完成后告诉我改了哪些文件、测试是否通过。

设置页可随时保存模型、任务、Sandbox、MCP、访问及诊断配置。运行中的任务保持原配置；模型和密钥用于下一任务。监听、密码门禁和 Sandbox 等显示“待重启”，不会自动打断任务。自定义数据目录使用 `pnpm start --data-dir "你的数据目录"`。

## Sandbox 与平台状态

Sandbox 在各平台均**默认关闭**；未启用时，工具在宿主环境执行。启用前请按对应指南准备依赖，再在设置页启用 Sandbox、保存并重启服务。

### Windows Sandbox

agent 和普通命令在专用低权限账户下运行，文件权限和直接联网限制由 Windows 机制执行，不只靠提示词约束。已通过持续实际使用验证，可用于日常开发；首次安装需要 Windows C++ 构建环境和管理员权限。具体步骤见 [安装与使用指南](docs/windows-sandbox-guide.md)。

这套机制不保证文件访问和各会话之间完全隔离。启动前检查失败且可以安全回退时，会明确提示后改用宿主模式；请留意任务的实际执行状态。完整限制见 [安全边界](docs/windows-integrity-sandbox.md)。

### Linux / macOS Sandbox

两者使用独立的可选 MXC 后端，不依赖 Windows 专用账户机制：

- **Linux**：需要 Bubblewrap 和可用的非特权 user namespace。目标是原生 Linux，已有 WSL2/ext4 环境下的功能链路验证，不代表所有发行版和裸机环境均已验证。
- **macOS**：已接入 Seatbelt 后端，但尚未实机验证，不能视为已验收功能。

Linux/macOS 启用 Sandbox 后，依赖缺失或启动失败会停止任务，**不会静默改用宿主模式**。安装条件和操作见 [Linux / macOS Sandbox 指南](docs/posix-sandbox.md)。

Git 使用 CLI，和其他命令走相同权限路径；需要宿主文件、网络或凭据时须显式申请宿主命令。MCP 和获批的宿主命令**不受 Sandbox 保护**。Sandbox 也不提供文件修改回滚。

## 日常使用

- **继续聊或另开一题**：原会话可以追问，项目名称右侧的 **＋** 可以新建对话。历史保存在本机，重启服务后仍可查看。
- **离开页面或停止任务**：只要后端仍在运行，关掉页面不会停止后台任务。可以在界面取消任务，或通过侧栏“关闭服务”及终端 `Ctrl+C` 退出；中断任务可手动恢复。
- **等待长时间操作**：命令、Git 和 MCP 操作没有固定总运行时限；实际执行后每五分钟由主模型根据最新输出判断继续等待或中断，你也可以随时取消。状态检查会产生额外模型用量，连接和模型请求仍有独立超时，见 [长工具运行](docs/long-running-tools.md)。
- **跨会话保留项目经验**：agent 可按需维护同一项目的事实、约定和未完成事项，新任务先获取摘要，再按需读取详情。记忆不是最新代码的替代品，也不保证始终正确，见 [项目记忆](docs/memory-system.md)。
- **多会话并行**：同目录与不同目录的会话均可并行，不设主任务数量上限；同一会话仍只运行一个任务。注意同目录文件/Git 冲突、验证相互干扰和资源耗尽风险，需要独立工作副本时使用 Worktree 对话。
- **添加技能和外部工具**：按 [Skill 指南](docs/skills.md) 添加 `SKILL.md`，或按 [MCP 指南](docs/mcp.md) 配置服务并填写 `description`。模型会直接看到技能和已启用 MCP 服务的名称、用途，根据任务按需选择；MCP 配置修改后须重启或重载后端，不会为展示目录提前连接服务。

### 查看执行记录与用量

点击侧栏 **“对话阅读器”**，选择 **对话 → Task**，即可按模型调用查看工具、输入输出和历史事件，支持搜索、状态筛选和分页。直接浏览已保存的记录，无需先导出 JSON，也不会重新执行任务；已有导出文件可通过“本地 JSON”在浏览器中读取，不上传。

阅读器也可通过 `http://127.0.0.1:4142/?view=replay` 访问，沿用主服务的访问密码门禁。自定义端口时使用实际服务地址，开发模式端口为 `5173`。详细操作见 [对话阅读器指南](docs/replay-cases.md#可视化阅读)。

对话角落的统计可查看 token 用量、模型请求、工具调用和累计运行时间。排查任务耗时时，可下载已归档的性能 trace；运行中快照及使用方法见 [性能诊断指南](docs/tracing.md)。这些文件可能包含命令、路径和代码片段，请按敏感数据保管。

### 更新已有安装

更新源码后，重新运行 `pnpm install --frozen-lockfile` 和 `pnpm build`，再重启服务或使用侧栏“重载服务”。重载只加载已构建的代码，不会自动编译；请先结束正在执行的任务。

若已安装 Windows Sandbox，涉及其组件更新时还需按 [维护指南](docs/windows-sandbox-guide.md#维护故障处理与卸载) 重建并以管理员权限执行 Repair，仅刷新网页或重启后端不会更新已安装组件。

## 使用前须知

- **直接改文件，没有一键回滚。** 请用 Git 或备份保留重要内容；取消任务不会撤销已发生的修改。只在可信项目中使用，遇到人工审批时先看清操作内容。Git CLI 沿用普通命令权限，不再提供专用 Git 参数或推送目标校验；推送前请核对目标。
- **本机运行不等于离线。** 任务所需的对话、代码片段和工具结果会发送给你配置的模型服务。不要提交 `.env`、密钥或含敏感内容的历史记录。
- **默认仅本机访问，不面向公网。** 如需受信任局域网访问，请先阅读 [访问配置](docs/development.md)，设置访问密码并限制网络访问。

发送任务前，可勾选输入框下方的 **“启用 subagent（只读）”**：主 agent 可让多个 explorer 筛选信息、reviewer 独立审查修改。默认关闭、仅本次任务生效；成功提交后复位，运行中不可切换，恢复沿用原任务选择。该试用功能可能增加模型用量；是否分工由主 agent 决定，修改仍由主 agent 执行。安装态 Sandbox 专项验证限制见 [多 agent 说明](docs/multi-agent-design.md)，各平台实际测试情况见 [验证记录](docs/verification.md)。

## 参与开发

技术栈：TypeScript、Node.js、React/Vite、Fastify、SQLite、Pino。

完成依赖安装和模型配置后，在两个终端分别运行：

```sh
pnpm dev      # 后端
pnpm dev:web  # 前端，需另开终端
```

开发界面为 `http://127.0.0.1:5173`。不要与 `pnpm start` 同时占用后端端口。

- `pnpm check`：类型、代码风格、单元/回归测试和测试构建。
- `pnpm test:e2e`：浏览器交互测试，首次需运行 `pnpm exec playwright install chromium`。

默认测试不需要真实模型密钥。Evaluation 仅手动运行，不包含在默认测试或 CI 中。贡献前请阅读 [开发约定](AGENTS.md) 和 [测试说明](docs/testing.md)。

## 更多文档

- [配置与排错](docs/development.md) · [任务恢复](docs/recovery.md) · [长工具运行](docs/long-running-tools.md)
- [Windows Sandbox](docs/windows-sandbox-guide.md) · [Linux / macOS Sandbox](docs/posix-sandbox.md)
- [Skill](docs/skills.md) · [MCP](docs/mcp.md) · [项目记忆](docs/memory-system.md)
- [对话阅读器](docs/replay-cases.md#可视化阅读) · [性能诊断](docs/tracing.md)
- [架构说明](docs/architecture.md) · [全部文档](docs/README.md)
