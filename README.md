# CodeAtelier

**在本机浏览器中，通过对话完成代码阅读、修改、测试与交付。**

CodeAtelier 是使用 TypeScript 开发的个人 coding agent：后端在本机操作你选择的项目，通过用户配置的 Responses API 服务调用模型，Web UI 展示计划、流式回复、工具执行、文件差异和审批过程。核心 agent 循环、工具调度、上下文管理和权限机制自行实现，不依赖 agent 编排框架。

> 当前公开能力以单 agent 为主；只读 subagent 尚未开放。Windows 专用账户 Sandbox 属于默认关闭的预览能力，不能视为跨平台隔离保证。平台与功能的实测范围见 [验证记录](docs/verification.md)。

## 项目亮点

- **完整的编码闭环**：先读取项目约定和相关代码，再制定计划、精确修改、运行测试并汇报结果；同一界面可以查看命令输出、退出状态和 diff。
- **可审查的文件编辑**：已有文件先读后改，以内容哈希核对版本，拒绝过期快照；批量编辑支持明确的新建与修改，不盲目覆盖并发变化。
- **有依赖的工具并行**：自研 DAG 调度，无依赖的工具可以并行，“修改 → 验证”等操作按依赖执行；失败会阻断依赖它的后续节点。不同项目可并行，同一真实工作目录串行。
- **长任务的上下文与记忆**：根据服务能力管理 token 预算，接近容量时压缩旧上下文，保留用户原文、历史快照及恢复状态；使用项目级 Markdown 记忆延续跨会话信息。
- **持久化与谨慎恢复**：SQLite 保存对话和工具记录，支持旧会话续聊、有界模型重试及人工恢复；执行结果未知时不盲目重放可能有副作用的操作。
- **可选辅助模型**：可单独配置低成本模型处理会话标题、上下文摘要与三级审批；审批模型缺失或异常时转人工确认。
- **Skill 与本机 MCP**：按任务发现本地技能、按需加载工作流；由本机后端连接 stdio 或 Streamable HTTP MCP 服务，不依赖模型服务商托管连接。
- **执行过程可观察**：流式时间线、会话 token/工具统计、分级纯文本日志、Perfetto 性能追踪与本地 Replay Case，便于定位失败和性能问题。

## 可以做什么

| 场景       | 示例请求                                                       |
| ---------- | -------------------------------------------------------------- |
| 理解项目   | “阅读项目约定，梳理启动流程、关键模块和测试入口，先不要修改。” |
| 修复缺陷   | “定位这个错误，先补一个失败的回归测试，再修复并运行相关检查。” |
| 实现与重构 | “按现有风格实现这个需求，同时检查调用方、测试和文档。”         |
| 审查与交付 | “检查当前 diff，指出风险，验证通过后只提交本次相关文件。”      |
| 检索资料   | “检索这个接口的公开文档，给出来源，再对照本地实现。”           |
| 使用扩展   | “列出可用 Skill”或“列出已配置的 MCP 服务和工具”。              |

Git 使用单一受限工具，支持状态、差异、历史、文件与分支查看，以及指定路径的暂存、提交和当前 upstream 推送；不提供任意 Git 参数、强推或重置类操作。公开网页检索依赖配置的 Responses 服务支持内置 `web_search`。

**任务会直接修改选定目录，不自动创建 worktree，也不提供一键回滚。** 建议先在测试项目试用，并用 Git 或备份保留重要文件。取消或失败不会撤销已经发生的修改。

## 快速开始

### 1. 准备环境

- **Node.js 24.x 或 26.x**。
- **pnpm**：使用 [package.json](package.json) 中 `packageManager` 指定的版本；依赖以 `pnpm-lock.yaml` 为准。
- 一个提供所需模型、流式响应与工具调用能力的 **Responses API 服务**。不承诺兼容所有标注为“OpenAI 兼容”的服务。
- 使用 Git 功能及项目测试命令时，本机还需要对应的 Git、语言运行时和构建工具。

取得源码后，在仓库根目录确认环境并安装依赖：

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
```

### 2. 配置模型

复制 [`.env.example`](.env.example) 为 `.env`；如果已有 `.env`，请直接编辑，不要覆盖。

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

macOS / Linux：

```sh
cp .env.example .env
```

填写以下字段，示例地址、模型名和密钥**均为占位值**：

```dotenv
CODEATELIER_BASE_URL=https://api.example.com/v1
CODEATELIER_MODEL=YOUR_MODEL_ID
CODEATELIER_API_KEY=YOUR_API_KEY
CODEATELIER_REASONING_EFFORT=high
```

API 地址使用服务提供的 Base URL，模型标识原样填写，不做简称转换。API key 也可以留空，启动后在“模型与设置”中输入；UI 输入的密钥仅保留在后端当前进程内存，重启后需重新输入。

可选辅助模型使用同一 API 地址与密钥：

```dotenv
CODEATELIER_AUXILIARY_MODEL=YOUR_AUXILIARY_MODEL_ID
CODEATELIER_AUXILIARY_REASONING_EFFORT=low
```

不配置时，标题和摘要沿用主模型，需要审批的操作转人工确认；配置后，辅助模型可将待审批操作分类为自动通过、人工确认或拒绝。

### 3. 构建并启动

```sh
pnpm build
pnpm start
```

浏览器打开 `http://127.0.0.1:4142`，在侧栏进入 **模型与设置**，确认连接信息、密钥状态和运行偏好。

API 地址与主、辅助模型标识只从 `.env` 或进程环境读取，不能在 UI 修改；修改后须重启或重载后端。`settings.json` 保存思考等级、超时、并发数等非连接偏好，已保存偏好优先于环境默认值。不要提交 `.env`、密钥或访问密码。

### 4. 完成第一个任务

1. 在页面输入**后端所在机器上的项目目录**，选择“连接项目并新建对话”。局域网浏览器访问时，这不是浏览器所在设备的目录。
2. 输入清晰的目标，例如：

   > 先阅读 AGENTS.md 和相关代码，说明这个项目如何启动、如何测试，不修改文件。

   熟悉执行过程后，再尝试：

   > 修复这个错误，先增加可复现问题的回归测试，再修改实现并验证。完成后说明修改文件、测试结果和未验证部分。

3. 展开执行过程查看读取、编辑、命令和 diff；遇到人工审批时，核对完整操作及影响范围后再决定。
4. 查看最终结果并检查本地修改。需要继续时，在原会话追问；需要独立上下文时，点击项目名称右侧的 **＋** 新建对话。

## 日常使用

- **并行与排队**：不同真实工作目录默认最多同时运行 2 个任务，可在设置中调为 1～4；同一目录始终串行，同一会话只允许一个运行中或排队中的主任务。
- **查看历史**：消息和工具记录保存到本地。关闭页面不等于停止任务，只要后端仍运行，任务就可以继续；重新打开后可查看历史和当前状态。
- **取消与恢复**：取消后不会自动重启。失败、取消或服务重启中断后可从恢复入口继续；遇到结果未知的命令，先核对实际副作用，不应直接重复执行。详见 [恢复机制](docs/recovery.md)。
- **长对话与项目记忆**：自动压缩不等于无限上下文；超出可安全处理的容量时会明确停止。项目记忆是历史参考而非当前代码或权限，管理 UI 尚未实现。详见 [上下文管理](docs/context-management.md) 与 [项目记忆](docs/memory-system.md)。
- **统计与排错**：展开会话统计查看服务实报 token、工具调用和运行时间；任务 trace 保存后可下载供 Perfetto 分析。Replay Case 的本地导出和数据边界见 [使用说明](docs/replay-cases.md)。

### 添加 Skill

将技能保存为项目或宿主用户目录中的 `<技能根>/<name>/SKILL.md`。预设技能根按 `.codeatelier/skills`、`.agents/skills`、`.claude/skills` 的顺序扫描，项目级优先于用户级；同名取第一个有效条目。

例如在项目中创建 `.codeatelier/skills/review/SKILL.md`：

```markdown
---
name: review
description: 审查当前修改，检查调用方、测试和文档，不自动修改文件。
---

# 代码审查

1. 读取项目约定与相关 diff。
2. 检查正常、失败和边界路径，以及测试覆盖。
3. 按严重程度报告有证据的问题，明确未验证部分。
```

发起新任务后可要求“使用 review 技能审查当前修改”。每个任务重新发现技能，无需重启服务；进行中的任务不会热更新。Skill 只是参考说明，不自动执行脚本，也不能授予权限。完整格式和限制见 [Skill 指南](docs/skills.md)。

### 接入 MCP

在后端数据目录放置私有 `mcp.json`，或用 `CODEATELIER_MCP_CONFIG` 指向配置文件的绝对路径，再重启后端。支持本地 stdio 和远程 Streamable HTTP；未配置服务时不建立连接。

随后可在对话中要求“列出已配置的 MCP 服务，查看某个服务的工具”。除无连接的服务列表外，发现和操作都经过审批。连接由本机后端建立，凭据留在后端；返回结果会进入模型上下文。配置格式、离线演示及 OAuth 等未支持能力见 [MCP 指南](docs/mcp.md)。

## 访问与执行边界

默认只监听回环地址。需要受信任局域网访问时，将 `CODEATELIER_LISTEN_ADDRESS` 显式设为 `0.0.0.0` 或 `::`，使用本机局域网 IP 访问。

默认任何能访问服务地址的设备都可以使用本机 agent。可通过 `CODEATELIER_WEB_PASSWORD_ENABLED=true` 和非空 `CODEATELIER_WEB_PASSWORD` 开启共享密码门禁；它不提供多用户账户、角色或公网安全保证。

- **本机后端不等于离线运行**：模型请求会把任务所需的对话、代码片段和工具结果发送给你配置的模型服务；Skill 正文和 MCP 结果也可能进入上下文。使用前确认这些数据允许发送。
- **审批不等于系统隔离**：宿主模式下获准命令以本机用户权限运行，应只用于可信项目。辅助模型审批不能替代对高风险操作的检查。
- **Sandbox 外的执行仍有宿主权限**：全部 Git 工具 action、获批的 `run_with_permissions` 命令及 MCP 操作由 Broker 执行，不受 Runtime Sandbox 保护。Git push 仍需逐次审批。
- **Windows Sandbox 是预览能力**：默认关闭，需管理员安装；历史安装态已有部分链路通过，但当前版本仍需重建、Repair 和独立验收，复杂 ACL、真实远端 push、强制终止及重启恢复等矩阵尚未完整通过。共用账户和 Everyone restricting SID 意味着不能承诺完整读写 allowlist 或任务间 OS 隔离。启动前特定失败可能明确警告后回退宿主，不能只凭开关判断任务受保护。macOS/Linux 使用宿主路径。试用前阅读 [Sandbox 使用指南](docs/windows-sandbox-guide.md) 与 [架构及边界](docs/windows-integrity-sandbox.md)。

只读 subagent 尚未对外开放；工具并行和不同工作区的任务并发不等于多 agent。当前也不提供完整 IDE、交互式终端、浏览器自动化、云端部署或多用户权限系统。

## 数据保存与隐私

默认数据目录如下，可通过 `CODEATELIER_DATA_DIR` 指定其他位置：

| 平台    | 默认目录                                                              |
| ------- | --------------------------------------------------------------------- |
| Windows | `%LOCALAPPDATA%/CodeAtelier`                                          |
| macOS   | `~/Library/Application Support/CodeAtelier`                           |
| Linux   | `$XDG_DATA_HOME/CodeAtelier`，未设置时为 `~/.local/share/CodeAtelier` |

会话历史使用 SQLite 分片持久化，配置偏好、日志、项目记忆和任务 trace 也保存在平台数据目录，不混入用户代码项目。服务重启会保留已保存的对话，但不会自动重放未完成任务。

**历史、备份、trace 和 Replay Case 均应作为敏感本机数据保护。** 即使认证字段经过脱敏，它们仍可能包含代码、路径、命令或工具结果，不应直接提交仓库或公开上传。目录结构、迁移备份与日志查看方法见 [数据与日志](docs/development.md#数据与日志)。

## 开发与验证

技术栈为 **TypeScript strict + Node.js + React/Vite + Fastify + SQLite + Pino**。通用库和模型 SDK 负责基础能力，核心 agent 机制保持自研。

已安装依赖并完成 `.env` 配置后，分别在两个终端启动：

```sh
pnpm dev
# 另一个终端
pnpm dev:web
```

开发界面为 `http://127.0.0.1:5173`，后端默认使用 4142 端口。后端由 `tsx watch` 监视源码，前端由 Vite 更新；不要同时在相同端口启动 `pnpm start`。

| 命令                            | 用途                                                |
| ------------------------------- | --------------------------------------------------- |
| `pnpm check`                    | 类型、ESLint、Prettier、单元/回归测试和测试模式构建 |
| `pnpm test` / `pnpm test:watch` | 一次性运行测试 / 开发中持续运行                     |
| `pnpm test:e2e`                 | 测试模式构建及模拟后端上的 Chromium 交互验证        |
| `pnpm build` / `pnpm start`     | 构建实际使用的产物 / 启动构建后的服务               |

提交前运行检查；涉及 UI、HTTP 或 SSE 的改动还应运行 E2E，首次运行需准备浏览器：

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
```

默认测试使用隔离的测试配置和模拟模型，不需要真实模型密钥。真实模型验证另行手动执行并消耗服务额度；Evaluation（含评测回归）也仅在用户明确需要时手动运行，不进入默认测试或 CI。详细约定见 [测试说明](docs/testing.md) 与 [AGENTS.md](AGENTS.md)。

### 代码结构

```text
src/
  agent/         # agent 循环、任务与工具调度
  context/       # 上下文计量与压缩
  providers/     # 模型协议适配
  tools/         # 文件、命令、Git 等工具契约与执行
  permissions/   # 权限判断与审批
  sessions/      # SQLite 历史、任务状态与恢复材料
  memory/        # 跨会话项目记忆
  skills/        # Skill 发现与按需读取
  mcp/           # 本机 MCP 客户端
  sandbox/       # Runtime、Broker 与平台执行边界
  tracing/       # 性能追踪
  server/        # HTTP、SSE 与后端生命周期
  web/           # React 界面
native/          # Windows 原生组件
scripts/         # 构建、测试与诊断脚本
tests/           # 单元、回归与浏览器测试
docs/            # 需求、设计、使用与验证记录
```

完整模块职责与数据流见 [架构说明](docs/architecture.md)。

## 重载与关闭服务

在侧栏选择 **重载服务 → 确认重载服务**，会停止任务、保存可恢复中断并替换后端进程，随后刷新页面。生产模式修改源码后需先 `pnpm build`；重载只加载现有构建产物。

选择 **关闭服务 → 确认关闭服务**，或在终端按 `Ctrl+C`，会停止任务并释放服务资源。历史和已修改文件保留；再次运行 `pnpm start` 后刷新页面即可继续使用。开发模式退出文件监视器仍需在终端按 `Ctrl+C`。

## 常见问题

- **启动提示缺少 API 地址或模型**：确认仓库根目录 `.env` 已填写 `CODEATELIER_BASE_URL` 和 `CODEATELIER_MODEL`。已有 `settings.json` 不能代替这两个启动字段。
- **修改 `.env` 后没有变化**：重启或重载后端；思考等级等偏好若已在 UI 保存，会优先于环境默认值。
- **端口被占用**：通过 `CODEATELIER_PORT` 改用其他端口，开发 Vite 代理会读取同一配置。
- **模型或网页检索失败**：检查服务地址、完整模型 ID、密钥及服务是否支持所需 Responses 能力；不要把所有“兼容接口”视为等价。
- **任务中断后能否继续**：已保存内容仍在，从恢复入口继续；结果未知的工具需要先核对实际状态。重载和取消都不是回滚。

更多排错步骤见 [开发、配置与排错](docs/development.md)。

## 文档入口

| 主题         | 文档                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 总览与边界   | [文档导航](docs/README.md) · [需求与范围](docs/requirements.md) · [设计决定](docs/decisions.md)                                                        |
| 开发与贡献   | [架构](docs/architecture.md) · [配置与排错](docs/development.md) · [代码规范](docs/code-style.md) · [Agent 工作约定](AGENTS.md)                        |
| 上下文与恢复 | [上下文管理](docs/context-management.md) · [模型容量与 token](docs/model-tokens.md) · [项目记忆](docs/memory-system.md) · [任务恢复](docs/recovery.md) |
| 扩展能力     | [Skill](docs/skills.md) · [MCP](docs/mcp.md) · [只读 subagent 设计与进度](docs/multi-agent-design.md)                                                  |
| Sandbox 预览 | [使用指南](docs/windows-sandbox-guide.md) · [Windows 架构与验收边界](docs/windows-integrity-sandbox.md)                                                |
| 测试与诊断   | [测试约定](docs/testing.md) · [验证记录](docs/verification.md) · [Replay Case](docs/replay-cases.md) · [手动 SWE-bench 评测](docs/swebench.md)         |
