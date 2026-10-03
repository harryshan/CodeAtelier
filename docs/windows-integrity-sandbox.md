# Windows 专用用户 Sandbox Runtime 与 Broker 架构

状态：**Windows 专用用户 Sandbox 已通过用户实际使用验证，可用于日常开发。** 2026-10-03 用户确认持续使用一段时间功能正常（D130）；此前本机提升安装、模拟模型产品链路、普通命令、Broker Git 分流、主动取消和正常清理已有通过记录。默认关闭、显式安装启用的配置不变。该确认不把错误 IPC、复杂 ACL、真实 remote push、强制终止与重启恢复等专项自动标为通过。macOS/Linux 明确禁用本实现，继续使用既有 non-isolated 路径。

2026-09-27 临时执行路径（D119–D122）：`run_with_permissions` 只提交命令和理由，Broker 审批通过后以宿主用户权限执行，记为 `broker-command/host-process`。全部 Git 工具 action 经认证 IPC 交给 Broker 宿主 Git，普通 action 记为 `broker-git/host-process`，push 另经预检和逐次审批并记为 `broker-git-push/host-process`。这些宿主执行均不受 Sandbox 文件、网络或凭据限制。Agent Runtime token 现含 `Everyone` restricting SID，已有 Everyone 可写对象可能绕过实例 root capability。下文涉及 Capability Runner、Push Runner、relay/askpass 的设计与代码目前暂停使用；其限制和 W5 状态不能作为现行产品安全保证。当前使用方式以 [使用指南](windows-sandbox-guide.md) 和 D119–D122 为准。

安装操作见 [使用指南](windows-sandbox-guide.md)；方案演变见 [决策记录](decisions.md)，组件实验与产品验收证据见 [验证记录](verification.md)。

## 0. 术语、进程和完成条件

本文中的名称表示不同的进程或协议层，不得互换使用：

| 术语                           | 严格含义                                                                                                                                                                                                                                         | 当前状态                                                                                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Broker Host**                | 运行于宿主交互用户、持有模型密钥、session 数据库、审批策略和长期恢复账本的可信 Node.js 进程。获批 `run_with_permissions` 与全部 Git 工具 action 在其宿主权限下执行。                                                                                  | 已存在；Windows 启用时默认通过 SandboxBroker launcher 管理 Agent Runtime provision、IPC adapter 和恢复账本。                                                                                                                                                                     |
| **Agent Runtime**              | 每个任务一个、运行于 `CodeAtelierSandbox` restricted token/Job 中的常驻 Node.js 进程。它承载完整 agent loop、上下文准备、工具计划、文件工具与普通命令；通过认证 Runtime IPC 请求 Broker 模型、session、Git 与其它固定宿主能力。 | `AgentRuntimeService`、默认 Engine launcher 和 C++ Supervisor 启动路径已接入；独立 Node harness 已证明 loop 与文件工具不在 Broker 进程，native build 已通过。**安装态产品链路及用户日常使用验证已通过；专项故障矩阵单独记录。**                                                        |
| **Push Runner**                | 原设计中 Agent Runtime 的 agent loop 阻塞等待期间创建的单用途受限进程。                                                                       | 代码保留、当前产品路径暂停使用；真实 remote push 尚未完成验收。                                                                                                                                                                                                            |
| **Capability Runner**          | 原设计中单次获批命令的受限进程，限定递归读写根与一个 HTTPS host。                                                                                                                                                                                | 代码保留、当前产品路径暂停使用；其旧权限范围不可用于描述 `run_with_permissions`。                                                                                                                                                                                                |
| **Sandbox Supervisor**         | 已安装且受保护的固定 C++ 控制进程。它验证安装状态、创建 restricted token/Job/desktop、启动或终止 Agent Runtime/Push Runner，并完成 ACL journal 与 generation 清理；不解释模型输出，不运行 agent loop。                                           | 已承载逐工具 process 与常驻 Agent Runtime 启动、任务 pipe 身份检查和字节代理；本机安装态链路及用户日常使用验证已通过，专项故障矩阵单独记录。                                                                                                                                                                             |
| **Sandboxed Tool Process**     | Agent Runtime 为一次 `run_command` 或其它已有权限工具启动的 shell 或其后代。它继承 Agent Runtime 的账户、token、Job、ACL 和 WFP 边界，但**不是 Agent Runtime**，结束后不保留 agent 状态。                                      | 当前默认 Windows Sandbox 路径由常驻 Agent Runtime 创建和监督；Git 工具均由 Broker 宿主执行。                                                                                                                                                                                  |
| **Broker command**             | 审批后的 `run_with_permissions` 宿主子进程，可使用宿主用户的文件、网络和凭据权限。                                                                                                                                                               | 当前产品路径；以 `broker-command/host-process` 单独记录，不属于 Sandbox 隔离范围。                                                                                                                                                                                               |
| **Runtime IPC**                | Agent Runtime 与 Broker Host 间的任务专属、认证、固定 schema 双向通道。连接身份必须联合验证 PID/创建时间、Job、token/capability、generation、nonce 和 lease；模型/session/审批 adapter 运行在其上。                                              | C++ 已创建任务专属 pipe，并在转发首帧前验证 PID、创建时间、Job、账户 SID、restricted execution/root capability 和固定 Node 映像；Supervisor 再代理有界 Runtime IPC 字节流。nonce/lease 由 Broker manifest 账本与首帧握手绑定；安装态正常任务与主动取消已通过，错误客户端、断连和异常恢复等矩阵仍无完整专项证据。 |
| **Supervisor Control Channel** | Broker Host 到 Sandbox Supervisor 的私有启动/终止控制通道。它只管理固定 Runtime kind 和 AccessManifest，不承载模型、工具或任意命令请求。                                                                                                         | TypeScript schema/channel 已有；现有逐工具二进制帧不是该目标控制通道。                                                                                                                                                                                                           |

“Runtime”单独出现时只指 **Agent Runtime**；其它进程必须完整写作 Push Runner 或 Capability Runner，不能把单条命令、Git 子进程、C++ supervisor或协议核心混称 Runtime。`executionInstance` 是持久化归因记录，也不是进程名称。

单元测试构造的内存对象必须称为 protocol core、mock transport 或 test harness，不能记作 Runtime IPC 已完成。

当前最低判据是：Broker 负责调度、模型与固定宿主能力；每个 Sandbox 任务先启动一个常驻 Agent Runtime；模型轮次、上下文处理、工具 DAG、文件工具与普通命令由 Runtime 发起，Git 工具经真实认证 IPC 在 Broker 执行；模型密钥和宿主数据库不进入 Runtime；取消、断连、cleanup unknown 和服务重启仍遵守 generation 隔离及禁止盲目重放契约。

仅把命令/Git 子进程放进专用账户不满足该判据。

## 1. 目标与安全边界

Windows Runtime 使用安装程序预先创建的单一低权限本地账户 `CodeAtelierSandbox`。Agent Runtime 及其普通命令后代在该账户身份及其 restricted token/Job 中运行。宿主 Broker 保留模型密钥、会话存储与审批；全部 Git 工具 action 和经审批的 `run_with_permissions` 命令以宿主用户权限运行。

目标能力：

- 不继承宿主交互用户的 profile、凭据和仅授予该用户的文件权限；AccessManifest 再向专用账户增加工作区、显式只读根、私有目录和产品 Runtime 依赖的访问权。宿主 Git 配置图不再投影给 Runtime。它不是纯读取 allowlist：`Everyone`、`Authenticated Users`、机器级安装目录或其他既有 DACL 仍可能允许读取，必须在 UI 中明确。
- 写访问同时经过专用账户 DACL 与 `WRITE_RESTRICTED` token 的 restricting SID 检查；每个实例拥有独立 execution/root capability，token 另含 `Everyone` 以兼容系统组件。Windows 可能为同一账户的多次显式凭据启动复用 logon SID，故只记录它用于诊断/兼容，绝不作为文件写入 capability。预期写入位置是工作区、显式可写根和实例临时目录，但已有 Everyone 可写 ACL 可能提供额外写入位置。

- 工作区内部不额外保护 `.git`、`.env` 或其他子路径；命令可以修改、删除或泄露工作区内的可访问内容，取消不回滚。
- 机器级 WFP 规则按专用账户 SID 阻止直接出站，只允许连接受控回环 relay/proxy 端口；模型和获准网络由 Broker 代理。
- 全部 Git 工具 action 在 Broker 宿主执行；push 另做预检和逐次审批。宿主 Git 可读取 system、global/include、local 和 worktree 配置；配置、hook、helper 和 remote helper 都视为不可信代码，也都拥有宿主用户权限。
- Broker IPC、回环代理和凭据管道必须再次验证 execution instance；账户 SID 只是机器级隔离身份，不单独授权任务能力。

Sandbox 模式沿用现有全局并发设置：不同真实工作区最多同时运行 1～4 个任务，同一真实工作区仍严格串行。每个 Sandbox execution instance 使用独立 capability SID、Job、private desktop、临时目录和 IPC nonce。Push 必须是当前工具批次的唯一节点；Agent Runtime 保持存活并同步等待 Broker 宿主 Git，不暂停其它工作区任务。

本文仍只使用一个本地账户，不设计账户池，也不因 Sandbox 启用而把全部对话全局串行。

单账户并发不提供任务间 OS 安全隔离。为了让该账户访问每个活动工作区，所有同账户 Runtime 都可能通过账户 SID 读取其它并发任务当前投影的工作区和 read roots；同账户 peer 还可能打开、终止、注入、调试或检查其它 Runtime/Job/desktop/命名对象。`WRITE_RESTRICTED` 的每实例 capability SID 不能覆盖已有 Everyone 可写 ACL，因此也不承诺完整实例间文件写入隔离。

Broker/session API 仍按任务路由以维持正常产品行为，但不宣称抵抗恶意 peer 冒用或干扰另一个任务；需要该保证时必须改用账户池、AppContainer 或 VM profile。

该 profile 提供宿主完整性和相对宿主交互用户的有限文件机密性，但不承诺“只可读取授权根”。它不抵抗管理员、SYSTEM、内核/驱动漏洞、`Everyone`/`Authenticated Users` 等既有读取权、弱或 null DACL、用户主动授予的读取根、继承/重解析错误、已泄露句柄或获准 host 的数据接收。

明确不采用：

- 当前交互用户派生 token 作为网络身份；WFP 内建条件无法按本次 PID/Job 精确区分同用户、同映像进程。
- 自研 WFP callout driver；专用账户 SID 已提供内建 ALE 可匹配身份。
- AppContainer、`broadFileSystemAccess`、实验性 `CreateProcessInSandbox`/Bound File System 或 Chromium Target hook。
- 仅靠代理环境变量、Broker IPC、程序路径或端口不可猜宣称直接网络已被阻断。

## 2. 组件与数据流

```text
Browser / Web UI
        |
Broker Host（当前交互用户；可信策略与长期状态）
  |-- AccessManifest、审批、session、executionInstance、tracing
  |-- 审批后的 run_with_permissions 宿主命令进程
  |-- model / storage / capability request / network proxy adapters
  |-- 专属 Named Pipe：验证 SID + PID/创建时间 + Job + nonce/lease
  |
  `-- C++ supervisor
        |-- CodeAtelierSandbox 账户 generation + 多实例 lease registry
        |-- CreateProcessWithLogonW（不加载 profile）两段启动 + restricted token
        |-- 私有 desktop、Job、mitigation、资源与取消
        `-- Agent Runtime、单用途 Push Runner（Capability Runner 代码暂停使用）
              |-- 账户既有读取权 + 工作区、显式 read/write roots、精确 Git config graph
              |-- 本地 Git、hook/helper、Node、shell、编译器
              `-- WFP：仅可达受控 loopback relay/proxy 端口

提升安装程序（一次性/维护时）
  |-- 创建专用账户、随机密码和受保护凭据
  |-- 配置最小登录权限与独立 profile
  `-- 安装/对账按账户 SID 的持久 WFP V4/V6 规则
```

Broker、supervisor、安装程序和 Sandbox Process 是不同边界。运行时 Broker 默认不提升；账户/WFP/本地策略的创建、修复和删除只由显式 UAC 安装流程执行。

Runtime 只可通过 `run_with_permissions` 提交任意命令文本和理由；Broker 审批后在宿主进程执行，原 AccessManifest/WFP/relay 根与 host 限制不适用。旧 Capability Runner 的 schema 和实现保留供后续重新启用时审查。

## 3. 安装、账户与启动

### 3.1 一次性提升安装

安装程序创建一个固定本地账户；名称只是诊断标签，授权以安装时记录并复证的 SID 为准。该账户：

- 使用随机高熵密码；密码只以 Windows DPAPI/等价系统保护形式保存，存储 DACL 只允许 SYSTEM 和安装该实例的宿主用户，绝不进入 argv、环境、日志、session 或工作区。
- 不加入 Administrators。首版使用普通 Broker 可调用的 `CreateProcessWithLogonW` 创建本地账户进程，因此不能同时配置 `SeDenyInteractiveLogonRight`；账户以高熵秘密、隐藏欢迎屏幕入口、禁止远程交互/网络/服务登录和 WFP fence 降低被其它入口使用的风险。若本机或域策略禁止这种本地 logon，安装失败；后续若改用提升服务与 batch logon，必须另行审计高权限控制面。
- 安装器把原生构建产物复制到 `%ProgramData%\CodeAtelier\Sandbox\bin`，把固定 Node.js 24 或 26 executable、`agent-runtime.mjs`、`compaction-worker.mjs`、`read-file-worker.mjs` 和 `subagent-worker.mjs` 复制到受保护的 `runtime` 子目录。

  两个目录的 DACL 都只允许安装用户、Administrators 和 SYSTEM 修改，Sandbox 账户仅可读取/执行；v4 state 记录七个安装副本的 SHA-256，TypeScript 与 native self-check 都复核摘要，运行时不执行工作区 `dist` 或当前 `PATH` 下可被项目替换的文件。

- 不加载宿主用户 profile，不继承其 cookie、SSH agent、凭据管理器、证书私钥或已打开 handle。默认不加载持久 Sandbox profile hive；每个 lease 使用新建的私有 `HOME`/`USERPROFILE`/`XDG_CONFIG_HOME`/`TEMP` 目录。

  若真实工具兼容性迫使加载专用账户 profile/HKCU，必须先定义可证明的逐租约重置流程，重置失败即隔离账户，不能让前一任务持久化配置影响下一任务。

- 卸载前必须证明无活跃租约，再撤销 WFP、ACL、profile、secret 和账户；任一步骤失败都报告遗留安全状态。

安装程序在 `ALE_AUTH_CONNECT_V4/V6` 安装按账户 SID 匹配的持久规则：只允许受控的固定 loopback relay/proxy 端口范围，拒绝其它出站连接。UDP、IPv6、raw socket、DNS、bind/listen 和 loopback 必须逐项验证；默认不开放任意 loopback 或开发服务器端口。

启动前自检账户 SID、规则 ID、层、权重、动作、端口和 V4/V6 覆盖；状态未知或被策略软件覆盖时 Sandbox 不启动，任务按第 7 节的可证明安全 fallback 契约转为宿主执行。

### 3.2 实例租约、两段启动与清理

Broker 为单一账户维护一个 account generation 和最多 1～4 个活动 instance lease；每项记录 SID 摘要、instance/task/workspace、创建时间、Job ID、execution/root capability SID 集合和 lease epoch。调度器在发放 lease 前复核不同工作区、全局并发上限及所有活动授权状态。

supervisor 以 `CreateProcessWithLogonW` 且不使用 `LOGON_WITH_PROFILE` 启动固定 runner；每次启动记录实际 logon SID/LUID，但不要求唯一，也不以其授权。

runner 再从专用账户 token 创建 `WRITE_RESTRICTED` primary token：移除非必要 privilege/group，并加入本实例独立 execution SID、本次可写根 capability SID 与 `Everyone` 兼容 SID；不加入 logon SID。此兼容选择会使已有 Everyone 写入 ACE 绕过 root capability。

目标以 suspended 状态创建，绑定本实例 Job、desktop 和 mitigation 后才恢复执行；不能证明 token SID 集合与 AccessManifest 一致时终止启动。

bootstrap runner 的创建控制面和 supervisor 必须只允许 Broker/SYSTEM；Sandbox Runtime 不得连接 supervisor、取得其高权限 handle 或请求任意 SID/路径/ACL/进程操作。

runner 为 restricted token 设置显式 default DACL，仅向共享账户 SID 和本实例 execution SID 授予正常运行所需访问，不向可能共享的 logon SID、Everyone 或 root capability 授予新对象通用权限。

后代 process/thread/token/Job/pipe/命名对象和 private desktop/window station 继续使用最小 DACL 以减少偶然干扰，但不把它们描述成对同账户恶意 peer 的隔离边界。peer 的 handle、debug、window message、注入和命名对象访问必须观测并记录为残余风险，不再作为禁止 Sandbox 并发的门槛。

安装验收仍须证明两段启动在支持的 Windows/域策略上不需要运行时提升。

所有后代必须留在 `KILL_ON_JOB_CLOSE` Job。计划任务、BITS、服务、COM、父进程伪装和现存宿主进程代写必须作为逃逸夹具验证。即使后代逃离 Job，只要仍使用专用账户 SID，持久 WFP 仍应阻止其直接外网；这不免除进程和文件逃逸修复。

每个实例 lease 释放前必须完成其 Job 终止、代理关闭、短期凭据失效、capability ACE 撤销和对象对账。账户 SID 的共享 normal-side ACE 由以对象身份为键的引用计数 grant table 管理；它提供读写候选权限，`WRITE_RESTRICTED` 检查可由本实例 root capability 或已有 Everyone 写入 ACE 满足。

同一对象被不同实例分别声明为 read/write 根时仍共享一个账户 grant，只有最后一个对象引用释放时才撤销；不得因一个任务结束而破坏另一活动任务。任一步骤无法证明完成则账户 generation 进入 `orphaned/quarantined`：停止接受新任务，终止并对账该账户下全部活动实例，直到修复或重新安装；绝不只释放故障 workspace 后继续复用账户。

## 4. 文件访问与 Git 配置

### 4.1 AccessManifest 与 ACL

每次执行生成不可变 AccessManifest：

- `readWriteRoots`：当前工作区、用户明确添加的可写目录、实例私有临时目录。
- `readOnlyRoots`：用户明确添加的源码/工具目录、产品固定 Runtime/工具依赖；这是新增授权清单，不代表专用账户没有其他既有只读 ACL。
- `gitConfigFiles`：原生协议暂保留的逐租约空 global config 文件；宿主实际 global/include 图不再投影给 Runtime。
- 每项包含规范路径、访问模式、卷标识、`FILE_ID_128`、重解析状态、原始 DACL 摘要和本次 ACE delta。

Broker 先以不跟随重解析点的方式规范化对象并记录卷/file ID，supervisor 在安装 ACE 前重新打开、复核并在实例期保留原对象 handle。每个活动根都为专用账户 SID 添加共享的 normal-side 读写候选 ACE；可写根另外获得该实例独有的 root capability SID ACE，restricted token 放入本实例 execution/root SID 和 Everyone。

账户 SID 的普通访问检查因此形成所有活动 manifest 的可读并集；写访问的 `WRITE_RESTRICTED` 检查可由 root capability 或已有 Everyone 写入 ACE 满足。没有对应 root capability 的只读实例或另一实例，也可能写入已有 Everyone 写入 ACE 的根。当前实现不对整个有效 DACL 进行 Everyone 写入预检，不能把显式根列表称为完整写入 allowlist。

根 ACE 带经过验证的 object/container 继承标志；预检枚举拒绝或显式处理关闭继承、deny ACE 与不能被继承覆盖的现存子对象，不能只改根后假设整棵树可用。不改 owner，不替换整体 DACL。撤销先核对原路径；同卷 rename/move 后通过 journal 中的卷/file ID 和 `OpenFileById` 重开原对象，路径替换或删除重建的新对象不误改。

无法定位、撤销或复证时锁定相关工作区并隔离整个账户 generation。

专用账户不继承只授予宿主交互用户的 profile、其它源码和用户级工具权限，但仍可能通过 `Everyone`、`Authenticated Users` 或其它既有 DACL 读取系统/共享对象。缺少依赖时产品显示实际拒绝路径，由用户显式增加只读根或改用机器级安装；不得自动授权整个 `%USERPROFILE%`、盘符根、`Users` 目录、凭据目录或任意父目录。

UI 必须同时显示显式 read roots 和“机器既有 ACL 可能额外允许读取”的限制；任何可读内容都可能进入模型请求、session 或获准网络。

### 4.2 Git 配置与凭据

全部产品 Git 工具 action 经认证 Runtime IPC 交给 Broker，以宿主用户权限在真实工作区运行。Git 使用宿主可见的 system、global/include、local 和 worktree 配置；hook、helper、证书、凭据与网络也按宿主用户权限运行。受限 action 参数、工作区根和路径校验仍生效，但它们不是 Sandbox 文件或网络边界。push 独占工具批次，并额外执行 Broker 预检与逐次审批。

Agent Runtime 不再获得宿主 global/include 配置图的 ACL 投影。原生启动协议仍要求一个 `GIT_CONFIG_GLOBAL` 路径，因此 Broker 为每个租约创建空的只读文件，置于 Runtime 不可写的投影目录。Runtime 的 `HOME`、`USERPROFILE` 和 `XDG_CONFIG_HOME` 仍指向私有目录。旧精确配置图解析器、Push Runner、CONNECT relay 和 askpass 代码保留作历史实现，不是现行 Git 工具调用的安全保证；相关设计见 D096、D102 与 D119–D121。

## 5. 进程、IPC 与 Broker 能力

supervisor 只接受 Broker 创建的私有继承控制 handle 或同等强度通道上的固定 schema；Runtime 不能连接 supervisor 控制面，IPC 不返回原始 process、Job、token 或文件 handle。

Broker 断连、heartbeat/租约过期或实例身份无法复证时，supervisor 关闭本实例 Job；任一实例失败进入 `orphaned` 后隔离 account generation，并排空其它活动实例。

Runtime 与 Broker 使用任务专属 Named Pipe。

pipe DACL 同时要求宿主 Broker 身份，或专用账户 SID 加本实例 execution SID；Broker 再从连接取得真实 PID，联合核对启动时 process handle、创建时间、账户 generation、restricted token/capability SID、实际映像、实例 Job、nonce、task/tool-call、kind 和 lease epoch。

PID、账户 SID、logon SID、pipe 名称、端口或 Runtime 自报字段都不单独授权；正常的另一实例连接必须因 execution capability/Job/nonce/lease 不匹配而被拒绝，以保证路由和审计正确。

由于恶意 peer 可能注入或操纵合法目标 Runtime，这不是任务间对抗性认证边界；真正的安全边界是任何 Sandbox 进程都不能越过 typed Broker operation、宿主 ACL 与 WFP fence。

Broker 只提供参数受限的 typed operation：

| 类别                   | 允许                                                    | 禁止                                            |
| ---------------------- | ------------------------------------------------------- | ----------------------------------------------- |
| `model.request`        | 使用宿主固定模型配置发送受限 Responses 请求             | 暴露 API key、任意 URL/认证头或通用 HTTP tunnel |
| `run_with_permissions` | 提交完整命令和理由；Broker 三级审批后以宿主用户权限执行 | 未经审批执行、复用一次性授权、绕过 Git 工具契约 |
| `git.push`             | Broker 预检 upstream/URL/OID/ref、审批并执行宿主 Git    | 未审批执行、把预检目标当作网络安全边界          |
| `session.store`        | 持久化本任务事件、结果和恢复账本                        | 读取或修改其它会话数据                          |

Agent Runtime 已有权限内的工具不调用审批 adapter；越界普通文件工具直接拒绝。`run_with_permissions` 的理由只作为低成本模型或人工判断的依据；分类结果可自动通过、移交人工或拒绝。审批内容必须明确命令将以 Broker 宿主用户权限执行；不存在额外递归根或 HTTPS host 的强制范围。

Capability/Push Runner 及其短期 host-bound proxy token 实现暂不进入产品路径。Broker 宿主命令节点等待进程时，无依赖的其它工具节点仍可并行。Git push 继续独占批次，经 Broker 宿主执行。

IPC 通过只证明 Broker 能拒绝未授权 capability；它不构成直接网络阻断。网络边界始终是账户 SID WFP fence。

## 6. 网络与 Git push

现行路径（D121）：普通 Agent Runtime 没有直接命令网络。全部 Git 工具 action 经认证 IPC 交给 Broker；普通 action 沿用受限参数契约，push 仍是独占批次，由 Broker 使用宿主 Git 查询 upstream、HTTPS URL、OID 和目标 ref，经低成本模型或人工审批后，以宿主用户权限对预检 URL 与 OID/ref 执行一次 push。Broker Git、配置、hook/helper、凭据与网络不受专用账户 WFP、ACL、Job、relay 或 askpass 限制。其结果返回等待中的 Runtime；取消或启动后结果未知时不自动重放。

以下旧 Push Runner/relay 流程为保留代码的历史目标设计，当前产品不调用，也不构成现行 push 的隔离承诺。

普通 Agent Runtime 没有代理网络 lease。WFP 允许它连接固定 loopback relay/proxy 端口，但代理必须因缺少绑定该 `agentRuntimeInstanceId` 的 operation lease 而拒绝；所有其它 connect 由内核按专用账户 SID 阻断。模型请求经认证 Named Pipe 交给 Broker，不向 Runtime 暴露模型 endpoint 或 key。

每次 push：

1. Agent Runtime 用真实 Git 配置查询预期 upstream、HTTPS URL、source OID 和目标 ref；Broker 规范化为 PushSpec，并沿用低成本模型的 `approve | human review | reject` 逐次审批 host/port、时限、字节上限和“该 host 可能收到 Runner 所有可读内容”的风险；只有 `human review` 才移交用户点击确认。
2. Agent Runtime 确认 push 是当前工具批次的唯一节点后，通过认证 Runtime IPC 提交 PushSpec，并让 agent loop 在该请求上同步阻塞。

   Broker 在同一任务下创建新的 `pushRunnerInstanceId`，只运行固定 Git push 入口，不加载 agent loop 或任意 shell；原 Agent Runtime 及其 Job 保持存活，但不获得 Runner 的网络 lease、代理 token、askpass 通道或凭据。其它工作区的 Agent Runtime/Push Runner 可继续运行。

3. Git 连接同 Job 内固定 relay 的一次性 loopback 端点。relay 通过私有 pipe 向 Broker 证明账户 SID、PID/创建时间、固定映像、父进程/Job、PushSpec 摘要和未消费 lease。
4. Broker CONNECT 代理只连接确认的 HTTPS host/port；每个新连接重新解析 DNS，拒绝 loopback、link-local、私网、multicast、保留地址和 metadata endpoint，并执行时限/流量上限。代理不解密 TLS、不解析 Git，因此不承诺 URL path、仓库或 ref 边界。
5. Runner 结束后凭据和 proxy lease 立即失效，relay 关闭；持久 WFP 规则不为 push 临时放宽，也不需要按 PID 增删。

Git 配置若指定自定义 proxy、remote helper 或非登记 transport，只能导致连接被 WFP 拒绝，不能获得直接网络。仍须验证其它本机进程不能复用 relay、代理拒绝错误父进程/PID reuse/过期 lease，以及代理重启安全失败。

## 7. 生命周期、取消与恢复

Sandbox 是优先执行模式，不是任务可用性的硬前置条件。每次任务先在创建任何 Runtime 或投影可写 ACL 前完成只读 preflight；后续 ACL、临时目录和实例对象通过事务化 provision 账本建立。preflight 失败，或 provision 失败后账本能证明 Runtime 尚未启动、全部临时授权已撤销、代理/凭据未签发且没有遗留 Sandbox 副作用时，Broker 必须：

1. 在任务时间线和全局状态区显示醒目警告，说明本任务将以宿主用户权限运行且不具备文件、进程或网络隔离；不要求用户再次确认，自动继续。
2. 持久化受限的失败类别、`sandboxRequested=true`、`sandboxApplied=false` 和 `executionInstance.mode=host-process`；不得记录敏感路径、SID、端口或凭据，也不得把状态显示为 `sandboxed`。
3. 继续沿用宿主模式原有的工具审批、路径检查、Git、取消、并发和恢复规则。fallback 不获得 Sandbox 的写根、无网络或专用 Git push 保证。

自动 fallback 只允许发生在能够证明目标操作尚未执行时。若 Runtime/Push Runner 或其后代已经启动、工具结果未知，或 Job、ACL、代理 lease、凭据及账户状态的清理无法证明完成，当前工具调用不得在宿主模式自动重放。系统记录 `unknown/orphaned`、隔离 account generation 并排空活动实例；只有确认同一工作区不再存在可能继续写入的 Sandbox 进程后，后续任务才可按带警告的宿主模式继续。

这样优先保证后续功能可用，同时不以重复执行换取表面成功。

统一记录 `executionInstance`：

- `mode: windows-sandbox-user | host-process`
- `instanceId`、可空 `pid`、`createdAt`
- Sandbox 模式另含 `kind: agent-runtime | push-runner`
- 按 kind 二选一保存 `agentRuntimeInstanceId` 或 `pushRunnerInstanceId`
- 保存 supervisor PID、进程创建时间、sandbox account generation/SID 摘要、lease epoch、capability SID 摘要、Job ID、映像摘要、AccessManifest 摘要与状态

取消只终止目标实例进程树，不回滚工作区或 Git 副作用，也不取消其它健康任务。确认目标 Job 后代退出及本实例 lease 清理完成记为 `cancelled`；无法确认进程、代理、ACL 或副作用结果记为 `unknown` 或 `orphaned`，并触发整个账户 generation 的隔离/排空。

保存执行是否开始、取消/终止时间、受限部分输出、`sideEffects: may_have_occurred` 和 `replayAllowed: false`，追加到 session 并随下一次模型请求发送。正常结果只返回正在等待的 Agent Runtime；Push Runner 自身不会被重新分类或恢复成 Agent Runtime。

故障 generation 对账完成前不得创建替代实例，仍存活的原 Agent Runtime 也随 generation drain 结束。

## 8. 可观察性与秘密

目标 tracing 至少覆盖 `sandbox.install_attest`、`sandbox.account_generation`、`sandbox.instance_lease`、`sandbox.root_project`、`sandbox.runtime_provision`、`sandbox.supervisor_control`、`sandbox.pushspec_prepare`、`sandbox.push_runner`、`sandbox.proxy_lease`、`broker.relay_attest`、`broker.credential_issue`、`broker.proxy_connect`、`broker.result_sanitize`、`sandbox.root_revoke` 和 `sandbox.instance_release`。

Sandbox 生命周期日志/trace 只保存状态、耗时、数量、kind/profile、关联 ID 和不可逆摘要；不得保存密码、凭据、DPAPI blob、完整 SID、pipe/端口、原始路径、host/IP、命令、源码或工具输出。

任务级 tool trace 对 `run_with_permissions` 只记录 `broker-host` 执行类别和关联 ID，不保存命令或理由；独立 `broker.command` span 记录耗时与终态，不保存路径、输出、凭据或模型内容。

账户/WFP 自检失败必须作为安全告警，并在尚未执行 Sandbox 副作用时进入明确的 `host-process` fallback；无法终止、无法撤销 ACE、账户污染或结果未知仍对当前操作 fail closed，不得自动重放，直到故障 generation 隔离和排空完成。

## 9. 实施与验收

Windows Sandbox 的日常功能验收已按用户持续使用反馈通过（D130）。以下按 D119–D122 的现行产品路径保留分层专项证据与待覆盖场景，不再以这些未穷尽矩阵笼统否定日常可用性，也不将用户确认填充为逐项测试结果。旧 Push Runner/relay 的受限网络目标已暂停，不能据旧代码或测试宣称该目标完成。

| 阶段 | 当前状态 | 尚需证明 |
| ---- | -------- | -------- |
| W0：契约 | 默认 Engine/Runtime/Broker 分流、实例归因、启动前 fallback 和未知结果不重放已接入。 | 故障注入与重启恢复矩阵。 |
| W1：安装与身份 | 固定账户、受保护安装副本、持久 WFP、自检与 Repair 已在当前 Windows 主机运行；安装态产品验收通过。 | 重启、篡改恢复和完整 V4/V6 网络矩阵。 |
| W2：文件与监督 | Supervisor 使用含 execution/root capability 与 Everyone 的 `WRITE_RESTRICTED` token、Job、私有 desktop 和逐对象 ACL；本机真实 token、普通命令及清理已通过。 | 复杂 ACL、对象替换、并发和强制清理；Everyone 可写对象不在完整写根隔离保证内。 |
| W3：Broker IPC | 任务专属 Named Pipe 联合核对 PID、创建时间、Job、token 和固定映像；安装态 Agent Runtime 完整任务已通过。 | 错误客户端、重放、断连与 PID 复用故障矩阵。 |
| W4：本地 Runtime 与扩展命令 | Runtime 承载 agent loop、文件工具和普通命令；`run_with_permissions` 审批后由 Broker 宿主执行；全部 Git 工具 action 由 Broker 宿主执行。 | 越界、复杂路径、敏感日志和超限失败路径。宿主执行不受 Sandbox 限制。 |
| W5：Git push | 旧 Push Runner/relay/askpass 代码暂停；当前 Broker 宿主 Git 预检、逐次审批和本地拒绝夹具已通过。 | 真实 remote、凭据、helper 与 hook 兼容性；不声明受限网络 push。 |
| W6：取消与资源 | 安装态主动取消、任务终态和 clean lease release 已通过。 | 强制终止、服务崩溃、整代排空及资源上限真实验证。 |
| W7：其它平台 | macOS/Linux 不启用 Windows 专用账户后端。 | 各平台独立实现与验证。 |

当前安装态产品链路验收通过，证明这台 Windows 主机上的模拟模型任务、普通命令、Broker 宿主 Git、主动取消和正常清理可完成；用户随后通过一段时间实际使用确认功能正常。两类证据共同支持当前 Windows 日常开发可用性，不证明纯读取或完整写入 allowlist、复杂 ACL/重解析、真实远端 push、强制终止或跨平台边界。

实现阶段按新增安全边界做风险驱动验收，不再把穷举平台边角作为开始实现的前置条件。

每阶段的最小门槛是：W0 安装/卸载、禁用兼容、自检失败提示与安全宿主 fallback；W1 宿主不受影响、Sandbox 直连拒绝、固定 relay 可达；W2 获准根可写、未获准根直接及后代写拒绝、两个并发实例和清理；W3 合法实例通过、错误实例/重放拒绝；W5 真实 Git 对绑定 host 成功且错误 host 失败；W6 正常取消和强制终止都留下可恢复账本并完成进程树清理。

W0 必须分别验证“任何 Runtime 启动前自动 fallback”和“命令已启动/结果未知时不重放”；复杂 ACL、重解析、更多协议、机器重启和故障注入只在对应实现触及该风险或已有证据显示不确定时增加，不能用测试数量替代机制判断。

## 10. 已有证据与待验证范围

以下探针保留为历史机制证据：它们曾证明专用账户/`WRITE_RESTRICTED` 写根与并发、按账户 SID 的动态和持久 WFP fence、联合 IPC 身份→一次性 host lease→relay，以及旧 Git 配置投影方案的局部可行性，不单独构成产品验收。当前产品可用性已有后续固定账户安装态链路与用户实际使用确认；旧 Runner、relay 和配置投影探针不能扩大现行权限保证。后续按实际风险补充专项验证。

[restricted-token demo](../experiments/windows-restricted-token-demo/README.md) 已证明当前机器上普通 Win32 restricted token、Job 和正常 DACL 写限制的窄组合可运行，但它派生自当前用户并使用 capability SID，已不代表目标账户/文件身份模型。

[dedicated sandbox user demo](../experiments/windows-sandbox-user-demo/README.md) 的首次管理员运行已真实创建临时本地账户，并通过两个实例的跨根读取、各自根直接/后代写入和跨根写拒绝；它同时证明两次显式凭据启动复用了相同 logon SID，推翻了 logon SID 唯一假设。

修订夹具随后以独立 execution/root capability SID 和收紧的 account/execution default DACL 通过管理员顺序复测。

按 D100 新契约的第三次管理员运行让两个 Runtime 真正同时存活；双方均保持跨根读取、各自根直接/后代写入和跨根写拒绝，最终报告 `concurrent=yes peerObjectIsolation=not-required crossRead=yes ownWrite=yes crossWriteDenied=yes nestedProcess=yes`。复测后账户与运行目录均清理。

该证据通过 W2 的正常 DACL 双实例并发文件矩阵，不覆盖复杂 ACL、共享 grant、控制面或网络边界。

后续真正并发夹具证明 peer 可成功取得 `PROCESS_TERMINATE`，即使目标 process DACL 同时列出共享账户 SID 与目标 execution SID。原因是 `WRITE_RESTRICTED` 只在评估写访问时考虑 restricting SID，不能假设它覆盖所有 process/thread/Job 权限。

D100 已确认不同对话无需彼此构成 OS 安全边界，因此该结果改记为接受风险；夹具保留 process/thread/Job 危险 open 的观察输出，但通过条件改为两个 Runtime 同时存活时仍保持跨根读取、各自根直接/后代写入和跨根写拒绝。

[network/IPC demo](../experiments/windows-network-ipc-demo/README.md) 已证明 Named Pipe 可联合核对 PID、创建时间、restricted token、execution SID、映像、Job 和 nonce，并只向合法 restricted client 返回一次性 host-bound lease；该客户端随后成功访问 relay，Job 外同映像客户端被拒。

独立状态机还证明错误 lease、错误 host 与消费后重放均拒绝。提升管理员下的动态 V4/V6 `ALE_USER_ID` 矩阵已证明 permit 可绑定账户 SID、loopback 地址与 relay 端口；TCP、带 ACK 的 UDP、真实非回环 IPv4、listen 和 raw bind 在普通账户与 restricted 后代路径均符合 fence，宿主不命中。

dynamic engine 正常关闭或 controller 被强制终止后连接恢复，临时账户和目录清理为 0。持久生命周期探针也已证明 8 条规则在安装进程退出后可枚举自检并继续执行相同核心 fence，正常卸载后连接恢复且重复清理为空。这些仍是机制探针，不代表真实 CONNECT/Git 已完成。APP_ID 路径过滤实验和“需要 callout driver”的旧推论已被本设计取代：目标改用可由内建 WFP 用户条件匹配的专用账户 SID。

平台契约依据：Microsoft 文档确认 `CreateProcessWithLogonW` 默认不加载用户 profile，且可在创建时为 process/thread 提供 security descriptor；access token 包含 logon SID 和用于新对象的 default DACL；restricted token 对 securable object 执行普通 SID 与 restricting SID 两次访问检查。

实测表明同一账户的多次显式凭据启动可共享 logon SID，因此实现只记录其值，不将“每次唯一”作为平台契约。`WRITE_RESTRICTED` 例外、execution SID/default DACL 及对象类型覆盖仍必须逐项实测，不能只依赖文档推断。

- [CreateProcessWithLogonW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw)
- [Access Tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/access-tokens)
- [Restricted Tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens)
- [Process Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights)

当前主机已实测固定账户提升安装、真实 Node Runtime、PowerShell/BCrypt、Broker Git status 与本地 push 拒绝夹具、主动取消和正常清理。尚未实测 WFP 在机器重启后的状态、升级与篡改恢复、复杂 ACL/重解析/其它卷下的写入行为、共享 ACL/journal 的真实并发与崩溃恢复、真实 remote push/凭据/helper、强制取消和资源上限。旧 CONNECT relay 不属于现行产品 push 路径。

安装完成后可显式运行 `pnpm sandbox:runtime:verify`，用模拟模型验证默认产品链中的 agent loop、工作区文件写入、低成本模型审批后的 Broker 宿主命令在 sibling 目录写入且记录为 `host-process`、Agent Runtime 阻塞等待 Broker 宿主 Git 对本机不可用端口的失败结果、主动取消与 clean lease release；该命令不访问公网，也不能证明真实 remote push 或 Broker 宿主执行的 Sandbox 隔离性。

现有 Codex 外层 Sandbox 会干扰嵌套 token/Job/WFP 测试；所有结果必须分别标记“Codex 沙箱内”“批准的宿主权限”“真正提升安装环境”。

## 11. 与现有实现的关系

Runtime factory 在 Windows 使用专用账户原生实现；macOS/Linux 配置会关闭该工厂路径。

UI 已区分 `sandboxed`、`host-process-fallback`、`non-isolated` 和 `unknown`；启动前失败只有在账本与 native 清理都证明回滚后才转为宿主 loop，Runtime started 后的错误不重放。

默认 Windows 组装已接常驻 Agent Runtime launcher：完整 AccessManifest、两阶段 generation/grant、固定 bundle、私有 desktop/Job、联合身份 Named Pipe、首帧、Broker adapter、取消关闭和 orphan drain 进入同一生命周期。

独立 Node harness、单元回归、MSVC build、本机固定账户安装态产品链路以及用户日常使用验证均已有通过记录。Windows Sandbox 可用于日常开发；真实 remote push 和上述故障矩阵仍需专项证据，不宣称无缺陷、完整隔离或跨平台 Sandbox。

原生安装工具入口：

```powershell
pnpm sandbox:native:build
pnpm sandbox:runtime:build
# 若当前 PATH 中不是 Node.js 24 或 26，先指定要复制的可信 Node 24 或 26 executable
$env:CODEATELIER_SANDBOX_RUNTIME_NODE = "C:\Program Files\nodejs\node.exe"
# 以下命令不会自行触发 UAC；先另开“以管理员身份运行”的 PowerShell，进入仓库目录后执行
pnpm sandbox:install
pnpm sandbox:verify
pnpm sandbox:uninstall
# 正常卸载无法证明完整时，仅清理固定产品对象
pnpm sandbox:recover
```

`sandbox:native:build` 只在 `dist/native/windows-x64` 生成启用 CFG/ASLR/DEP 的 fence manager 与 supervisor/bootstrap，`sandbox:runtime:build` 以 Node 24 为兼容基线生成支持 Node 24/26 的 Runtime、三个 Worker ESM bundle 和严格 manifest，两者都不修改机器。

安装脚本固定使用 `CodeAtelierSandbox`、DPAPI 保护的随机密码、`%ProgramData%\CodeAtelier\Sandbox\installation.state` 受限 v4 状态文件、七个安装副本的 SHA-256 和 42871/42872 回环端口；只接受实际报告稳定版 `v24.*.*` 或 `v26.*.*` 的非 reparse Node executable，同名非产品账户会安全拒绝。

恢复脚本只删除已记录 SID 且产品描述匹配的账户、固定 WFP GUID 对象、欢迎屏幕值和受控 ProgramData 子目录，不扫描或重置整机防火墙。v1 state 仅为卸载/恢复兼容而可读，不能通过当前启动 self-check，须用 Repair 升级。
