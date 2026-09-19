# Windows Restricted-Token Runtime 与 Broker 架构

状态：已确认的后续 Windows Sandbox 目标设计，尚未实现或验证。本文替代原 AppContainer 目标设计；现有 WSL2 `inspect` 实现仍只是历史证据。

## 1. 目标与非目标

Windows Runtime 采用面向本机开发工具的 **完整性 Sandbox**：Runtime 保留当前宿主用户原本拥有的读取能力，但写入只应落到当前工作区、用户显式添加的可写根和任务私有临时目录。普通 Runtime 默认没有命令网络；模型、会话存储、外部写入和受限网络仍由宿主 Broker 提供固定能力。

该 profile 的安全目标是降低 agent、恶意仓库脚本和工具链破坏宿主的风险，而不是保护宿主文件机密性。Runtime、Git、hooks、helper 和任意子进程可以读取当前用户可读的大部分本机文件，包括用户 profile、其它源码、Git 配置和潜在凭据；这些内容可能进入命令输出、模型请求、会话记录或获准的网络发送。UI 必须在启用前明确显示这一边界。需要文件保密隔离的任务应使用未来另行验证的容器/VM profile，而不能把本设计描述成满足该目标。

“全盘可读”在本文中始终表示“沿用启动用户已有的读取权限”，不绕过 DACL，不取得管理员、SYSTEM、其它用户或受保护对象的读取权。本文也不承诺任意错误配置的 null DACL、Everyone 可写对象或非文件系统对象一定不可写；这些例外必须通过预检、夹具和 UI 限制能力声明。

首版明确不做：

- 不引入 Chromium 源码、Chromium TargetServices 或 API hook；任意未修改的 Node、Git、PowerShell、编译器和其后代必须直接工作。
- 不使用 AppContainer、`broadFileSystemAccess`、实验性的 `CreateProcessInSandbox` 或 Bound File System 作为必要依赖或 fallback。
- 不对工作区内 `.git`、`.env`、hooks、配置或其它子路径做额外保护。
- 不把审批、命令黑名单、模型判断或用户可见提示冒充操作系统写入边界。

## 2. 进程与信任边界

```text
Web UI / Fastify Server
          |
          v
Broker Host（宿主用户；可信策略与长期状态）
  |       |-- 模型请求、会话存储、外部写入与网络代理
  |       `-- AccessManifest、执行账本、审批和清洗
  v
C++ sandbox supervisor（薄层、受保护控制面）
  |-- CreateRestrictedToken + WRITE_RESTRICTED
  |-- 每个可写根 capability SID / ACL 投影
  |-- 最小环境、私有 desktop、进程缓解策略
  `-- Job Object、资源、等待、取消和清理
          |
          v
Sandbox Process（非可信；同一工作区互斥）
  |-- Agent Runtime 或单用途 Push Runner
  `-- Node / Git / shell / 编译器 / 任意后代
```

Broker、supervisor 和 Sandbox Process 是三个不同边界。supervisor 只接受 Broker 已认证控制通道上的固定 schema，不接受任意 SID、路径、ACL、命令或网络目标，也不返回原始 process、Job 或文件 handle。Broker 断连、租约过期或实例身份无法重新证明时，supervisor 必须关闭 Job；无法终止或清理时进入 `orphaned` 并锁定工作区。

## 3. Restricted token 与文件系统

### 3.1 Token

supervisor 从当前非提升用户 token 创建 restricted primary token，至少使用 `DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED`，只恢复运行普通工具所必需的最小权限（例如目录 traverse）。管理员组和提升身份不得因 Broker 自身是否提升而进入 Runtime 的有效授权。

Broker 正常运行时不应提升；如果安装或维护 WFP/ACL 的独立服务处于提升上下文，supervisor 必须从已认证的交互用户会话取得其非提升 primary token，不能从服务、管理员或 SYSTEM token 直接降级猜测。无法证明 token 对应当前会话用户、属于非提升完整性且不含额外特权时拒绝启动。

`WRITE_RESTRICTED` 是核心边界：读取沿用当前用户正常 SID/DACL 检查；写访问还必须通过 restricting SID 集合的第二次访问检查。每个授权可写根拥有随机、稳定且不复用到其它根的 capability SID；Runtime token 只包含本次 AccessManifest 中可写根的 SID。Broker 为对应根安装可继承的写入 ACE，因此未修改的 Git、Node 和编译器可以直接读写真实工作区，而其它普通路径缺少匹配 capability SID，写入应由内核拒绝。

Runtime token 还包含只用于进程/IPC 归因的 execution SID。可写根 SID、execution SID、logon SID 和默认 DACL 的组合必须以真实 Windows 访问检查验证，不能因为 SID 出现在 token 中就假定其只会缩小权限。尤其不得把 `Everyone`、`Users` 或 `Authenticated Users` 作为通用写 capability；如果兼容性要求把宽泛 SID 放入 restricting 集合，W2 直接失败，除非能够证明它不会使工作区外对象通过第二次写检查。

### 3.2 可写根 ACL 投影

Broker 在任务启动前规范化每个写根，以不跟随重解析点的方式打开原对象，记录卷标识、`FILE_ID_128`、DACL 摘要、根专属 capability SID 和本次 ACE。ACL 投影只增加该 capability SID 所需的继承写权限，不改所有者，不替换整体 DACL，不给普通用户组扩权。

写根 SID 按规范对象稳定复用，避免每个任务递归改写整个工作区；Runtime token 则每次重新创建，只携带当前获准根。根被 rename/move 后仍按原对象 handle/file ID 管理；路径被替换、删除重建或出现无法覆盖的 protected DACL/reparse subtree 时，必须拒绝启动或进入明确的 degraded/unsupported 状态，不能默许其中的写行为与文档不一致。

ACE 可以在根登记期间持久存在，因为没有对应 restricting SID 的普通 Runtime 不能据此增加权限；但 Broker 必须提供对账、撤销和孤儿状态。撤销只操作登记时的同一对象。无法定位原对象、无法删除精确 ACE 或发现 SID/ACE 冲突时，根保持锁定并发出安全告警。

以下情况是边界必测项：弱 DACL、null DACL、Everyone/Users 可写目录、显式 deny、继承关闭、已有与新建子项、rename/move/delete、junction/symlink/mount point、UNC、其它盘、8.3/大小写/设备路径、hard link、事务中断和 Broker 崩溃。若 Windows 对 null DACL 或宽泛写 ACE 的访问检查使 restricted token 可以写工作区外对象，产品必须显示“宿主存在额外可写对象”，不得仍声称只有指定根可写。

### 3.3 读取与 Git 配置

Runtime 直接读取当前宿主用户可读的路径，不再建立外部读取 Broker、global Git config 解析器或只读 ACL 图。Git 正常加载 system、global、include/includeIf、local 和 worktree 配置；`HOME`、`USERPROFILE`、`XDG_CONFIG_HOME` 可指向真实用户位置，但长期密钥、代理 token、SSH agent handle 和 Broker 环境变量仍不得继承。

读取成功不代表内容可信或安全。仓库、其它目录和 Git 配置中的文本都属于非可信数据；读取工具仍执行大小、编码、终端控制字符和历史持久化限制。该清洗只保护产品记录和 UI，不构成文件保密或提示注入防护。

### 3.4 工作区内行为

工作区及显式可写根内部不区分普通文件、`.git`、`.env`、构建产物或配置。Runtime 可以创建、修改、重命名和删除其中任何 ACL 允许且不被更高优先级 deny 阻止的对象；取消不回滚副作用。任务开始前 UI 显示全部可写根，新增或扩大根必须停止旧 Runtime、保存状态并创建新的 token/AccessManifest。

## 4. 进程、IPC 与资源

supervisor 以 suspended 状态创建 Runtime，完成 token、环境、desktop、Job 和 mitigation 设置后才允许执行。Job 使用 kill-on-close，并限制进程数、内存、CPU、墙钟和输出；所有可创建的后代必须留在同一 Job，不能通过 breakaway、计划任务、服务、COM 激活或其它宿主执行路径逃逸。创建进程、打开其它进程/线程、句柄复制、注册表写入、命名对象、设备和 UI 交互都需要真实绕过夹具。任何 IPC、COM、窗口消息、自动化接口或现存宿主进程若能代 Runtime 在写根外产生写入，都属于完整性逃逸并使 W1/W2 验收失败，不能降格为兼容性限制。

Runtime 与 Broker 使用任务专属命名管道。Broker 从连接取得实际 PID，并联合核对启动时 process handle、创建时间、token 的 execution SID/限制标志、实际映像、Job 归属、启动 nonce、task/tool-call 和租约；PID、pipe 名称或 Runtime 自报字段都不单独授权。Runtime 不继承 Broker handle、stdin、API key、cookie、代理、SSH agent、服务 socket 或完整环境。

Chromium 的 broker API interception 不在本设计中。所有安全结论必须来自 Windows token、ACL、Job、desktop、mitigation、WFP 和经过身份验证的 Broker capability，而不是用户态 hook；这也是任意未修改工具能够运行的兼容性前提。

## 5. Broker 能力

Broker 只提供参数受限的 typed operation：

| 类别              | 允许                                                    | 禁止                                                   |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| `model.request`   | 使用宿主固定模型配置发送受限 Responses 请求             | 暴露 API key、任意 URL/认证头或通用 HTTP tunnel        |
| `external.write`  | 对用户确认的单一工作区外对象执行版本化创建/精确编辑     | 任意 shell、递归复制、目录级写入或把确认扩展到其它对象 |
| `network.fetch`   | 对明确批准的 HTTPS 读取执行 host/DNS/IP/重定向/大小审查 | 通用 socket、内网、metadata、监听端口或默认上传        |
| `git.push.egress` | 管理 PushSpec、Runner、WFP、relay 和短期凭据            | 执行 Git、解析 Git 协议或承诺仓库 path/ref 是网络边界  |
| `session.store`   | 持久化本任务事件、结果和恢复账本                        | 读取或修改其它会话数据                                 |

本地读取不经过 Broker；因此 Broker 清洗不能阻止 Runtime 读取秘密。`model.request` 也不能证明请求正文没有宿主秘密：模型正常完成任务本来就需要发送代码和工具结果。启用该 profile 等同于信任所配置模型服务可能接收 Runtime 可读数据，产品不得作相反承诺。

## 6. 网络与 Git push

普通 Agent Runtime 的命令进程默认无网络。restricted token 本身不提供网络隔离，必须由 WFP 默认拒绝规则及启动自检落实；模型请求始终由 Broker 发出。WFP 安装、自检或撤销状态不确定时拒绝启动，不能退化为开放网络。

所有本地 Git 直接在普通 Runtime 中运行。`push` 逐次确认规范化 HTTPS host/port、预期 source OID 和目标 ref 后，先停止普通 Runtime 并锁定工作区，再创建新的 `pushRunnerInstanceId` 和单用途 Push Runner。Runner 不加载 agent loop 或任意 shell，但正常 Git 配置、hooks、helper、filter 和 remote helper 仍可执行，并拥有与本次工作区相同的写根以及当前用户读取能力。

Push Runner 只能经固定 relay/CONNECT 组件连接 Broker。WFP 必须能够把默认拒绝和 relay 例外绑定到本次 Runner 的可验证 token/执行身份、受信任映像和端点；若目标 Windows 的 WFP 条件不能安全地区分本次 Runner 与同一宿主用户的其它进程，受限 push profile 不可用。不能用“进程路径相同”“当前用户相同”或 relay 端口难猜代替实例身份。

Broker 代理仅接受经 pipe 取得实际 PID 并核对 process handle、创建时间、execution SID、映像、父进程/Job、lease 和调用摘要的 relay。CONNECT 目标必须等于 PushSpec host/port；DNS 由代理解析并拒绝 loopback、私网、link-local、multicast、保留地址和 metadata endpoint。代理不解密 TLS、不解析 Git；每个新 CONNECT 都重新校验 host、IP、时限和流量。

凭据由固定 askpass/credential adapter 经独立私有 pipe 一次性取得，不进入 argv、环境、配置、工作区、session、日志或 trace。真实 Git helper 仍可能观察或保存短期凭据，这是正常加载 Git 配置后的接受风险。

由于 Runner 可读取当前用户文件，获准 host 必须视为可能接收这些文件，而不只是当前仓库。host allowlist 只限制连接目标，不限制上传内容、URL path、仓库或 ref；UI 必须在每次 push 确认时显示该警告。

## 7. 生命周期、取消与恢复

```text
policy-resolved -> write-roots-attested -> token-created -> job-bound -> executing
                    |                                      |
                    `-> denied / unsupported               `-> completed / failed
                                                               / cancelled / unknown / orphaned
```

统一记录使用 `executionInstance`：

- `mode: windows-restricted-token | host-process`
- `instanceId`、可空 `pid`、`createdAt`
- Sandbox 模式另含 `kind: agent-runtime | push-runner`
- 按 kind 二选一保存 `agentRuntimeInstanceId` 或 `pushRunnerInstanceId`
- 保存 supervisor PID、进程创建时间、execution SID 摘要、Job ID、映像摘要、AccessManifest 摘要与状态

Sandbox 开启和关闭时保持同一产品取消语义：终止进程树，不回滚已发生的文件或 Git 副作用。确认 Job 后代退出记为 `cancelled`；无法确认进程或副作用结果记为 `unknown`。记录执行是否开始、取消/终止时间、受限部分输出、`sideEffects: may_have_occurred` 和 `replayAllowed: false`，追加到 session 并随下一次模型请求发送，要求先检查当前文件和 Git 状态。Push Runner 不能被恢复成 Agent Runtime。

`src/tracing` 的目标 span 至少包括 `sandbox.token_create`、`sandbox.write_root_project`、`sandbox.write_root_attest`、`sandbox.runtime_provision`、`sandbox.supervisor_control`、`sandbox.runtime_lease`、`sandbox.pushspec_prepare`、`sandbox.push_runner`、`sandbox.egress_lease`、`broker.relay_attest`、`broker.credential_issue`、`broker.request_review`、`broker.proxy_connect`、`broker.result_sanitize` 与 `sandbox.destroy`。trace 和 Pino 日志只保存状态、耗时、数量、kind/profile、关联 ID 与安全摘要；不得保存原始路径、完整 SID、pipe 名称、host/IP、命令、源码、工具输出或凭据。无法终止、无法撤销 ACE/WFP 或发现额外可写对象必须记录为安全告警，不得仅写调试日志。

## 8. 实施与验收

| 阶段               | 交付物                                                                  | 必要证据                                                                             |
| ------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| W0：契约           | AccessManifest、executionInstance、风险文案、禁用模式兼容               | 当前实现与目标 profile 不混淆；开关失败关闭                                          |
| W1：原生监督       | C++ supervisor、restricted token、私有 desktop、Job、租约、WFP 默认拒绝 | 非提升 token、后代/宿主代写不逃逸、Broker 失联关闭 Job、PID 复用拒绝、直接出站不可达 |
| W2：读取与写根     | WRITE_RESTRICTED、根 capability SID、ACL 投影/对账                      | 当前用户可读对象可读；正常对象仅获准根可写；弱/null DACL和所有别名有明确结果         |
| W3：Broker IPC     | pipe 客户端身份、capability、配额、模型/session adapter                 | 跨任务、重放、错误映像/Job/token、畸形帧安全拒绝                                     |
| W4：外部写入与清洗 | 版本化单对象写入、结果清洗、审批绑定                                    | TOCTOU、reparse、对象替换、敏感日志和超限失败路径                                    |
| W5：Git push       | PushSpec、单用途 Runner、WFP 临时例外、relay、短期凭据                  | 同用户其它进程不能复用规则/代理；仅获准 host 可达，租约结束后恢复默认拒绝            |
| W6：取消与资源     | 统一账本、CPU/内存/PID/输出/墙钟限制                                    | cancelled/unknown 进入下一轮；后代终止和资源上限真实验证                             |
| W7：其它平台       | macOS/Linux 对应实现                                                    | 各平台独立证明，不继承 Windows 结论                                                  |

W1--W2 通过后只能声明“Windows 完整性 Sandbox：广泛读取、指定根写入、无命令网络”；不得声明文件保密。W5 前不支持受限 push，W6 前不声明已验证取消和资源边界。任何阶段都必须列出 null DACL、宽泛写 ACE、驱动/设备、已打开句柄和平台差异等剩余限制。

## 9. 与现有实现的关系

现有 WSL2 bubblewrap `inspect` Runtime 是历史实现，不是本目标的 fallback 或验收替代。迁移期间 UI 必须区分 `legacy-wsl2-inspect`、`windows-restricted-token`、`non-isolated` 和 `unknown`。restricted token、写根 ACL、Job、IPC 或网络自检失败时，Sandbox 模式安全拒绝，不能静默转为宿主完整权限。

本设计借鉴 Chromium 的 restricted token、Job、隔离 desktop 和进程缓解思路，以及公开 coding agent 的 workspace-write 实践；它不是 Chromium renderer sandbox。真正采用的 `WRITE_RESTRICTED` 与可写根 capability SID 组合必须由 CodeAtelier 自己实现、审计并以真实 Windows 夹具证明。
