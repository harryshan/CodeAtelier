# Windows Sandbox 使用指南（预览）

> **适用范围与状态：** 此功能只面向 Windows，默认关闭，且需要一次性管理员安装；macOS 和 Linux 即使设置开关也会继续使用 `non-isolated` 宿主路径。
>
> 当前代码已经接入专用账户、C++ Supervisor、Agent Runtime、AccessManifest、ACL/WFP 和认证 IPC。本机固定账户安装态的模拟模型任务、普通命令、Broker Git、主动取消和正常清理已通过；真实 remote push、复杂 ACL、强制终止、崩溃及重启恢复仍未验收。Capability Runner 与 Push Runner 代码保留但暂停使用；获批 `run_with_permissions` 命令和全部 Git 工具 action 由 Broker 以宿主用户权限运行，其中 push 逐次审批。因此它仍是**预览能力，而非稳定或跨平台的安全保证**。请只在可备份、可信的测试项目中试用。
>
> 完整架构、分层验收状态和已知限制见 [Windows 专用用户 Sandbox Runtime 与 Broker 架构](windows-integrity-sandbox.md)。

### Sandbox 会做什么

启用并且启动前自检成功时，CodeAtelier 会为每个任务启动一个常驻 **Agent Runtime**：

- Runtime 及其普通命令子进程在专用低权限本地账户 `CodeAtelierSandbox`、restricted token 和 Job 中运行；模型 API key、会话数据库、审批策略和 Git 工具均保留在宿主 **Broker Host**。
- 每个实例使用非交互式 window station 内的私有 desktop；同一宿主登录会话的并发实例可共用 station，因此它不构成不同任务间的安全隔离。
- Broker 按任务生成 AccessManifest，只投影当前工作区、显式授权的读写根、运行时依赖及一个空的只读 Git global 配置文件；不再向 Runtime 投影宿主 Git global/include 文件。实例 token 同时包含 root capability 和 `Everyone` restricting SID，后者会使已有 Everyone 可写 ACL 成为额外写入路径。
- 按专用账户 SID 安装的持久 WFP 规则默认阻止直接网络。普通 Runtime 没有命令网络；模型请求只能经 Broker。越界命令须用 `run_with_permissions` 提交完整命令和理由，经三级审批后由 Broker 以宿主用户权限执行。该命令不受 Sandbox 额外文件根或网络 host 限制。
- 全部 Git 工具 action 在 Broker 以宿主用户权限执行，并保留固定参数及路径校验；`git push` 另预检 upstream 和目标、逐次审批且独占工具批次。Git 配置、hook/helper 及子进程不受专用账户 Sandbox 限制。WFP 不会因 Git 而临时放宽。
- Runtime 内普通命令的输出先写入实例私有 TEMP，再按固定间隔回传；单次临时输出达到 64 MiB 会终止该命令并报错。临时文件在命令结束后删除，Broker 宿主命令和 Git 不使用这一传输路径。

Sandbox **不会**创建 worktree、暂存副本或自动回滚：可写操作直接改动真实工作区，取消、失败和崩溃都不能撤销已发生的文件或 Git 副作用。工作区内的 `.git`、`.env` 和其他文件没有额外保护。请在启用前提交、备份或另行复制重要工作。

### 安全边界与不应作出的假设

- 专用账户不继承宿主交互用户的私有 profile、凭据、SSH agent 或仅授予宿主用户的文件权限；但 `Everyone`、`Authenticated Users`、机器级安装目录等既有 ACL 仍可能允许额外读取。因此这**不是纯读取 allowlist**，任何可读内容都可能进入模型上下文、会话记录或获准网络请求。
- `Everyone` 也在 Runtime 的 restricting SID 列表中。若某个文件或目录的既有 ACL 允许 Everyone 写入，Runtime 可能直接写入，即使它不在本实例的可写根内；同账户并发实例也可能写入彼此带这类 ACL 的根。不要将 root capability 视为完整的文件写入 allowlist。
- 不同工作区可按全局设置并行运行 1～4 个任务，同一工作区仍串行；但它们共用一个 Sandbox 账户。活动授权根会形成读取并集，同账户 peer 可能读取、终止、注入或检查其他 Runtime。**不同对话不是彼此的 OS 安全边界。**
- 这不抵抗管理员、SYSTEM、内核/驱动漏洞、弱/null DACL、重解析/复杂 ACL 缺陷、已泄露句柄或获准 HTTPS host 接收数据等风险。不要把 Sandbox 当作执行不可信恶意代码的完整隔离环境。

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

   若已安装旧的 Runtime bundle，更新本地代码并重建后，在同一个管理员 PowerShell 7 终端执行修复与复核：

   ```powershell
   pnpm sandbox:repair
   pnpm sandbox:verify
   ```

3. 回到普通终端，运行产品链路验收：

   ```powershell
   pnpm sandbox:runtime:verify
   ```

   此命令使用模拟模型、临时工作区和不可用的本机 HTTPS 端口，不访问真实模型、外部网络、远程仓库或凭据。它检查已安装 Agent Runtime 内的文件工具和普通命令、Broker 宿主 Git status、审批后的 Broker 宿主命令、Broker 宿主 Git push 拒绝结果及取消路径，且要求没有 fallback/unknown。即使输出 `PASS`，也**不**等同于真实公网 HTTPS、真实 remote push 或全部 W0--W6 阶段验收完成；Broker 宿主命令和全部 Git 工具 action 本身不受 Sandbox 保护。

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
   | `sandboxed`             | 专用用户 Runtime 已成功启动并承载该任务；获批 Broker 宿主命令仍是例外。                                                             | 仍遵守本节的工作区、同账户 peer 和预览限制；查看每条命令的执行实例。                      |
   | `host-process-fallback` | Runtime 启动前的 preflight/provision/self-check 失败，但系统已证明没有 Sandbox 操作启动且临时授权已回滚；任务自动改用宿主权限执行。 | 把它当作未隔离任务；检查警告、`sandbox.log` 和安装状态。                                  |
   | `non-isolated`          | Sandbox 开关关闭，或平台不是 Windows。                                                                                              | 命令按原有宿主审批与权限路径运行。                                                        |
   | `unknown` / `orphaned`  | Runtime、Runner 或清理结果无法证明；副作用可能已发生。                                                                              | 不要自动重试或恢复同一副作用。先核对当前文件/Git 状态，并处理安装或账户 generation 问题。 |

启动前失败只会在能够证明目标操作**尚未开始**时自动 fallback。若 Runtime 已启动而结果未知，系统不会在宿主模式重放该操作；它会记录 `unknown`/`orphaned`、隔离该账户 generation 并停止新的 Sandbox 实例，直至完成对账。Broker 宿主命令或 Git push 结果未知时也禁止自动重放，须单独核对其副作用。

### 审批、命令和 Git 的差异

- **宿主模式或 fallback：** 原有命令与工具审批仍生效；获准命令以当前本机用户权限运行，适用于你信任的项目。低成本模型的 `approve` 不会绕过路径、敏感文件、Git、提权或并发校验。
- **已启动的 Sandbox Agent Runtime：** AccessManifest/WFP 范围内的文件工具和普通命令不再逐项审批；Git 工具 action 在 Broker 使用宿主用户权限执行，push 另需逐次审批。越界普通文件工具会被拒绝；越界命令必须通过 `run_with_permissions` 提交完整命令和理由，经 review 后由 Broker 使用宿主用户权限运行。它可访问宿主用户有权访问的文件、网络和凭据，务必按该权限审查命令。
- **Git push：** 仅支持已校验 upstream 的既有 Git 工具契约；push 必须独占当前工具批次，审批会展示预检 URL、目标和 Broker 宿主权限。Git 配置、hook/helper 与网络不受专用账户 Sandbox 限制。当前真实 remote/凭据/helper 兼容性尚未完成验收，不应将预览实现用于关键生产推送。

### 维护、故障处理与卸载

| 场景                                 | 命令与执行位置                                        | 说明                                                                                                              |
| ------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 检查已安装组件、账户和 WFP 状态      | 在**管理员 PowerShell** 执行 `pnpm sandbox:verify`    | 不替代 `sandbox:runtime:verify` 的产品链路验收。                                                                  |
| 更新已安装组件                       | 在**管理员 PowerShell** 执行 `pnpm sandbox:repair`    | 先重建对应产物；等价于 `install.ps1 -Mode Repair`，不会自动触发 UAC。                                              |
| 安装后的产品链路检查                 | 在普通终端执行 `pnpm sandbox:runtime:verify`          | 不访问公网或真实凭据。                                                                                            |
| 正常卸载                             | 在**管理员 PowerShell** 执行 `pnpm sandbox:uninstall` | 先停止所有任务；卸载必须确认没有活动 lease。                                                                      |
| 正常卸载无法证明完整清理时的受控恢复 | 在**管理员 PowerShell** 执行 `pnpm sandbox:recover`   | 只清理安装 state 中记录的产品账户、固定 WFP 对象、欢迎屏幕值和受控 ProgramData 子目录；不会扫描或重置整机防火墙。 |

更新原生 Supervisor、WFP manager 或 Runtime bundle 后，应重新生成对应构建产物，并在管理员终端运行安装/验证流程，使受保护的安装副本与其 SHA-256 状态保持一致。出现 fallback、`unknown`、`orphaned`、安装校验失败或无法清理时，不要手动删除账户/WFP/ACL 来“强行修复”；保留诊断现场，先停止任务并使用 `sandbox:verify` 或 `sandbox:recover` 对账。

Sandbox 生命周期日志位于平台数据目录的 `logs/sandbox.log`，常规应用日志和会话历史仍分别保存。

若要完全关闭预览能力，将 `.env` 改回以下值并重启或重载服务；若还要移除机器级安装对象，再按上表执行卸载：

```dotenv
CODEATELIER_SANDBOX_ENABLED=false
```

初版仍以应用层审批为主；产品的 `git` 工具继续限制为安全 action、当前分支已校验 upstream，并禁止强推、任意 remote/branch、重置或创建 PR。
