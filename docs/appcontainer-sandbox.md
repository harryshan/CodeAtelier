# AppContainer Agent Runtime 与 Broker 架构

状态：**已确认的目标架构，尚未实现或验证。** 本文替代 `sandbox.md` 中关于未来 Runtime、外部访问和平台路线的设计性内容；后者保留为已实现 WSL2 `inspect` 路径及其本机证据的历史记录。此次文档变更不改变当前发布版本的实际 Sandbox 行为。

## 1. 目标与不可混淆的边界

Windows 的目标执行边界是：每个运行中的 agent 使用独立的 **AppContainer Agent Runtime** 进程。它不是在宿主 Node.js 进程中“开启一个限制选项”，也不是用命令黑名单模拟隔离。Web UI、Fastify 服务和 **Broker Host** 保持在宿主用户上下文；Agent Runtime 只获得 AppContainer token、最小环境和显式文件系统访问。

设计有两种不同的访问路径，必须在 UI、事件、trace 和恢复账本中分别记录：

1. **直接目录访问**：Runtime 可直接访问当前任务工作区，以及用户在任务创建或任务运行前显式添加的额外目录。目录授权是 AppContainer SID 的 ACL 授权，不通过 Broker 逐文件转发。
2. **Broker 代理访问**：不在该目录清单内的主机文件、模型服务、会话存储、网络或其他宿主能力，Runtime 不能自行访问；它只能发送固定类型的请求给 Broker。Broker 可拒绝、要求确认、执行受限动作，并只返回审查和清洗后的结果。Git 不是 Broker 能力：所有 Git 进程都在 Runtime 内运行。

直接目录访问意味着 Runtime 能读取获授目录中它拥有 ACL 权限的全部内容，也能按所授读写权限修改内容。工作区内部不再区分普通文件、`.git`、`.env`、私钥或构建凭据，也不承诺对任何子路径做额外文件系统保护。Runtime 可以直接运行 Git、修改仓库元数据、破坏工作区或把其中内容加入模型请求和获准的网络发送。除此以外，Runtime 不获得整个用户 profile 或全盘读取权限。UI 必须在授权前展示这一事实；不希望 Runtime 接触的内容不得放入直接访问目录。

本设计防护的是不可信模型输出、仓库脚本及其子进程越出用户明确选择的目录和能力。它不防护恶意本机管理员、内核缺陷、已获直接目录授权的数据泄漏，或用户明确确认的外部写入/网络发送。

## 2. 总体拓扑与信任边界

```text
Browser ── HTTPS/HTTP + SSE ── Host Server
                                  │
                                  ▼
                    Broker Host（可信宿主边界）
                    ├─ Policy / approval / capability issuer
                    ├─ ACL lease / WFP egress lease manager
                    ├─ model / storage / external-operation adapters
                    ├─ authenticated HTTPS CONNECT proxy
                    ├─ object verifier + result sanitizer
                    └─ execution ledger / tracing bridge
                         ▲  authenticated, fixed-schema IPC
                         │                         control IPC
                         │                             │
                         │                C++ Sandbox Supervisor
                         │                    ├─ process / Job handles
                         │                    └─ launch / wait / cancel / cleanup
                         │                             │
                    Sandbox Process（AppContainer，非可信；互斥）
                    ├─ Agent Runtime：agent loop、工具计划、本地 Git 与命令
                    ├─ Push Runner：真实 Git 配置、HTTPS transport 与 relay；无 agent loop
                    ├─ 当前工作区 / 用户添加目录（直接 ACL）
                    └─ 私有临时目录
```

Broker 是唯一持有宿主 API key、完整用户 profile、会话数据库、长期凭据和默认网络能力的组件；第 3.3 节精确只读授权的 global Git config 是唯一 profile 文件例外。它应作为独立的 Broker Host 进程运行，而不是把任意宿主操作暴露给 AppContainer 内的 Node 进程。Server 与 Broker 的内部通信同样使用受限、版本化契约；Server 不能把浏览器提供的任意路径或命令原样转交给 Broker。Broker 不执行 Git；普通 Agent Runtime 使用受限 Git 查询得到当前 upstream、URL、source OID 和 ref，Broker 只对这些字段做结构、HTTPS host 与确认绑定校验，不尝试独立重现 Git 配置的运行时语义。

Runtime 不能继承父进程环境、工作目录、打开的文件/目录句柄、标准输入管道、API key、用户 token、代理设置、SSH agent、浏览器 cookie 或服务监听 socket。普通 Runtime 不声明 `internetClient`、`internetClientServer`、loopback exemption、`broadFileSystemAccess`、设备或企业认证能力；模型请求和其他网络请求只能走 Broker 的专用 adapter。经确认的 HTTPS Git push 不给普通 Runtime 增加网络能力，而是建立新的单用途 Push Runner；Git 的唯一网络连接是 Runner 内 relay，relay 再经认证 pipe 使用 Broker 代理，不能因此获得通用网络。

## 3. 直接目录访问

### 3.1 AccessManifest 与 ACL 租约

Broker 在启动 Runtime 前生成不可变的 `AccessManifest`，其中包含：任务 ID、AppContainer SID、工作区和每个额外目录的规范真实根、读写模式、授权来源、创建时间、到期时间及审计 ID。每个根的租约另保存卷标识、`FILE_ID_128` 或等价稳定 ID、原始 DACL 摘要、本次 ACE 描述，以及仅由 Broker 持有的目录 handle；handle 不进入 Runtime、supervisor IPC、session、日志或 trace。每个并发 Runtime 使用不同且永不复用的 AppContainer identity，避免两个任务因共享 SID 获得彼此的目录访问。

Broker 对每个根目录执行以下流程：

1. 以宿主身份规范化目录，拒绝不存在、非目录、UNC/设备路径（除非未来有单独策略）、重解析点根及解析后不稳定的路径。
2. 使用 `FILE_FLAG_BACKUP_SEMANTICS`、`FILE_FLAG_OPEN_REPARSE_POINT`、`FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE` 和撤销所需的最小 `READ_CONTROL`/`WRITE_DAC` 权限打开原始目录对象；记录卷标识与文件 ID，并在整个租约期间保持该 handle。若文件系统不能提供可验证的稳定对象引用，则不启用该根。
3. 通过该 handle 读取当前 DACL，并仅添加本次租约需要的、绑定唯一 AppContainer SID 的读取、列举、创建或修改 ACE；不重写所有者或整体 DACL，不以宽泛的 `Users`/`All Application Packages` 放宽权限。
4. 启动后用 Runtime 身份执行无害 probe，确认允许根可访问、未授权相邻目录不可访问，并记录实际结果。
5. Runtime 结束、被取消或 Broker 恢复为中断后，使用原 handle 对**同一对象**执行 `SetSecurityInfo` 或等价 handle-based 操作，删除本次唯一 SID/flags/mask 对应的 ACE，同时保留租约期间其他主体的合法 DACL 修改；不得根据原路径重新打开后修改可能已替换的新对象。

若 Broker 崩溃导致 handle 丢失，启动对账只能使用账本中的卷标识与文件 ID 通过 `OpenFileById` 或经验证的等价 API 重新打开原对象，并再次核对对象 ID 后撤销。原对象已被重命名、移动或处于删除等待状态时，路径变化不改变 handle-based 撤销目标；原路径删除后重建的新目录不得被修改。若原对象无法重新定位、DACL 无法安全更新或撤销结果不确定，则租约进入 `orphaned`，保留 task/workspace 锁，永久禁用该 SID/profile identity 的复用，并要求人工安全恢复；不能把路径不存在视为撤销成功。

ACL 是权限实现，不是路径字符串检查的替代品。对目录内重解析点、junction、symlink、hard link、短名称、大小写/Unicode 等别名必须做平台夹具验证；未验证的形态不得写入“已隔离”的承诺。目录内容在运行期被其他进程改动也可能改变可见对象，故重要写入仍要使用版本/对象复核。

首版只接受经典 AppContainer SID 配合按授权根添加最小 ACE 的 ACL 方案，不使用 Windows `broadFileSystemAccess` capability，也不依赖实验性的 [`CreateProcessInSandbox`](https://learn.microsoft.com/windows/win32/secauthz/createprocessinsandbox) 或其 Bound File System（BFS）策略。BFS 是依赖 AppContainer 的附加文件策略，不是 AppContainer 本身；全盘只读方案已经撤回。未来若重新评估 BFS 或其他文件系统代理，必须另行决策其最低 Windows 版本、实验 API 稳定性、普通 Win32 I/O、句柄与对象身份、重解析点、授权范围和生命周期，并用真实夹具证明它与当前 ACL 根等价或更窄；在此之前不能替代 ACL 验收或成为失败 fallback。

### 3.2 工作区与额外目录的产品语义

- **工作区**为每个任务必选的直接目录；默认给予完成编码任务所需的读写权限，命令和 `edit_files` 观察同一真实目录，修改立即生效且不自动回滚。
- **额外目录**只能由用户显式添加，且每项必须选择只读或读写、确认递归范围并看到规范化真实路径。默认建议只读；读写必须单独确认，且不能通过模型文本、仓库说明或 Runtime IPC 自行添加。
- 目录授权在任务启动后冻结。新增、缩小或扩大目录集合需停止当前 Runtime，建立新的 AccessManifest 和新的 AppContainer identity，不能在旧任务中静默加 ACE。
- 直接目录内部没有 `.git`、`.env` 或其他敏感名称例外；目录授权同时允许 Runtime 内的 Git 和普通命令按授予模式访问这些对象。
- 直接目录路径只用于 Runtime 文件系统，不自动成为网络上传许可；但 Runtime 读取的正文可以进入模型上下文、会话历史和 Replay Case，也可能在用户确认网络外发后离开本机。Broker 的尽力脱敏不能作为直接目录秘密保护保证。

### 3.3 宿主 global Git config

为了保留用户的 Git 身份、URL rewrite、代理和 credential helper 等常用设置，Agent Runtime 和 Push Runner 的 `AccessManifest` 都包含宿主用户已存在的标准 global config 文件：`%USERPROFILE%\.gitconfig` 与 `%USERPROFILE%\.config\git\config`，以及从它们解析得到且条件对当前工作区成立的 `include`/`includeIf` 文件。只对每个规范化后的已存在普通文件授予精确只读 ACE，父目录只获得打开该文件所必需的最小 traverse 权限，不允许列举、读取其他文件或修改 global config，也不给整个 `%USERPROFILE%` 添加 ACE。

Broker 可用受限、只读的数据解析器遍历 include 边，但这个解析器只生成文件授权清单，不运行 Git，不解释 remote/ref/push 语义，也不作为网络安全边界。它必须限制 include 深度和文件数，拒绝循环、UNC/设备路径、重解析点、非普通文件、无法规范化或在建立租约前发生替换的目标；不支持或不确定的 include 导致 Runtime 安全拒绝启动，不会因为解析遗漏而扩大访问。每个 config 文件与直接目录根一样保存 Broker-only handle、卷/file ID、DACL delta 并按原对象撤销。

supervisor 不继承宿主环境；它只从已验证 manifest 生成受控的 `HOME`/`USERPROFILE`/`XDG_CONFIG_HOME` 定位值，使 Git 按自身顺序找到这些文件。这些值不导致 profile 其他内容可读，不带入凭据、代理环境或 SSH agent。config 引用的外部 helper、CA/证书、签名程序或其他数据不因 config 获准而自动授权；若不在已授权根或另一精确授权内，相关 Git 操作必须失败并给出可诊断提示。

global config 对 Runtime 内的 Git、agent 与任何子进程都可读，不是只对 Git 可见的秘密通道；其内容可进入命令输出、模型上下文或会话。UI 必须在启用 AppContainer profile 时明示该默认授权，并提醒不得在 global config/include 中保存明文凭据。`git config --global` 等写入操作必须因只读 ACL 失败。

## 4. Windows 启动监督与 Runtime 身份

Windows 使用独立、薄层的原生 C++ `codeatelier-sandbox-host.exe` 启动并监督 AppContainer，而不是在宿主 Node.js 进程中直接绑定不稳定的 native addon。首版使用经典 `CreateAppContainerProfile`/AppContainer SID 与 `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` 进程创建路径，不依赖实验性的 `CreateProcessInSandbox`。TypeScript Broker 仍负责策略、审批和产品状态；原生 helper 只负责 AppContainer profile/SID、最小环境、进程创建、Job Object、资源限制、等待、取消和清理，不实现 agent、Git、网络代理或通用 Broker 操作。ACL/WFP 策略由 Broker 决定，supervisor 只应用已登记 manifest/lease ID 对应的固定操作，不能接收任意 SID、路径、ACE、网络目标或命令文本。

helper 在隔离进程整个生命周期内保持运行并持有 process handle 与 Job handle。普通 Agent Runtime 创建 `agentRuntimeInstanceId`，单用途 Push Runner 创建 `pushRunnerInstanceId`；两者属于不同命名空间，不能互换或复用。持久化的 `SandboxProcessRecord` 明确记录 `kind: agent-runtime | push-runner`、对应 kind-specific ID、supervisor PID、实际进程 PID、进程创建时间、AppContainer SID 摘要、Job instance ID、实际映像摘要、状态与关联 task/tool-call ID。PID 只用于显示和查找，不能单独证明身份，因为系统会复用 PID。

Runtime IPC 建连时，Broker/监督器通过管道取得客户端 PID，并与启动时保存的 process handle、创建时间、AppContainer token SID、映像和 Job 归属联合核对。原始 nonce、process handle 和完整 SID 不进入 session、日志或 trace。服务重启后若不能重新证明这些字段属于同一实例，任务标记为 `interrupted`，未确认的执行结果标记为 `unknown`，不得因 PID 数值相同而重新接管或重放。

Broker 启动 supervisor 时从安装目录的固定绝对路径打开二进制，不搜索 `PATH`，并在执行前核对发布签名和版本清单中的映像哈希；开发构建至少核对构建清单固定的哈希。启动参数只含不可猜实例 ID 和已登记 manifest ID，敏感数据经私有控制通道传递。Broker 与 supervisor 使用仅向该子进程显式继承的 duplex handle，或满足相同证明强度的命名管道；句柄继承清单不得包含 Runtime。控制协议只有 launch、query、cancel、destroy 和 heartbeat 等固定 schema，设有版本、帧长、序号、deadline 和状态机检查。Runtime SID/DACL 明确不能连接控制面，任何 IPC 都不返回原始 process、Job、token、文件或目录 handle。

控制通道同时是有期限的租约。Broker 按固定周期发送带实例序号的 heartbeat；通道断开、租约过期、Broker 身份变化或实例无法复证时，supervisor 必须先关闭带 `KILL_ON_JOB_CLOSE` 的 Job、确认后代退出，再请求撤销 ACL/WFP 租约并退出。supervisor 自身异常退出时，Job handle 关闭也必须终止 Runtime。终止、WFP 或 ACL 清理失败均持久化为安全告警和 `orphaned` 遗留实例；恢复服务在证明旧实例已退出且租约已撤销前锁定该 task/workspace，不得创建替代 Runtime。启动时还必须对未完成的 supervisor/ACL/WFP 账本执行对账和保守清理。

## 5. Broker IPC 与能力模型

Runtime 与 Broker 使用任务专属命名管道或等价本地 IPC。管道 DACL 仅允许预期 AppContainer SID 和 Broker 服务 SID；Broker 在连接后读取客户端 PID/token，核对 AppContainer SID、任务 Job Object 归属、已登记可执行映像和单次启动 nonce。仅依赖管道名称、调用方声称的 task ID 或可猜 token 都不够。

每个帧都使用版本化 schema，设有最大帧长、消息序号、请求 ID、deadline、取消语义和关联 task/tool-call ID。Broker 发出的 capability 是短时、单用途、绑定任务/调用/请求摘要的不可伪造引用；Runtime 不能扩大它的路径、方法、主体、目标主机、输出上限或有效期。重放、重复 ID、过期、跨 Runtime、未知字段、嵌套过深或超配额的消息一律拒绝并记录安全摘要。

Broker 只实现有限的 typed operation，例如：

| 请求类别          | Broker 可做的受限动作                                                                               | 明确不做的事                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `model.request`   | 使用宿主保存的固定服务配置发送 Responses 请求，限模型、参数、轮次、大小和超时                       | 不提供 API key、任意 URL、任意认证头或通用 HTTP tunnel                                      |
| `external.read`   | 在获准的单一对象上读取有限文本/元数据，并生成清洗结果                                               | 不挂载目录、不返回真实路径、文件句柄或原始二进制流                                          |
| `external.write`  | 对确认过的单一对象执行受限、版本化的创建/精确编辑                                                   | 不执行 Runtime 给出的 shell、脚本、递归复制或任意目录写入                                   |
| `network.fetch`   | 对明确允许的 HTTPS 读取做 DNS/IP/重定向/大小审查并返回受限响应                                      | 不提供通用 socket、端口监听、内网/metadata 访问或上传默认许可                               |
| `git.push.egress` | 记录已确认 PushSpec，创建 Push Runner、WFP、认证 relay/CONNECT 租约，并注入受限凭据、时限与流量上限 | 不执行 Git、不解析 Git 配置/协议，不承诺以 host 边界限制仓库路径/ref，不开放 SSH 或通用网络 |
| `session.store`   | 持久化已验证的会话事件、工具结果和恢复账本                                                          | 不允许 Runtime 查询或修改其他会话/项目的数据库记录                                          |

普通 `run_command` 和全部 Git action 始终在 AppContainer Sandbox Process 内运行：本地 Git 属于 Agent Runtime，push 属于互斥的 Push Runner。Broker 不以“代理命令”或“代理 Git”为名在宿主执行 Runtime 传入的文本；无法映射为上述专用 operation 的宿主请求，返回 `BROKER_OPERATION_UNSUPPORTED`。这避免把 IPC 变成逃逸通道。

### 5.1 单用途 HTTPS Git push

Git 默认没有网络。`status`、`diff`、`add`、`commit` 等本地操作直接使用普通 Runtime 可写的真实 `.git`。`push` 必须逐次确认。普通 Agent Runtime 以受限的 Git 查询调用解析当前 upstream、push URL、source OID 和目标 ref；Broker 不运行 Git，只验证查询结果是可确认的 HTTPS URL/ref 并记录 `PushSpec`：工作区/Git-dir 对象 ID、预期 source OID、规范 scheme/host/port/path、预期目标 ref、凭据 scope、调用摘要和期限。确认 UI 显示这些预期值，并提示获准 host 可能接收 Runner 可读的任意工作区内容。`PushSpec` 是用户确认和网络租约的输入，不是 Git 最终语义的证明；应用层 upstream/ref 检查只减少误操作。

每次 push 创建新的 `pushRunnerInstanceId` 和 AppContainer SID，仅启动 **Push Runner**，不加载 agent loop、不接受模型/Runtime IPC 工具请求，也不提供任意 shell 入口；Git 配置和 hooks 仍可由 Git 启动子进程。Broker 先持久化 PushSpec 与待执行 tool call，停止普通 Agent Runtime 的 Job 并确认退出，冻结同一工作区调度，撤销其 SID 的 ACE，再依据同一 AccessManifest 根和模式为 Push Runner SID 安装新的最小 ACE；不能在两个 SID 间共享或同时保留目录租约。push 结果先持久化为完整、失败或 `unknown` 的工具结果，完成网络、凭据和进程清理后，才可为新的无网络 Agent Runtime 建立新 `agentRuntimeInstanceId`、SID 和 ACL 租约，并从已保存结果继续 agent loop，不重新执行 push。任何阶段无法确认旧实例退出或 ACE 撤销时，push 安全拒绝且 task/workspace 保持锁定。

Push Runner 在真实工作区/Git directory 上执行固定形状的 `git push`，正常加载 Git 的 system、第 3.3 节精确只读授权的宿主 global/include、local 和 worktree 配置，不创建 shadow Git directory，也不对 `.git/config`、include、URL rewrite、proxy、credential helper、hooks、filter、diff/textconv 或 remote helper 做键白名单。Runner 仍不继承宿主 profile 的其他内容、环境凭据、SSH agent 或已打开句柄。

这是显式接受的风险：真实 Git 配置可以改写 URL、选择代理/凭据或 remote helper，hooks/helper 及 Git 启动的其他子进程可以在 Push Runner 的工作区 ACL 内读写并观察本次短期凭据。它们不会因此获得普通网络：任何不符合 WFP 允许进程/端点的连接都被内核层拒绝，通过 relay 的 CONNECT 目标不等于已确认 host/port 也被 Broker 拒绝。配置重写或自定义代理导致 Git 不经 relay 时，push 失败而不是放宽网络。因为 host 边界不限制 URL path/ref，获准 host 必须按可接收 Runner 能读取的任意仓库内容来信任；短期凭据应尽可能只授权单一仓库并在 Runner 结束后立即失效。

AppContainer 网络 capability 本身不作为 host allowlist。Broker 为 Push Runner 安装按本次唯一 package SID、受信任 Git HTTPS helper 的 ALE app ID、Runner 内 relay 地址/端口和方向绑定的一次性 WFP（Windows Filtering Platform）规则：出站侧拒绝该 SID 下所有进程的直接 Internet、DNS 和其他 loopback/局域网连接，只允许登记 helper 连接本次 relay；入站侧只允许该唯一 SID 与 helper app ID 的对应 ALE flow 到达 relay，其他 AppContainer 与宿主本机进程也不能复用端口。Job/父进程归属不伪装成静态 WFP 条件，而是在 relay 接入 Broker pipe 时再以实际 PID 复核；若目标 Windows 版本的 ALE 层无法同时强制 package SID、app ID 和端点，A5 不可用并须安全拒绝，不以文档假设补足平台机制。规则必须以 fail-closed 租约存在，不能因 Broker/代理进程崩溃而先于 Runner Job 自动消失；终止 Job 并确认后代退出后才能移除，启动对账负责清理遗留规则。若访问 relay 需要 loopback exemption，该 exemption 只有与 WFP 默认拒绝规则同时生效且夹具证明无法连接其他 loopback 服务时才可启用；任一规则安装或自检失败都不得启动 Git。

Runner 内 relay 是固定路径、签名/哈希核验的 CodeAtelier 组件。它只接受一个来自已登记 Git HTTPS transport 映像、目标等于 PushSpec host/port 的 HTTPS `CONNECT`，再主动连接任务专属 Broker 命名管道以转发加密字节；管道名称/关联 ID 不是授权材料，可通过 supervisor 只读 bootstrap 通道传入。Broker 用 `GetNamedPipeClientProcessId` 或经验证的等价 API 取得实际 relay PID，并联合核对 `pushRunnerInstanceId`、PID、创建时间、AppContainer SID、映像摘要、父进程/Job 归属、一次性 lease 和调用摘要。验证后接受的这一条 pipe connection 就是短期连接证明，不另发可复制 bearer token，不把认证材料放入 argv、环境、Git 配置、工作区、session、日志或 trace。其他 AppContainer/本机进程、过期 lease、PID 复用、跨 Job 连接及代理重启后的旧 relay 一律无法重新建连并被拒绝。

Broker 代理只接受已完成上述联合证明的 relay，且 CONNECT 目标必须等于 PushSpec host/port。DNS 只由代理解析；每次解析和连接都拒绝 loopback、私网、link-local、multicast、保留地址与 metadata endpoint，并将实际 IP 固定到本次连接。代理不解密 TLS、不读取 receive-pack，也不执行或解析 Git；它只记录受限的 CONNECT 元数据、字节数、期限和结果。Git 配置可以允许重定向，但每个新 CONNECT 都重新经过同一校验；不同 host 必须拒绝，同 host 重定向仍受本次时限与字节上限约束。

短期 Git 凭据可由固定 CodeAtelier askpass/credential adapter 经任务专属命名管道提供；Broker 从管道取得客户端 PID，并核对固定 adapter 映像、创建时间、Push Runner SID/Job、已登记 Git 父进程、`pushRunnerInstanceId`、host/调用和尚未消费的 lease 后，只通过该次 adapter 通道返回一次凭据。这里不使用代理 bearer token；pipe 名称本身不授权，错误父进程、其他 AppContainer/本机进程、PID 复用、过期或已消费 lease 均拒绝。正常 Git 配置中的 credential helper 可能在 Git 的 get/store 流程中观察或保存这个短期凭据；这是放宽配置后的已接受风险，不得再声称凭据绝不进入工作区。凭据本身不应由 CodeAtelier 写入 argv、环境、Git 配置、session、日志、trace 或 relay；到期、字节超限、取消、Runner 退出或控制租约失效时，代理先停止转发，随后撤销 WFP、凭据和 ACL 租约；撤销失败进入 `orphaned` 安全告警。

## 6. Broker 审查与回传清洗

“已确认”不等于“可直接执行”。Broker 对每一个代理请求按下列顺序实施纵深审查，并把每步的允许/拒绝原因作为可审计状态保存：

1. **协议审查**：解析严格 schema，验证 IPC 身份、任务、调用、nonce、deadline、配额和 capability 绑定；所有 Runtime 提供的文本、路径和内容都视为不可信数据。
2. **权限审查**：将请求映射到精确 capability，检查用户确认、会话授权、读写模式和一次性有效期。模型分类器可帮助排序人工审批，但永远不能扩展 Broker 能力。
3. **对象审查**：将外部路径规范化后以不跟随重解析点的方式打开，检查最终对象类型、稳定对象 ID、链接/reparse 属性、大小、权限和允许根；副作用对同一已验证对象或写入前重新验证的对象执行，避免 check-then-use 竞态。
4. **操作审查**：仅允许普通文本、明确补丁、限定 HTTP 方法或固定网络目标等语义；拒绝目录递归、设备、管道、socket、可执行映像、凭据位置、模糊通配符和超出预算的内容。高风险写入、上传或外发需要逐次人工确认。Runtime 内的工作区与 Git 操作不经过此对象审查。
5. **结果审查**：限制字节数、行数、递归深度和处理时间；将二进制、压缩包、超大内容、未知编码或无法稳定读取的对象拒绝或仅返回无内容的元数据。
6. **内容清洗**：对允许的文本按统一 UTF-8/Unicode 和控制字符规则处理，移除 ANSI/OSC 等终端控制序列；运行保守的凭据和敏感数据检测（认证头、私钥块、常见 token、密码赋值、连接字符串等），命中值替换为不可逆占位符。清洗器记录类别和数量，不写原始值到日志、trace 或审批摘要。
7. **语义隔离**：所有外部结果以 `BrokerResult` 信封返回，含来源类别、不透明对象引用、内容哈希、截断/脱敏标志和“外部不可信数据”标签。Runtime 的系统规则必须规定其中的文本不能改变权限、工具契约、目录授权、Broker 策略或用户目标。

凭据检测和恶意内容识别只能降低泄漏风险，不能证明文本不含敏感信息或提示注入。Broker 不为“保留原文”提供绕过清洗的 IPC 开关；用户若确需让 Runtime 直接处理某可信目录，应通过可见的直接目录授权完成，并接受其不经过 Broker 内容审查的边界。

对清洗后不再满足调用用途、扫描失败、编码不确定或对象在读取中替换的结果，Broker 返回明确的拒绝/不完整状态而不是猜测、回退宿主权限或补造内容。会话历史保存的是返回给 Runtime 的清洗后结果及安全元数据；原始宿主内容不进入日志、Perfetto trace 或默认历史。

## 7. 生命周期、取消、恢复与可观察性

```text
policy-resolved
  → ACL-leased → AppContainer-provisioned → attested → executing
  → broker-requested → reviewed → proxied → sanitized → completed
                          └──────────────→ denied | failed | cancelled | unknown | orphaned
```

Broker 在授予目录 ACL、启动 Runtime、接收代理请求、对象复核、执行、清洗、取消和清理时记录执行账本。Sandbox 开启与关闭时采用相同的产品取消语义：取消只终止进程树，不回滚已发生的工作区或 Git 副作用。AppContainer 模式由监督器关闭 Job Object，非 Sandbox 模式沿用现有进程树终止方式；确认终止记为 `cancelled`，无法确认进程或副作用结果则记为 `unknown`。之后才撤销网络与 ACL 租约。

统一产品记录使用 `executionInstance`：`mode: appcontainer | host-process`、`instanceId`、可空的 `pid`、`createdAt`。AppContainer 记录另含 `kind: agent-runtime | push-runner`，并按 kind **二选一**保存 `agentRuntimeInstanceId` 或 `pushRunnerInstanceId`；不再使用模糊的 `sandboxRuntimeInstanceId`。UI 和恢复逻辑不能把 push-runner 显示或恢复成可承载 agent loop 的 Agent Runtime。取消记录另含执行是否已经开始、取消和终止时间、受限部分输出、`sideEffects: may_have_occurred` 和 `replayAllowed: false`。该结果作为工具结果/恢复事件追加到 session，下一次模型请求与历史一并发送，并明确要求先检查当前文件和 Git 状态。崩溃、服务重启、IPC/租约中断或无法确认写入状态同样进入 `unknown`；任何模式都绝不自动重放副作用，不为 host-process 伪造 Runtime 字段。

`src/tracing` 的目标 span 至少包括 `sandbox.acl_lease`、`sandbox.acl_reconcile`、`sandbox.runtime_provision`、`sandbox.runtime_attest`、`sandbox.supervisor_control`、`sandbox.runtime_lease`、`sandbox.pushspec_prepare`、`sandbox.push_runner`、`sandbox.egress_lease`、`broker.relay_attest`、`broker.credential_issue`、`broker.request_review`、`broker.object_verify`、`broker.proxy_connect`、`broker.proxy_execute`、`broker.result_sanitize` 与 `sandbox.destroy`。span 只包含状态、耗时、数量、kind/profile、关联 ID、配置/对象安全摘要及 orphaned/cleanup 状态；不含外部文件正文、凭据、原始 host/IP/网络内容、完整 URL/ref/命令、Capability、AppContainer SID 或 pipe 名称。Pino 日志遵循同一数据边界，并以 ERROR 记录无法终止或无法撤销租约的安全告警，避免重复记录同一 orphaned 实例。

UI 应显示实际 profile/identity、`agent-runtime | push-runner` kind 及对应 kind-specific ID、任务是否已通过 attestation、直接目录数量及每项读写模式、Broker 请求类别、确认状态、脱敏/截断提示，以及 `unknown`/`orphaned` 和清理失败。不得把“AppContainer 已创建”“ACL/WFP 已尝试”或“Broker 已收到请求”显示成已验证隔离。

## 8. Windows 实施与验收路线

| 阶段               | 交付物                                                                                            | 必要行为证据                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A0：契约与迁移     | AccessManifest、SandboxProcessRecord、executionInstance、kind-specific ID、Broker schema          | 旧 Runtime/Push Runner 不会混淆；开关、profile、模式与实际后端一致                               |
| A1：原生启动监督   | C++ supervisor、受保护控制面、每任务 SID、最小环境、process/Job handle、租约/heartbeat            | PID 复用、错误映像/Job/SID、Broker/supervisor 失联和孤儿清理均安全失败                           |
| A2：文件系统授权   | 经典 AppContainer、目录与 global config 最小 ACL、原对象 handle、卷/file ID、DACL delta、对账清理 | 获授根可用且未授权 profile/同盘/其他盘文件不可读；config 只读；对象替换后精确撤销；失败 orphaned |
| A3：Broker IPC     | 客户端 PID/创建时间/token/SID/Job/nonce 证明、capability、限额                                    | 非启动 Runtime、跨任务、重放、畸形/超限帧均不能获得能力                                          |
| A4：代理审查与清洗 | 外部 read/write、模型、普通 HTTPS adapters；统一 Sanitizer                                        | TOCTOU/重解析替换、敏感文本、控制字符、截断、扫描失败和无确认路径都安全失败                      |
| A5：Git push 网络  | 已确认 PushSpec、真实 Git 配置、单用途 Push Runner、认证 relay/CONNECT、WFP 和短期凭据            | 配置/hooks/helper 可执行但无法突破获准 host；连接复用/PID/lease/代理重启均以夹具验证             |
| A6：取消与资源边界 | 统一 executionInstance/session 结果、CPU/内存/PID/输出/墙钟限制                                   | cancelled/unknown 随下轮上下文发送；Job 后代终止与资源上限以真实 Windows 夹具验证                |
| A7：其它平台       | 复用策略契约的 Linux/macOS 适配器                                                                 | 各平台以自身夹具证明边界，不继承 Windows 结论                                                    |

能力声明按 profile 分层：A1--A4 完成并通过真实夹具后，只能声明“无网络、本地工作区 AppContainer Runtime”；A5 完成后才可额外声明“受限 HTTPS Git push”；A6 完成后才可声明“已验证取消与资源边界”。只有 A1--A6 全部通过时，产品才可不带 profile 限定地称 Windows 原生 Sandbox 已完成。`CODEATELIER_SANDBOX_ENABLED` 的现有 WSL2 行为不能被重新解释为本设计的任何阶段完成。

## 9. 与现有 WSL2 实现的关系

当前仓库保留的 WSL2 bubblewrap `inspect` Runtime 仅是历史实现及本机验证证据，不是此目标架构的 fallback、组成部分或验收替代。迁移实现必须在新 AppContainer 后端可 attestation 且相应阶段测试通过后再切换默认路径；切换期间，用户可见模式应明确区分 `legacy-wsl2-inspect`、`appcontainer`、`non-isolated` 与 `unknown`。

如果 AppContainer 创建、ACL 租约、IPC 身份证明、Job Object 绑定或自检任一步失败，Broker 必须拒绝启动/执行，不能回退到 WSL2 或宿主权限。跨平台 Runtime 若未来需要，必须复用 Broker 的最小能力和清洗契约，但以各系统自身机制重新实现并验证，不能将 AppContainer 名称或 Windows 证据外推为跨平台保证。
