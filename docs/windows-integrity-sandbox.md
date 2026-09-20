# Windows 专用用户 Sandbox Runtime 与 Broker 架构

状态：已确认的后续 Windows Sandbox 目标设计，尚未实现或完成平台验收。本文替代 D098 的“当前用户 restricted-token 广泛读取”设计；现有 WSL2 `inspect` 和 Windows feasibility demo 只保留为历史或局部证据。

## 1. 目标与安全边界

Windows Runtime 使用安装程序预先创建的单一低权限本地账户 `CodeAtelierSandbox`。所有 Agent Runtime、Git、hook、helper 与后代都在该账户身份及其 restricted token/Job 中运行。宿主 Broker 保留模型密钥、会话存储、审批、外部写入和真实网络能力。

目标能力：

- 不继承宿主交互用户的 profile、凭据和仅授予该用户的文件权限；AccessManifest 再向专用账户增加工作区、显式只读根、精确 Git 配置图和产品 Runtime 依赖的访问权。它不是纯读取 allowlist：`Everyone`、`Authenticated Users`、机器级安装目录或其他既有 DACL 仍可能允许读取，必须在 UI 中明确。
- 写访问同时经过专用账户 DACL 与 `WRITE_RESTRICTED` token 的 restricting SID 检查；每个可写根使用独立 capability SID/ACE。目标写范围是工作区、显式可写根和实例临时目录，但弱/null DACL、为兼容启动保留的宽泛 SID及非文件对象必须实测并作为残余风险报告。
- 工作区内部不额外保护 `.git`、`.env` 或其他子路径；命令可以修改、删除或泄露工作区内的可访问内容，取消不回滚。
- 机器级 WFP 规则按专用账户 SID 阻止直接出站，只允许连接受控回环 relay/proxy 端口；模型和获准网络由 Broker 代理。
- 全部 Git 在 Runtime 内执行，Broker 不执行 Git。Git 读取已授权的 system、宿主 global/include、local 和 worktree 配置；配置、hook、helper 和 remote helper 都视为不可信代码。
- Broker IPC、回环代理和凭据管道必须再次验证 execution instance；账户 SID 只是机器级隔离身份，不单独授权任务能力。

单一账户同时只能租给一个 Sandbox execution instance。因此启用本 profile 后，所有 Sandbox 任务跨工作区全局串行；非 Sandbox 模式仍使用现有 1～4 并发设置。Agent Runtime 切换为同任务 Push Runner 时复用该账户，但必须先证明原 Job 全部退出。本文不设计账户池。

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
  |-- model / storage / external.write / network proxy adapters
  |-- 专属 Named Pipe：验证 SID + PID/创建时间 + Job + nonce/lease
  |
  `-- C++ supervisor
        |-- 独占 CodeAtelierSandbox 账户租约
        |-- CreateProcessWithLogonW（不加载 profile）两段启动 + restricted token
        |-- 私有 desktop、Job、mitigation、资源与取消
        `-- Agent Runtime 或单用途 Push Runner
              |-- 账户既有读取权 + 工作区、显式 read/write roots、精确 Git config graph
              |-- 本地 Git、hook/helper、Node、shell、编译器
              `-- WFP：仅可达受控 loopback relay/proxy 端口

提升安装程序（一次性/维护时）
  |-- 创建专用账户、随机密码和受保护凭据
  |-- 配置最小登录权限与独立 profile
  `-- 安装/对账按账户 SID 的持久 WFP V4/V6 规则
```

Broker、supervisor、安装程序和 Sandbox Process 是不同边界。运行时 Broker 默认不提升；账户/WFP/本地策略的创建、修复和删除只由显式 UAC 安装流程执行。任何组件不可把任意命令、SID、路径、ACL、socket 或原始 handle 暴露为通用高权限接口。

## 3. 安装、账户与启动

### 3.1 一次性提升安装

安装程序创建一个固定本地账户；名称只是诊断标签，授权以安装时记录并复证的 SID 为准。该账户：

- 使用随机高熵密码；密码只以 Windows DPAPI/等价系统保护形式保存，存储 DACL 只允许 SYSTEM 和安装该实例的宿主用户，绝不进入 argv、环境、日志、session 或工作区。
- 不加入 Administrators。首版使用普通 Broker 可调用的 `CreateProcessWithLogonW` 创建本地账户进程，因此不能同时配置 `SeDenyInteractiveLogonRight`；账户以高熵秘密、隐藏欢迎屏幕入口、禁止远程交互/网络/服务登录和 WFP fence 降低被其它入口使用的风险。若本机或域策略禁止这种本地 logon，安装失败；后续若改用提升服务与 batch logon，必须另行审计高权限控制面。
- 不加载宿主用户 profile，不继承其 cookie、SSH agent、凭据管理器、证书私钥或已打开 handle。默认不加载持久 Sandbox profile hive；每个 lease 使用新建的私有 `HOME`/`USERPROFILE`/`XDG_CONFIG_HOME`/`TEMP` 目录。若真实工具兼容性迫使加载专用账户 profile/HKCU，必须先定义可证明的逐租约重置流程，重置失败即隔离账户，不能让前一任务持久化配置影响下一任务。
- 卸载前必须证明无活跃租约，再撤销 WFP、ACL、profile、secret 和账户；任一步骤失败都报告遗留安全状态。

安装程序在 `ALE_AUTH_CONNECT_V4/V6` 安装按账户 SID 匹配的持久规则：只允许受控的固定 loopback relay/proxy 端口范围，拒绝其它出站连接。UDP、IPv6、raw socket、DNS、bind/listen 和 loopback 必须逐项验证；默认不开放任意 loopback 或开发服务器端口。启动前自检账户 SID、规则 ID、层、权重、动作、端口和 V4/V6 覆盖；状态未知或被策略软件覆盖时 Sandbox 不启动。

### 3.2 租约、两段启动与清理

Broker 为单一账户持有全局排他租约，记录 SID 摘要、task/workspace、创建时间、Job ID 和 lease epoch。supervisor 以 `CreateProcessWithLogonW` 且不使用 `LOGON_WITH_PROFILE` 启动固定 runner；runner 再从专用账户 token 创建 `WRITE_RESTRICTED` primary token：移除非必要 privilege/group，并只加入本次可写根的 capability restricting SID 与经实测不可省略的最小兼容 SID。目标以 suspended 状态创建，绑定 Job、desktop 和 mitigation 后才恢复执行；不能证明 token SID 集合与 AccessManifest 一致时终止启动。安装验收必须实测该两段启动在支持的 Windows/域策略上不需要运行时提升。

所有后代必须留在 `KILL_ON_JOB_CLOSE` Job。计划任务、BITS、服务、COM、父进程伪装和现存宿主进程代写必须作为逃逸夹具验证。即使后代逃离 Job，只要仍使用专用账户 SID，持久 WFP 仍应阻止其直接外网；这不免除进程和文件逃逸修复。

租约释放前必须完成 Job 终止、代理关闭、短期凭据失效、精确 ACE 撤销和对象对账。任一步骤无法证明完成则账户进入 `orphaned/quarantined`，所有后续 Sandbox 任务停止，直到修复或重新安装；绝不带着旧授权复用账户。

## 4. 文件访问与 Git 配置

### 4.1 AccessManifest 与 ACL

每次执行生成不可变 AccessManifest：

- `readWriteRoots`：当前工作区、用户明确添加的可写目录、实例私有临时目录。
- `readOnlyRoots`：用户明确添加的源码/工具目录、产品固定 Runtime/工具依赖；这是新增授权清单，不代表专用账户没有其他既有只读 ACL。
- `gitConfigFiles`：宿主用户实际存在的标准 global config 和经受限解析得到的 include/includeIf 普通文件图。
- 每项包含规范路径、访问模式、卷标识、`FILE_ID_128`、重解析状态、原始 DACL 摘要和本次 ACE delta。

Broker 以不跟随重解析点的方式打开原对象并保留 Broker-only handle。只读根为专用账户 SID 添加最小读取/遍历 ACE；可写根同时为专用账户 SID 和该根 capability SID 添加所需 ACE，并在 token 中只放入本次根 SID。根 ACE 带经过验证的 object/container 继承标志；预检枚举拒绝或显式处理关闭继承、deny ACE 与不能被继承覆盖的现存子对象，不能只改根后假设整棵树可用。不改 owner，不替换整体 DACL。撤销只作用于启动时记录的原对象/ACE delta；rename/move 后仍定位原对象，路径替换或删除重建的新对象不误改。无法定位、撤销或复证时锁定工作区并隔离账户。

专用账户不继承只授予宿主交互用户的 profile、其它源码和用户级工具权限，但仍可能通过 `Everyone`、`Authenticated Users` 或其它既有 DACL 读取系统/共享对象。缺少依赖时产品显示实际拒绝路径，由用户显式增加只读根或改用机器级安装；不得自动授权整个 `%USERPROFILE%`、盘符根、`Users` 目录、凭据目录或任意父目录。UI 必须同时显示显式 read roots 和“机器既有 ACL 可能额外允许读取”的限制；任何可读内容都可能进入模型请求、session 或获准网络。

### 4.2 Git 配置与凭据

Git 在真实工作区运行，local/worktree 配置和工作区内 hook/helper/filter/attributes 正常生效。system config 和机器级 Git 安装按普通系统 ACL 读取。为保留宿主 global 配置语义，AccessManifest 默认精确只读授权：

- `%USERPROFILE%\.gitconfig`
- `%USERPROFILE%\.config\git\config`
- 对当前工作区实际成立的 `include`/`includeIf` 普通文件

Broker 的受限解析器只建立文件授权图，不计算 push 目标、不执行 Git、helper 或外部程序。循环、数量/深度超限、UNC、设备路径、reparse point、对象替换或无法稳定打开时拒绝启动。配置文件只读，因此 `git config --global` 默认失败；写 global config 属于工作区外写入。

Sandbox 的 `HOME`、`USERPROFILE` 和 `XDG_CONFIG_HOME` 指向本次 lease 的私有目录。产品在该目录生成只包含两个宿主 global config 入口、顺序固定的只读聚合 config，并以 `GIT_CONFIG_GLOBAL` 指向它；Git 自身继续解析获准文件中的 include/includeIf，Broker 预解析仅用于先建立授权图。该机制替代默认 global 文件发现，但不禁用 system、local/worktree config，也不对白名单键。两个入口的顺序、与 system/local/worktree 的优先级、includeIf 路径条件、helper 和证书路径必须用真实 Git 夹具证明；不能证明等价时 Sandbox Git 安全拒绝，而不是改用宿主 HOME。

宿主用户的 Credential Manager、SSH agent、用户证书私钥和 per-user helper 状态不会自动可用。HTTPS push 凭据由 Broker 的固定 askpass/credential adapter 按 lease 提供；真实配置中的 helper 仍可能运行，但只能看到 Sandbox 身份获准访问的状态。首版不支持 SSH push。

## 5. 进程、IPC 与 Broker 能力

supervisor 只接受 Broker 创建的私有继承控制 handle 或同等强度通道上的固定 schema；Runtime 不能连接 supervisor 控制面，IPC 不返回原始 process、Job、token 或文件 handle。Broker 断连、heartbeat/租约过期或实例身份无法复证时，supervisor 关闭 Job；失败进入 `orphaned` 并隔离账户与工作区。

Runtime 与 Broker 使用任务专属 Named Pipe。pipe DACL 只允许宿主 Broker 用户和专用账户 SID；Broker 再从连接取得真实 PID，联合核对启动时 process handle、创建时间、账户 SID、restricted token 标志、实际映像、Job、nonce、task/tool-call、kind 和 lease epoch。PID、账户 SID、pipe 名称、端口或 Runtime 自报字段都不单独授权。

Broker 只提供参数受限的 typed operation：

| 类别              | 允许                                                    | 禁止                                              |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------- |
| `model.request`   | 使用宿主固定模型配置发送受限 Responses 请求             | 暴露 API key、任意 URL/认证头或通用 HTTP tunnel   |
| `external.write`  | 对用户确认的单一工作区外对象执行版本化创建/精确编辑     | 任意 shell、递归复制或目录级写入                  |
| `network.fetch`   | 对明确批准的 HTTPS 读取执行 host/DNS/IP/重定向/大小审查 | 通用 socket、内网、metadata、监听或默认上传       |
| `git.push.egress` | 管理 PushSpec、Push Runner、relay 和短期凭据            | 执行 Git、解析 Git 协议或承诺 path/ref 是网络边界 |
| `session.store`   | 持久化本任务事件、结果和恢复账本                        | 读取或修改其它会话数据                            |

IPC 通过只证明 Broker 能拒绝未授权 capability；它不构成直接网络阻断。网络边界始终是账户 SID WFP fence。

## 6. 网络与 Git push

普通 Agent Runtime 没有代理网络 lease。WFP 允许它连接固定 loopback relay/proxy 端口，但代理必须因缺少绑定该 `agentRuntimeInstanceId` 的 operation lease 而拒绝；所有其它 connect 由内核按专用账户 SID 阻断。模型请求经认证 Named Pipe 交给 Broker，不向 Runtime 暴露模型 endpoint 或 key。

每次 push：

1. Agent Runtime 用真实 Git 配置查询预期 upstream、HTTPS URL、source OID 和目标 ref；Broker 规范化为 PushSpec，并由用户逐次确认 host/port、时限、字节上限和“该 host 可能收到 Runner 所有可读内容”的风险。
2. Broker 停止 Agent Runtime、确认 Job 为空并锁定工作区；同一账户租约下创建新的 `pushRunnerInstanceId`，只运行固定 Git push 入口，不加载 agent loop 或任意 shell。
3. Git 连接同 Job 内固定 relay 的一次性 loopback 端点。relay 通过私有 pipe 向 Broker 证明账户 SID、PID/创建时间、固定映像、父进程/Job、PushSpec 摘要和未消费 lease。
4. Broker CONNECT 代理只连接确认的 HTTPS host/port；每个新连接重新解析 DNS，拒绝 loopback、link-local、私网、multicast、保留地址和 metadata endpoint，并执行时限/流量上限。代理不解密 TLS、不解析 Git，因此不承诺 URL path、仓库或 ref 边界。
5. Runner 结束后凭据和 proxy lease 立即失效，relay 关闭；持久 WFP 规则不为 push 临时放宽，也不需要按 PID 增删。

Git 配置若指定自定义 proxy、remote helper 或非登记 transport，只能导致连接被 WFP 拒绝，不能获得直接网络。仍须验证其它本机进程不能复用 relay、代理拒绝错误父进程/PID reuse/过期 lease，以及代理重启安全失败。

## 7. 生命周期、取消与恢复

统一记录 `executionInstance`：

- `mode: windows-sandbox-user | host-process`
- `instanceId`、可空 `pid`、`createdAt`
- Sandbox 模式另含 `kind: agent-runtime | push-runner`
- 按 kind 二选一保存 `agentRuntimeInstanceId` 或 `pushRunnerInstanceId`
- 保存 supervisor PID、进程创建时间、sandbox account SID 摘要、lease epoch、Job ID、映像摘要、AccessManifest 摘要与状态

取消终止进程树但不回滚工作区或 Git 副作用。确认 Job 后代退出记为 `cancelled`；无法确认进程、代理、ACL 或副作用结果记为 `unknown` 或 `orphaned`。保存执行是否开始、取消/终止时间、受限部分输出、`sideEffects: may_have_occurred` 和 `replayAllowed: false`，追加到 session 并随下一次模型请求发送。Push Runner 不能恢复成 Agent Runtime，账户对账完成前不得创建替代实例。

## 8. 可观察性与秘密

目标 tracing 至少覆盖 `sandbox.install_attest`、`sandbox.account_lease`、`sandbox.root_project`、`sandbox.runtime_provision`、`sandbox.supervisor_control`、`sandbox.runtime_lease`、`sandbox.pushspec_prepare`、`sandbox.push_runner`、`sandbox.proxy_lease`、`broker.relay_attest`、`broker.credential_issue`、`broker.proxy_connect`、`broker.result_sanitize`、`sandbox.root_revoke` 和 `sandbox.account_release`。

日志/trace 只保存状态、耗时、数量、kind/profile、关联 ID 和不可逆摘要；不得保存密码、凭据、DPAPI blob、完整 SID、pipe/端口、原始路径、host/IP、命令、源码或工具输出。账户/WFP 自检失败、无法终止、无法撤销 ACE、账户污染或额外访问面必须作为安全告警并 fail closed。

## 9. 实施与验收

| 阶段           | 交付物                                                              | 必要证据                                                                                                       |
| -------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| W0：契约       | AccessManifest、executionInstance、串行语义、风险文案、禁用模式兼容 | 当前实现与目标 profile 不混淆；开关失败关闭                                                                    |
| W1：安装与身份 | 单一账户、secret、本地策略、WFP fence、自检/卸载                    | 宿主用户网络不受影响；Sandbox SID 的 V4/V6 直接出站均阻断；loopback 只到固定端点                               |
| W2：文件与监督 | ACL 租约、`WRITE_RESTRICTED` token、private desktop、Job、heartbeat | 显式只读/读写根准确；宿主私有 profile/项目不可读写；既有公共 ACL 如实盘点；后代/宿主代写不逃逸；孤儿账户不复用 |
| W3：Broker IPC | pipe 身份、typed capability、配额、模型/session adapter             | 重放、错误映像/Job/token、畸形帧安全拒绝                                                                       |
| W4：外部写入   | 版本化单对象写入、结果清洗、审批绑定                                | TOCTOU、reparse、对象替换、敏感日志和超限失败路径                                                              |
| W5：Git push   | PushSpec、单用途 Runner、relay/proxy、短期凭据                      | 无 WFP 临时放宽；其它进程不能复用；仅确认 host 可达；真实 Git 配置绕过失败关闭                                 |
| W6：取消与资源 | 统一账本、CPU/内存/PID/输出/墙钟限制                                | cancelled/unknown 进入下一轮；后代终止、ACL/账户对账和资源上限真实验证                                         |
| W7：其它平台   | macOS/Linux 对应实现                                                | 各平台独立证明，不继承 Windows 结论                                                                            |

W1--W3 通过后才能声明“Windows 专用用户 Sandbox：宿主用户私有权限不继承、显式根授权、目标写边界、无直接命令网络、Broker 能力认证”；不得声明纯读取 allowlist。W5 前不支持受限 push，W6 前不声明已验证取消和资源边界。管理员安装成功不等于 Runtime 验收完成。

必测项包括：密码/策略轮换、欢迎屏幕隐藏、远程/网络/服务登录拒绝、本地程序化 logon、域策略覆盖、UAC 拒绝、全局串行、Broker/机器重启、ACL 原对象 rename/move/replace/delete-recreate、弱/null DACL、Everyone/Users 写、显式 deny、继承关闭、junction/symlink/mount point、UNC/其它盘、hard link、机器级与用户级工具、Git includeIf/helper/hook/remote helper、IPv4/IPv6/TCP/UDP/DNS/loopback/listen、代理复用和卸载残留。

## 10. 已有证据与待验证范围

[restricted-token demo](../experiments/windows-restricted-token-demo/README.md) 已证明当前机器上普通 Win32 restricted token、Job 和正常 DACL 写限制的窄组合可运行，但它派生自当前用户并使用 capability SID，已不代表目标账户/文件身份模型。

[network/IPC demo](../experiments/windows-network-ipc-demo/README.md) 已证明 Named Pipe 可联合核对 PID、创建时间、restricted token、execution SID、映像、Job 和 nonce，并证明普通 medium-integrity Broker 无权安装 WFP policy。其 APP_ID 路径过滤实验和“需要 callout driver”的旧推论已被本设计取代：目标改用可由内建 WFP 用户条件匹配的专用账户 SID。

尚未实测：账户创建/登录、专用 profile、按 SID 的持久 WFP allow/block、自检与卸载、宿主 global Git config 授权图、真实 Git/Node/PowerShell/编译器兼容、relay/proxy、凭据、ACL 撤销、取消/恢复和资源上限。现有 Codex 外层 Sandbox 会干扰嵌套 token/Job/WFP 测试；所有结果必须分别标记“Codex 沙箱内”“批准的宿主权限”“真正提升安装环境”。

## 11. 与现有实现的关系

现有 WSL2 bubblewrap `inspect` Runtime 是历史实现，不是 fallback 或验收替代。迁移期间 UI 必须区分 `legacy-wsl2-inspect`、`windows-sandbox-user`、`non-isolated` 和 `unknown`。账户、WFP、ACL、Job、IPC 或代理自检任一失败时 Sandbox 模式安全拒绝，不能静默转为宿主权限。
