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

默认打开 [http://127.0.0.1:4142](http://127.0.0.1:4142)，在「模型与设置」确认连接配置、按需输入本次运行使用的 API key，然后新建会话并输入本机项目目录。

API 地址、主模型和可选辅助模型没有内置默认值；它们的唯一来源是启动时的本地 `.env`（或进程环境）中的 `CODEATELIER_BASE_URL`、`CODEATELIER_MODEL` 和可选的 `CODEATELIER_AUXILIARY_MODEL`。设置界面只读显示这些值，修改 `.env` 后重启或重载服务才生效；`settings.json` 只保存思考等级、超时和其他非连接偏好，不会覆盖部署连接。`CODEATELIER_LISTEN_ADDRESS` 默认为 `127.0.0.1`，也可设为 `::1`。若要开放受信任局域网，显式设为 `0.0.0.0`（IPv4）或 `::`（IPv6），然后用本机的局域网 IP 和端口访问，例如 `http://192.168.x.x:4142`。默认任何可访问该地址的设备都能建立会话并使用本机 agent；如需密码门禁，在本地 `.env` 设置 `CODEATELIER_WEB_PASSWORD_ENABLED=true` 与非空 `CODEATELIER_WEB_PASSWORD`，浏览器必须输入正确密码才会加载页面。门禁是单一共享密码，不提供账户、角色、限流或公网安全保证；局域网仍仅用于受信任网络，并通过防火墙阻止公网入站访问。

请复制 `.env.example` 为本地 `.env`，填写实际连接配置及 `CODEATELIER_API_KEY`；该文件被 Git 忽略。不要将密钥或访问密码写入源码或提交记录。UI 输入的 API key 仅保留在后端内存，并仅覆盖当前进程的环境密钥；访问密码只从服务端环境读取。

## 初版能力

- 可选的环境密码门禁：默认关闭；启用后必须先输入正确密码才会加载 Web UI，验证状态仅以服务进程有效的 HttpOnly cookie 保存。
- 多轮会话、流式回复、历史消息与工具结果持久化；完成任务默认仅显示用户输入和最后一轮 agent 输出，计划、工具、diff 和通知可按需展开检查。任务输入框是所见即所得 Markdown 编辑器，输入规则原地转换为富文本并将生成的 Markdown 提交，用户与 agent 消息支持 GitHub Flavored Markdown（标题、列表、表格、任务列表、链接和代码围栏），不执行原始 HTML；首条用户消息会通过低成本辅助模型自动生成会话标题。手机浏览器可通过顶部菜单打开完整项目与会话侧栏，选择会话、点击遮罩或按 Escape 均会收起抽屉。
- 通过受审批的命令浏览目录和搜索代码；按行读取文件时可显示不可见空白，并以统一的 `edit_files` 批量新建文件或执行带版本、行范围和上下文锚点的安全补丁，展示 diff。精确匹配失败时仅对普通文件的唯一候选进行受限空白规范化，歧义一律拒绝。
- 通过 Responses 内置 `web_search` 查询公开网页，搜索回答会显示可点击的来源链接。搜索摘要不足时，agent 可在既有命令与网络权限边界内用 `curl` 获取公开网页正文；网页内容和其中的指令均不可信，不提供浏览器自动化、私网访问或凭据。
- 非 Sandbox/宿主 fallback 中原本需要确认的命令和工具，先由低成本模型分为自动通过、移交人工或拒绝；模型不可用或未配置时保守移交人工。Sandbox Agent Runtime 已有能力内的工具免审批，越界命令由 `run_with_permissions` 携带命令、结构化权限和理由走同一三级审批，再交给独立 Capability Runner。两条路径都支持取消、超时和输出限制。
- 模型瞬态错误自动重试；失败、取消和重启中断后可点击“恢复任务”，并补充恢复说明。已完成工具不重放，详见 [恢复机制](docs/recovery.md)。
- 可配置模型、步骤和上下文限制；结构化分级日志；已完成或运行中的任务可经受保护的本机接口导出 Perfetto 时间线，用于分析模型、上下文和工具的耗时与关键路径。trace 只记录安全摘要，不保存可重放的原始 prompt 或工具输出。任务开始后另会捕获受保护的本地 replay case，可手动导出并在新目录中复建经完整读取验证的编辑前文件；详情见 [任务 Replay Case](docs/replay-cases.md)。
- 单一受限 `git` 工具：查看状态、差异、历史、文件和分支；自动暂存/提交指定安全路径，并推送当前分支已校验的 upstream。

当前为初版实现。真实模型已在隔离示例项目完成修复 bug、补充测试和运行验证。Windows 专用用户 Sandbox 仍为显式开启、需管理员安装的预览能力；macOS/Linux 不加载该实现，即使设置开关也保持原有 non-isolated 路径。详细验证范围见 [验证记录](docs/verification.md)。

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

## Windows 专用用户 Sandbox 使用说明（预览）

> **适用范围与状态：** 此功能只面向 Windows，默认关闭，且需要一次性管理员安装；macOS 和 Linux 即使设置开关也会继续使用 `non-isolated` 宿主路径。当前代码已经接入专用账户、C++ Supervisor、Agent Runtime、AccessManifest、ACL/WFP、认证 IPC、Capability Runner 和 Push Runner，但固定账户提升安装、真实公网 HTTPS/remote push、复杂 ACL、强制取消、崩溃及重启恢复仍未完成分层端到端验收。因此它是**预览能力，而非稳定或跨平台的安全保证**。请只在可备份、可信的测试项目中试用。完整架构、分层验收状态和已知限制见 [Windows 专用用户 Sandbox Runtime 与 Broker 架构](docs/windows-integrity-sandbox.md)。

### Sandbox 会做什么

启用并且启动前自检成功时，CodeAtelier 会为每个任务启动一个常驻 **Agent Runtime**：

- Runtime、其普通命令、非 push Git、hook/helper 和子进程均在专用低权限本地账户 `CodeAtelierSandbox`、restricted token 和 Job 中运行；模型 API key、会话数据库与审批策略仍保留在宿主 **Broker Host**。
- Broker 按任务生成 AccessManifest，只投影当前工作区、显式授权的读写根、运行时依赖及精确的 Git global/include 配置图。可写根还必须匹配本实例的 `WRITE_RESTRICTED` capability。
- 按专用账户 SID 安装的持久 WFP 规则默认阻止直接网络。普通 Runtime 没有命令网络；模型请求只能经 Broker。越界命令须用 `run_with_permissions` 声明最小递归读写根、至多一个 HTTPS host 和理由，并再次经过三级审批后由独立 Capability Runner 执行。
- Git 始终在 Runtime 内执行，Broker 不执行 Git。`git push` 是独占工具批次，需逐次审批，由独立 Push Runner 经受控 relay/CONNECT 代理和短期凭据运行；WFP 不会因 push 或扩展网络请求而临时放宽。

Sandbox **不会**创建 worktree、暂存副本或自动回滚：可写操作直接改动真实工作区，取消、失败和崩溃都不能撤销已发生的文件或 Git 副作用。工作区内的 `.git`、`.env` 和其他文件没有额外保护。请在启用前提交、备份或另行复制重要工作。

### 安全边界与不应作出的假设

- 专用账户不继承宿主交互用户的私有 profile、凭据、SSH agent 或仅授予宿主用户的文件权限；但 `Everyone`、`Authenticated Users`、机器级安装目录等既有 ACL 仍可能允许额外读取。因此这**不是纯读取 allowlist**，任何可读内容都可能进入模型上下文、会话记录或获准网络请求。
- 不同工作区可按全局设置并行运行 1～4 个任务，同一工作区仍串行；但它们共用一个 Sandbox 账户。活动授权根会形成读取并集，同账户 peer 可能读取、终止、注入或检查其他 Runtime。**不同对话不是彼此的 OS 安全边界。**
- 这不抵抗管理员、SYSTEM、内核/驱动漏洞、弱/null DACL、重解析/复杂 ACL 缺陷、已泄露句柄或获准 HTTPS host 接收数据等风险。不要把 Sandbox 当作执行不可信恶意代码的完整隔离环境。
- 当前 WSL2 `inspect` 实现只保留为历史档案，不是当前 Windows Sandbox 路径，见 [旧 WSL2 Sandbox 档案](docs/sandbox.md)。

### 首次安装与验收

**前置条件：** 使用真实 Windows 主机、Node.js 24、pnpm 11.22.0，以及可编译原生组件的 Windows C++ 构建环境。不要把外层受限执行环境中的结果当作平台验收：外层 Sandbox 可能阻断嵌套 restricted token、Job 或 WFP 操作。

1. 在普通终端进入仓库并准备构建产物；下列两个 Sandbox 构建命令只生成仓库内产物，不修改系统：

   ```powershell
   pnpm install --frozen-lockfile
   pnpm build
   pnpm sandbox:native:build
   pnpm sandbox:runtime:build
   ```

2. **另开“以管理员身份运行”的 PowerShell**，进入同一仓库目录。安装命令不会自行触发 UAC。若当前 `PATH` 中的 `node` 不是可信的 Node.js 24 executable，先在这个管理员终端设置要复制的路径：

   ```powershell
   $env:CODEATELIER_SANDBOX_RUNTIME_NODE = "C:\Program Files\nodejs\node.exe"
   pnpm sandbox:install
   pnpm sandbox:verify
   ```

   安装会创建 `CodeAtelierSandbox` 账户、受保护的 ProgramData 安装副本和按账户 SID 的持久 WFP 规则。安装器使用随机密码的系统保护存储；不要手工修改其账户、ProgramData 状态、WFP 规则或 ACL。

3. 回到普通终端，运行产品链路验收：

   ```powershell
   pnpm sandbox:runtime:verify
   ```

   此命令使用模拟模型、临时工作区和私网拒绝夹具，不访问真实模型、外部网络、远程仓库或凭据。只有它在已安装的真实 Windows 环境中输出 `PASS`，才能证明本次安装的 Agent Runtime、Capability Runner、受控 Push Runner 和取消路径没有发生 fallback/unknown；即使通过，也**不**等同于真实公网 HTTPS、真实 remote push 或全部 W0--W6 阶段验收完成。

### 启用、运行与状态判断

1. 在本地、被 Git 忽略的 `.env` 中设置启动期配置，然后重新启动或重载服务。该开关不能在 Web UI 中动态切换：

   ```dotenv
   CODEATELIER_SANDBOX_ENABLED=true
   ```

2. 正常构建和启动应用：

   ```powershell
   pnpm build
   pnpm start
   ```

3. 观察任务时间线、工具结果和当前会话的 Sandbox 状态：

   | 状态                    | 含义                                                                                                                                | 你应如何处理                                                                              |
   | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
   | `sandboxed`             | 专用用户 Runtime 已成功启动并承载该任务。                                                                                           | 仍遵守本节的工作区、同账户 peer 和预览限制。                                              |
   | `host-process-fallback` | Runtime 启动前的 preflight/provision/self-check 失败，但系统已证明没有 Sandbox 操作启动且临时授权已回滚；任务自动改用宿主权限执行。 | 把它当作未隔离任务；检查警告、`sandbox.log` 和安装状态。                                  |
   | `non-isolated`          | Sandbox 开关关闭，或平台不是 Windows。                                                                                              | 命令按原有宿主审批与权限路径运行。                                                        |
   | `unknown` / `orphaned`  | Runtime、Runner 或清理结果无法证明；副作用可能已发生。                                                                              | 不要自动重试或恢复同一副作用。先核对当前文件/Git 状态，并处理安装或账户 generation 问题。 |

启动前失败只会在能够证明目标操作**尚未开始**时自动 fallback。若 Runtime、Capability Runner 或 Push Runner 已启动而结果未知，系统不会在宿主模式重放该操作；它会记录 `unknown`/`orphaned`、隔离该账户 generation 并停止新的 Sandbox 实例，直至完成对账。

### 审批、命令和 Git 的差异

- **宿主模式或 fallback：** 原有命令与工具审批仍生效；获准命令以当前本机用户权限运行，适用于你信任的项目。低成本模型的 `approve` 不会绕过路径、敏感文件、Git、提权或并发校验。
- **已启动的 Sandbox Agent Runtime：** AccessManifest/WFP 范围内的文件工具、普通命令和非 push Git 不再逐项审批。越界普通文件工具会被拒绝；越界命令必须通过 `run_with_permissions` 申请最小根和单个 HTTPS host。该申请是递归目录能力，获准命令可读取整个读根、修改整个写根，并向获准 host 发送可读数据，务必审查审批内容。
- **Git push：** 仅支持已校验 upstream 的既有受限 Git 契约；push 必须独占当前工具批次，按 host/port、期限、流量及“该 host 可能接收 Runner 所有可读内容”的风险逐次审批。当前真实 remote/凭据/helper 兼容性尚未完成提升环境验收，不应将预览实现用于关键生产推送。

### 维护、故障处理与卸载

| 场景                                 | 命令与执行位置                                        | 说明                                                                                                              |
| ------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 检查已安装组件、账户和 WFP 状态      | 在**管理员 PowerShell** 执行 `pnpm sandbox:verify`    | 不替代 `sandbox:runtime:verify` 的产品链路验收。                                                                  |
| 安装后的产品链路检查                 | 在普通终端执行 `pnpm sandbox:runtime:verify`          | 不访问公网或真实凭据。                                                                                            |
| 正常卸载                             | 在**管理员 PowerShell** 执行 `pnpm sandbox:uninstall` | 先停止所有任务；卸载必须确认没有活动 lease。                                                                      |
| 正常卸载无法证明完整清理时的受控恢复 | 在**管理员 PowerShell** 执行 `pnpm sandbox:recover`   | 只清理安装 state 中记录的产品账户、固定 WFP 对象、欢迎屏幕值和受控 ProgramData 子目录；不会扫描或重置整机防火墙。 |

更新原生 Supervisor、WFP manager 或 Runtime bundle 后，应重新生成对应构建产物，并在管理员终端运行安装/验证流程，使受保护的安装副本与其 SHA-256 状态保持一致。出现 fallback、`unknown`、`orphaned`、安装校验失败或无法清理时，不要手动删除账户/WFP/ACL 来“强行修复”；保留诊断现场，先停止任务并使用 `sandbox:verify` 或 `sandbox:recover` 对账。Sandbox 生命周期日志位于平台数据目录的 `logs/sandbox.log`，常规应用日志和会话历史仍分别保存。

若要完全关闭预览能力，将 `.env` 改回以下值并重启或重载服务；若还要移除机器级安装对象，再按上表执行卸载：

```dotenv
CODEATELIER_SANDBOX_ENABLED=false
```

初版仍以应用层审批为主；产品的 `git` 工具继续限制为安全 action、当前分支已校验 upstream，并禁止强推、任意 remote/branch、重置或创建 PR。

## 文档

- [AGENTS.md](AGENTS.md)：开发 agent 的工作约定。
- [需求与范围](docs/requirements.md)
- [架构](docs/architecture.md)
- [Windows 专用用户 Sandbox Runtime 与 Broker 架构（预览实现，待提升验收）](docs/windows-integrity-sandbox.md)
- [Windows 专用 Sandbox 用户最小验证](experiments/windows-sandbox-user-demo/README.md)
- [Windows Restricted-Token 最小可行性探针](experiments/windows-restricted-token-demo/README.md)
- [旧 WSL2 Sandbox 实施档案](docs/sandbox.md)
- [上下文压缩与历史追溯](docs/context-management.md)
- [项目记忆系统设计（尚未实现）](docs/memory-system.md)
- [模型容量与 token 用量](docs/model-tokens.md)
- [Perfetto tracing 与本地导出](docs/development.md#perfetto-tracing)
- [任务 Replay Case](docs/replay-cases.md)
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
