# Windows 专用用户 Sandbox Runtime 与 Broker 架构

状态：已确认的后续 Windows Sandbox 目标设计，尚未实现或完成平台验收。本文替代 D098 的“当前用户 restricted-token 广泛读取”设计；现有 WSL2 `inspect` 和 Windows feasibility demo 只保留为历史或局部证据。

## 1. 目标与安全边界

Windows Runtime 使用安装程序预先创建的单一低权限本地账户 `CodeAtelierSandbox`。所有 Agent Runtime、Git、hook、helper 与后代都在该账户身份及其 restricted token/Job 中运行。宿主 Broker 保留模型密钥、会话存储、审批、外部写入和真实网络能力。

目标能力：

- 不继承宿主交互用户的 profile、凭据和仅授予该用户的文件权限；AccessManifest 再向专用账户增加工作区、显式只读根、精确 Git 配置图和产品 Runtime 依赖的访问权。它不是纯读取 allowlist：`Everyone`、`Authenticated Users`、机器级安装目录或其他既有 DACL 仍可能允许读取，必须在 UI 中明确。
- 写访问同时经过专用账户 DACL 与 `WRITE_RESTRICTED` token 的 restricting SID 检查；每个实例拥有独立 execution capability，每个可写根另使用独立 root capability SID/ACE。Windows 可能为同一账户的多次显式凭据启动复用 logon SID，故只记录它用于诊断/兼容，绝不作为文件写入 capability。目标写范围是工作区、显式可写根和实例临时目录。若兼容启动需要 `Everyone` 等宽泛 restricting SID，写根上任何能被它匹配的写 ACE 都会破坏根 capability；预检必须拒绝这类根，且不能证明完整组合时不得启用 Sandbox 并发。
- 工作区内部不额外保护 `.git`、`.env` 或其他子路径；命令可以修改、删除或泄露工作区内的可访问内容，取消不回滚。
- 机器级 WFP 规则按专用账户 SID 阻止直接出站，只允许连接受控回环 relay/proxy 端口；模型和获准网络由 Broker 代理。
- 全部 Git 在 Runtime 内执行，Broker 不执行 Git。Git 读取已授权的 system、宿主 global/include、local 和 worktree 配置；配置、hook、helper 和 remote helper 都视为不可信代码。
- Broker IPC、回环代理和凭据管道必须再次验证 execution instance；账户 SID 只是机器级隔离身份，不单独授权任务能力。

Sandbox 模式沿用现有全局并发设置：不同真实工作区最多同时运行 1～4 个任务，同一真实工作区仍严格串行。每个 execution instance 使用独立 capability SID、Job、private desktop、临时目录、IPC nonce 和 proxy lease；Agent Runtime 切换为同任务 Push Runner 时只要求该任务的原 Job 全部退出，不暂停其它工作区任务。本文仍只使用一个本地账户，不设计账户池，也不因 Sandbox 启用而把全部对话全局串行。

单账户并发不提供任务间 OS 安全隔离。为了让该账户访问每个活动工作区，所有同账户 Runtime 都可能通过账户 SID 读取其它并发任务当前投影的工作区、Git 配置和 read roots；同账户 peer 还可能打开、终止、注入、调试或检查其它 Runtime/Job/desktop/命名对象。`WRITE_RESTRICTED` 的每实例 capability SID 只承诺把直接及后代文件写检查限制到本实例可写根，不承诺进程或对象隔离。Broker/session API 仍按任务路由以维持正常产品行为，但不宣称抵抗恶意 peer 冒用或干扰另一个任务；需要该保证时必须改用账户池、AppContainer 或 VM profile。

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
        |-- CodeAtelierSandbox 账户 generation + 多实例 lease registry
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

### 3.2 实例租约、两段启动与清理

Broker 为单一账户维护一个 account generation 和最多 1～4 个活动 instance lease；每项记录 SID 摘要、instance/task/workspace、创建时间、Job ID、execution/root capability SID 集合和 lease epoch。调度器在发放 lease 前复核不同工作区、全局并发上限及所有活动授权状态。supervisor 以 `CreateProcessWithLogonW` 且不使用 `LOGON_WITH_PROFILE` 启动固定 runner；每次启动记录实际 logon SID/LUID，但不要求唯一，也不以其授权。runner 再从专用账户 token 创建 `WRITE_RESTRICTED` primary token：移除非必要 privilege/group，并加入本实例独立 execution SID、本次可写根 capability SID 与经实测不可省略的 logon/Everyone 等最小兼容 SID。目标以 suspended 状态创建，绑定本实例 Job、desktop 和 mitigation 后才恢复执行；不能证明 token SID 集合与 AccessManifest 一致时终止启动。

bootstrap runner 的创建控制面和 supervisor 必须只允许 Broker/SYSTEM；Sandbox Runtime 不得连接 supervisor、取得其高权限 handle 或请求任意 SID/路径/ACL/进程操作。runner 为 restricted token 设置显式 default DACL，仅向共享账户 SID 和本实例 execution SID 授予正常运行所需访问，不向可能共享的 logon SID、Everyone 或 root capability 授予新对象通用权限。后代 process/thread/token/Job/pipe/命名对象和 private desktop/window station 继续使用最小 DACL 以减少偶然干扰，但不把它们描述成对同账户恶意 peer 的隔离边界。peer 的 handle、debug、window message、注入和命名对象访问必须观测并记录为残余风险，不再作为禁止 Sandbox 并发的门槛。安装验收仍须证明两段启动在支持的 Windows/域策略上不需要运行时提升。

所有后代必须留在 `KILL_ON_JOB_CLOSE` Job。计划任务、BITS、服务、COM、父进程伪装和现存宿主进程代写必须作为逃逸夹具验证。即使后代逃离 Job，只要仍使用专用账户 SID，持久 WFP 仍应阻止其直接外网；这不免除进程和文件逃逸修复。

每个实例 lease 释放前必须完成其 Job 终止、代理关闭、短期凭据失效、capability ACE 撤销和对象对账。账户 SID 的共享 read/normal-side ACE 由以对象身份和访问模式为键的引用计数 grant table 管理，只有最后一个引用释放时才撤销；不得因一个任务结束而破坏另一活动任务。任一步骤无法证明完成则账户 generation 进入 `orphaned/quarantined`：停止接受新任务，终止并对账该账户下全部活动实例，直到修复或重新安装；绝不只释放故障 workspace 后继续复用账户。

## 4. 文件访问与 Git 配置

### 4.1 AccessManifest 与 ACL

每次执行生成不可变 AccessManifest：

- `readWriteRoots`：当前工作区、用户明确添加的可写目录、实例私有临时目录。
- `readOnlyRoots`：用户明确添加的源码/工具目录、产品固定 Runtime/工具依赖；这是新增授权清单，不代表专用账户没有其他既有只读 ACL。
- `gitConfigFiles`：宿主用户实际存在的标准 global config 和经受限解析得到的 include/includeIf 普通文件图。
- 每项包含规范路径、访问模式、卷标识、`FILE_ID_128`、重解析状态、原始 DACL 摘要和本次 ACE delta。

Broker 以不跟随重解析点的方式打开原对象并保留 Broker-only handle。只读根为专用账户 SID 添加最小读取/遍历 ACE；可写根同时为专用账户 SID 和该实例的根 capability SID 添加所需 ACE，并在 token 中只放入本实例根 SID。账户 SID 的普通访问检查因此形成所有活动 manifest 的读取并集；写访问还必须通过 `WRITE_RESTRICTED` 的 capability 检查，另一实例只应能读而不能写本根。预检必须计算整个有效 DACL，拒绝 null DACL 或任何能被本 token 的宽泛兼容 restricting SID 匹配的写 ACE。根 ACE 带经过验证的 object/container 继承标志；预检枚举拒绝或显式处理关闭继承、deny ACE 与不能被继承覆盖的现存子对象，不能只改根后假设整棵树可用。不改 owner，不替换整体 DACL。撤销只作用于启动时记录的原对象/ACE delta 和 grant-table 引用；rename/move 后仍定位原对象，路径替换或删除重建的新对象不误改。无法定位、撤销或复证时锁定相关工作区并隔离整个账户 generation。

专用账户不继承只授予宿主交互用户的 profile、其它源码和用户级工具权限，但仍可能通过 `Everyone`、`Authenticated Users` 或其它既有 DACL 读取系统/共享对象。缺少依赖时产品显示实际拒绝路径，由用户显式增加只读根或改用机器级安装；不得自动授权整个 `%USERPROFILE%`、盘符根、`Users` 目录、凭据目录或任意父目录。UI 必须同时显示显式 read roots 和“机器既有 ACL 可能额外允许读取”的限制；任何可读内容都可能进入模型请求、session 或获准网络。

### 4.2 Git 配置与凭据

Git 在真实工作区运行，local/worktree 配置和工作区内 hook/helper/filter/attributes 正常生效。system config 和机器级 Git 安装按普通系统 ACL 读取。为保留宿主 global 配置语义，AccessManifest 默认精确只读授权：

- `%USERPROFILE%\.gitconfig`
- `%USERPROFILE%\.config\git\config`
- 对当前工作区实际成立的 `include`/`includeIf` 普通文件

Broker 的受限解析器只建立文件授权图，不计算 push 目标、不执行 Git、helper 或外部程序。循环、数量/深度超限、UNC、设备路径、reparse point、对象替换或无法稳定打开时拒绝启动。配置文件只读，因此 `git config --global` 默认失败；写 global config 属于工作区外写入。

Sandbox 的 `HOME`、`USERPROFILE` 和 `XDG_CONFIG_HOME` 指向本次 lease 的私有可写目录。顺序固定的聚合 config 位于 Broker 控制、Runtime 只读且父目录不可写的投影根，并以 `GIT_CONFIG_GLOBAL` 指向它；不能把聚合文件放进可写 HOME 后只收紧文件 ACL，因为 Git/Runtime 仍可能通过父目录替换对象。Git 自身继续解析获准文件中的 include/includeIf，Broker 预解析仅用于先建立授权图。该机制替代默认 global 文件发现，但不禁用 system、local/worktree config，也不对白名单键。真实 Git 最小夹具已通过 system、两个 global 入口、匹配 includeIf、local、worktree 的加载顺序，并证明私有 HOME decoy 不加载、global 写入失败；宿主真实配置图、helper 和证书路径仍须在实现阶段验证，不能证明等价时安全拒绝。

宿主用户的 Credential Manager、SSH agent、用户证书私钥和 per-user helper 状态不会自动可用。HTTPS push 凭据由 Broker 的固定 askpass/credential adapter 按 lease 提供；真实配置中的 helper 仍可能运行，但只能看到 Sandbox 身份获准访问的状态。首版不支持 SSH push。

## 5. 进程、IPC 与 Broker 能力

supervisor 只接受 Broker 创建的私有继承控制 handle 或同等强度通道上的固定 schema；Runtime 不能连接 supervisor 控制面，IPC 不返回原始 process、Job、token 或文件 handle。Broker 断连、heartbeat/租约过期或实例身份无法复证时，supervisor 关闭本实例 Job；任一实例失败进入 `orphaned` 后隔离 account generation，并排空其它活动实例。

Runtime 与 Broker 使用任务专属 Named Pipe。pipe DACL 同时要求宿主 Broker 身份，或专用账户 SID 加本实例 execution SID；Broker 再从连接取得真实 PID，联合核对启动时 process handle、创建时间、账户 generation、restricted token/capability SID、实际映像、实例 Job、nonce、task/tool-call、kind 和 lease epoch。PID、账户 SID、logon SID、pipe 名称、端口或 Runtime 自报字段都不单独授权；正常的另一实例连接必须因 execution capability/Job/nonce/lease 不匹配而被拒绝，以保证路由和审计正确。由于恶意 peer 可能注入或操纵合法目标 Runtime，这不是任务间对抗性认证边界；真正的安全边界是任何 Sandbox 进程都不能越过 typed Broker operation、宿主 ACL 与 WFP fence。

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
2. Broker 只停止当前任务的 Agent Runtime、确认其 Job 为空并继续锁定该工作区；在同一任务 lease 下创建新的 `pushRunnerInstanceId`，只运行固定 Git push 入口，不加载 agent loop 或任意 shell。其它工作区的 Agent Runtime/Push Runner 可继续运行。
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
- 保存 supervisor PID、进程创建时间、sandbox account generation/SID 摘要、lease epoch、capability SID 摘要、Job ID、映像摘要、AccessManifest 摘要与状态

取消只终止目标实例进程树，不回滚工作区或 Git 副作用，也不取消其它健康任务。确认目标 Job 后代退出及本实例 lease 清理完成记为 `cancelled`；无法确认进程、代理、ACL 或副作用结果记为 `unknown` 或 `orphaned`，并触发整个账户 generation 的隔离/排空。保存执行是否开始、取消/终止时间、受限部分输出、`sideEffects: may_have_occurred` 和 `replayAllowed: false`，追加到 session 并随下一次模型请求发送。Push Runner 不能恢复成 Agent Runtime，故障 generation 对账完成前不得创建替代实例。

## 8. 可观察性与秘密

目标 tracing 至少覆盖 `sandbox.install_attest`、`sandbox.account_generation`、`sandbox.instance_lease`、`sandbox.root_project`、`sandbox.runtime_provision`、`sandbox.supervisor_control`、`sandbox.pushspec_prepare`、`sandbox.push_runner`、`sandbox.proxy_lease`、`broker.relay_attest`、`broker.credential_issue`、`broker.proxy_connect`、`broker.result_sanitize`、`sandbox.root_revoke` 和 `sandbox.instance_release`。

日志/trace 只保存状态、耗时、数量、kind/profile、关联 ID 和不可逆摘要；不得保存密码、凭据、DPAPI blob、完整 SID、pipe/端口、原始路径、host/IP、命令、源码或工具输出。账户/WFP 自检失败、无法终止、无法撤销 ACE、账户污染或额外访问面必须作为安全告警并 fail closed。

## 9. 实施与验收

| 阶段           | 交付物                                                                                      | 必要证据                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| W0：契约       | AccessManifest、executionInstance、1～4 并发/同工作区串行、跨任务读取/进程干扰风险、禁用模式兼容 | 当前实现与目标 profile 不混淆；开关失败关闭                                                                                               |
| W1：安装与身份 | 单一账户、secret、本地策略、WFP fence、自检/卸载                                            | 宿主用户网络不受影响；Sandbox SID 的 V4/V6 直接出站均阻断；loopback 只到固定端点                                                             |
| W2：文件与监督 | ACL/grant table、`WRITE_RESTRICTED` token/default DACL、每实例 execution/root capability/desktop/Job | 并发实例互相可读且可能互相干扰，但直接及后代不可跨 capability 根写入；共享 logon/宽泛兼容 SID 不绕过写边界；共享 ACE 正确引用计数；孤儿 generation 全量排空 |
| W3：Broker IPC | pipe 身份、typed capability、配额、模型/session adapter                                     | 重放、错误映像/Job/token、畸形帧安全拒绝                                                                                                     |
| W4：外部写入   | 版本化单对象写入、结果清洗、审批绑定                                                        | TOCTOU、reparse、对象替换、敏感日志和超限失败路径                                                                                            |
| W5：Git push   | PushSpec、单用途 Runner、relay/proxy、短期凭据                                              | 无 WFP 临时放宽；其它进程不能复用；仅确认 host 可达；真实 Git 配置绕过失败关闭                                                               |
| W6：取消与资源 | 统一账本、CPU/内存/PID/输出/墙钟限制                                                        | cancelled/unknown 进入下一轮；后代终止、ACL/账户对账和资源上限真实验证                                                                       |
| W7：其它平台   | macOS/Linux 对应实现                                                                        | 各平台独立证明，不继承 Windows 结论                                                                                                          |

W1--W3 通过后才能声明“Windows 专用用户 Sandbox：宿主用户私有权限不继承、显式根授权、目标写边界、无直接命令网络、Broker 能力认证”；不得声明纯读取 allowlist。W5 前不支持受限 push，W6 前不声明已验证取消和资源边界。管理员安装成功不等于 Runtime 验收完成。

实现阶段按新增安全边界做风险驱动验收，不再把穷举平台边角作为开始实现的前置条件。每阶段的最小门槛是：W0 安装/卸载与禁用兼容；W1 宿主不受影响、Sandbox 直连拒绝、固定 relay 可达；W2 获准根可写、未获准根直接及后代写拒绝、两个并发实例和清理；W3 合法实例通过、错误实例/重放拒绝；W5 真实 Git 对绑定 host 成功且错误 host 失败；W6 正常取消和强制终止都留下可恢复账本并完成进程树清理。复杂 ACL、重解析、更多协议、机器重启和故障注入只在对应实现触及该风险或已有证据显示不确定时增加，不能用测试数量替代机制判断。

## 10. 已有证据与待验证范围

机制可行性结论：已足够开始产品实现。当前机器上的探针已分别证明专用账户/`WRITE_RESTRICTED` 写根与并发、按账户 SID 的动态和持久 WFP fence、联合 IPC 身份→一次性 host lease→relay，以及真实 Git 配置投影顺序和只读聚合根。后续验证应随 W0--W6 实现增量进行，不再继续扩展独立可行性探针；这些证据仍不表示 Sandbox 已成为当前可用产品功能。

[restricted-token demo](../experiments/windows-restricted-token-demo/README.md) 已证明当前机器上普通 Win32 restricted token、Job 和正常 DACL 写限制的窄组合可运行，但它派生自当前用户并使用 capability SID，已不代表目标账户/文件身份模型。

[dedicated sandbox user demo](../experiments/windows-sandbox-user-demo/README.md) 的首次管理员运行已真实创建临时本地账户，并通过两个实例的跨根读取、各自根直接/后代写入和跨根写拒绝；它同时证明两次显式凭据启动复用了相同 logon SID，推翻了 logon SID 唯一假设。修订夹具随后以独立 execution/root capability SID 和收紧的 account/execution default DACL 通过管理员顺序复测。按 D100 新契约的第三次管理员运行让两个 Runtime 真正同时存活；双方均保持跨根读取、各自根直接/后代写入和跨根写拒绝，最终报告 `concurrent=yes peerObjectIsolation=not-required crossRead=yes ownWrite=yes crossWriteDenied=yes nestedProcess=yes`。复测后账户与运行目录均清理。该证据通过 W2 的正常 DACL 双实例并发文件矩阵，不覆盖复杂 ACL、共享 grant、控制面或网络边界。

后续真正并发夹具证明 peer 可成功取得 `PROCESS_TERMINATE`，即使目标 process DACL 同时列出共享账户 SID 与目标 execution SID。原因是 `WRITE_RESTRICTED` 只在评估写访问时考虑 restricting SID，不能假设它覆盖所有 process/thread/Job 权限。D100 已确认不同对话无需彼此构成 OS 安全边界，因此该结果改记为接受风险；夹具保留 process/thread/Job 危险 open 的观察输出，但通过条件改为两个 Runtime 同时存活时仍保持跨根读取、各自根直接/后代写入和跨根写拒绝。

[network/IPC demo](../experiments/windows-network-ipc-demo/README.md) 已证明 Named Pipe 可联合核对 PID、创建时间、restricted token、execution SID、映像、Job 和 nonce，并只向合法 restricted client 返回一次性 host-bound lease；该客户端随后成功访问 relay，Job 外同映像客户端被拒。独立状态机还证明错误 lease、错误 host 与消费后重放均拒绝。提升管理员下的动态 V4/V6 `ALE_USER_ID` 矩阵已证明 permit 可绑定账户 SID、loopback 地址与 relay 端口；TCP、带 ACK 的 UDP、真实非回环 IPv4、listen 和 raw bind 在普通账户与 restricted 后代路径均符合 fence，宿主不命中。dynamic engine 正常关闭或 controller 被强制终止后连接恢复，临时账户和目录清理为 0。持久生命周期探针也已证明 8 条规则在安装进程退出后可枚举自检并继续执行相同核心 fence，正常卸载后连接恢复且重复清理为空。这些仍是机制探针，不代表真实 CONNECT/Git 已完成。APP_ID 路径过滤实验和“需要 callout driver”的旧推论已被本设计取代：目标改用可由内建 WFP 用户条件匹配的专用账户 SID。

平台契约依据：Microsoft 文档确认 `CreateProcessWithLogonW` 默认不加载用户 profile，且可在创建时为 process/thread 提供 security descriptor；access token 包含 logon SID 和用于新对象的 default DACL；restricted token 对 securable object 执行普通 SID 与 restricting SID 两次访问检查。实测表明同一账户的多次显式凭据启动可共享 logon SID，因此实现只记录其值，不将“每次唯一”作为平台契约。`WRITE_RESTRICTED` 例外、execution SID/default DACL 及对象类型覆盖仍必须逐项实测，不能只依赖文档推断。

- [CreateProcessWithLogonW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw)
- [Access Tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/access-tokens)
- [Restricted Tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens)
- [Process Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights)

尚未实测：产品持久账户安装/专用 profile、WFP 安装器的 BFE/机器重启、升级、篡改与故障恢复、独立恢复脚本删除真实对象、复杂 ACL/重解析/其它卷下的写边界、共享 ACL grant table、宿主真实 global Git config 授权图与 helper/证书、真实 Node/PowerShell/编译器兼容、CONNECT/HTTPS/Git push、凭据、ACL 撤销、取消/恢复和资源上限。现有 Codex 外层 Sandbox 会干扰嵌套 token/Job/WFP 测试；所有结果必须分别标记“Codex 沙箱内”“批准的宿主权限”“真正提升安装环境”。

## 11. 与现有实现的关系

现有 WSL2 bubblewrap `inspect` Runtime 是历史实现，不是 fallback 或验收替代。迁移期间 UI 必须区分 `legacy-wsl2-inspect`、`windows-sandbox-user`、`non-isolated` 和 `unknown`。账户、WFP、ACL、Job、IPC 或代理自检任一失败时 Sandbox 模式安全拒绝，不能静默转为宿主权限。
