# AppContainer Agent Runtime 与 Broker 架构

状态：**已确认的目标架构，尚未实现或验证。** 本文替代 `sandbox.md` 中关于未来 Runtime、外部访问和平台路线的设计性内容；后者保留为已实现 WSL2 `inspect` 路径及其本机证据的历史记录。此次文档变更不改变当前发布版本的实际 Sandbox 行为。

## 1. 目标与不可混淆的边界

Windows 的目标执行边界是：每个运行中的 agent 使用独立的 **AppContainer Agent Runtime** 进程。它不是在宿主 Node.js 进程中“开启一个限制选项”，也不是用命令黑名单模拟隔离。Web UI、Fastify 服务和 **Broker Host** 保持在宿主用户上下文；Agent Runtime 只获得 AppContainer token、最小环境和显式文件系统访问。

设计有两种不同的访问路径，必须在 UI、事件、trace 和恢复账本中分别记录：

1. **直接目录访问**：Runtime 可直接访问当前任务工作区，以及用户在任务创建或任务运行前显式添加的额外目录。目录授权是 AppContainer SID 的 ACL 授权，不通过 Broker 逐文件转发。
2. **Broker 代理访问**：不在该目录清单内的主机文件、模型服务、会话存储、网络或其他宿主能力，Runtime 不能自行访问；它只能发送固定类型的请求给 Broker。Broker 可拒绝、要求确认、执行受限动作，并只返回审查和清洗后的结果。Git 不是 Broker 能力：所有 Git 进程都在 Runtime 内运行。

直接目录访问意味着 Runtime 能读取获授目录中它拥有 ACL 权限的全部内容，也能按所授读写权限修改内容。工作区内部不再区分普通文件、`.git`、`.env`、私钥或构建凭据，也不承诺对任何子路径做额外文件系统保护。Runtime 可以直接运行 Git、修改仓库元数据、破坏工作区或把其中内容加入模型请求和获准的网络发送。UI 必须在授权前展示这一事实；不希望 Runtime 接触的内容不得放入直接访问目录。

本设计防护的是不可信模型输出、仓库脚本及其子进程越出用户明确选择的目录和能力。它不防护恶意本机管理员、内核缺陷、已获直接目录授权的数据泄漏，或用户明确确认的外部写入/网络发送。

## 2. 总体拓扑与信任边界

```text
Browser ── HTTPS/HTTP + SSE ── Host Server
                                  │
                                  ▼
                    Broker Host（可信宿主边界）
                    ├─ Policy / approval / capability issuer
                    ├─ AppContainer launcher + ACL lease manager
                    ├─ model / storage / network / external-operation adapters
                    ├─ object verifier + result sanitizer
                    └─ execution ledger / tracing bridge
                         ▲  authenticated, fixed-schema IPC
                         │
                    Agent Runtime（AppContainer，非可信）
                    ├─ agent loop、工具计划、Git 与命令子进程
                    ├─ 当前工作区（直接 ACL）
                    ├─ 用户添加目录（直接 ACL）
                    └─ 私有临时目录
```

Broker 是唯一持有宿主 API key、用户 profile、会话数据库、长期凭据和默认网络能力的组件。它应作为独立的 Broker Host 进程运行，而不是把任意宿主操作暴露给 AppContainer 内的 Node 进程。Server 与 Broker 的内部通信同样使用受限、版本化契约；Server 不能把浏览器提供的任意路径或命令原样转交给 Broker。Broker 不执行 Git、不读取仓库配置，也不根据 Git 元数据获得宿主权限。

Runtime 不能继承父进程环境、工作目录、打开的文件/目录句柄、标准输入管道、API key、用户 token、代理设置、SSH agent、浏览器 cookie 或服务监听 socket。普通 Runtime 不声明 `internetClient`、`internetClientServer`、loopback exemption、设备或企业认证能力；模型请求和其他网络请求只能走 Broker 的专用 adapter。经确认的 HTTPS Git push 使用短时、单用途、绑定精确 host 的网络能力，不能因此获得通用网络。

## 3. 直接目录访问

### 3.1 AccessManifest 与 ACL 租约

Broker 在启动 Runtime 前生成不可变的 `AccessManifest`，其中包含：任务 ID、AppContainer SID、工作区和每个额外目录的规范真实根、读写模式、授权来源、创建时间、到期时间及审计 ID。每个并发 Runtime 使用不同的 AppContainer identity，避免两个任务因共享 SID 获得彼此的目录访问。

Broker 对每个根目录执行以下流程：

1. 以宿主身份规范化目录，拒绝不存在、非目录、UNC/设备路径（除非未来有单独策略）、重解析点根及解析后不稳定的路径。
2. 取得目录的稳定对象标识并记录；验证其 ACL 可加入最小、仅该 AppContainer SID 使用的 ACE。
3. 仅添加本次租约需要的读取、列举、创建或修改权限；不重写所有者或整体 DACL，不以宽泛的 `Users`/`All Application Packages` 放宽权限。
4. 启动后用 Runtime 身份执行无害 probe，确认允许根可访问、未授权相邻目录不可访问，并记录实际结果。
5. Runtime 结束、被取消或 Broker 恢复为中断后，移除**本次加入且对象标识仍一致**的 ACE；清理失败记录为安全告警，阻止把该目录当成已撤销。

ACL 是权限实现，不是路径字符串检查的替代品。对目录内重解析点、junction、symlink、hard link、短名称、大小写/Unicode 等别名必须做平台夹具验证；未验证的形态不得写入“已隔离”的承诺。目录内容在运行期被其他进程改动也可能改变可见对象，故重要写入仍要使用版本/对象复核。

### 3.2 工作区与额外目录的产品语义

- **工作区**为每个任务必选的直接目录；默认给予完成编码任务所需的读写权限，命令和 `edit_files` 观察同一真实目录，修改立即生效且不自动回滚。
- **额外目录**只能由用户显式添加，且每项必须选择只读或读写、确认递归范围并看到规范化真实路径。默认建议只读；读写必须单独确认，且不能通过模型文本、仓库说明或 Runtime IPC 自行添加。
- 目录授权在任务启动后冻结。新增、缩小或扩大目录集合需停止当前 Runtime，建立新的 AccessManifest 和新的 AppContainer identity，不能在旧任务中静默加 ACE。
- 直接目录内部没有 `.git`、`.env` 或其他敏感名称例外；目录授权同时允许 Runtime 内的 Git 和普通命令按授予模式访问这些对象。
- 直接目录路径只用于 Runtime 文件系统，不自动成为网络上传许可；但 Runtime 读取的正文可以进入模型上下文、会话历史和 Replay Case，也可能在用户确认网络外发后离开本机。Broker 的尽力脱敏不能作为直接目录秘密保护保证。

## 4. Windows 启动监督与 Runtime 身份

Windows 使用独立、薄层的原生 C++ `codeatelier-sandbox-host.exe` 启动并监督 AppContainer，而不是在宿主 Node.js 进程中直接绑定不稳定的 native addon。TypeScript Broker 仍负责策略、审批和产品状态；原生 helper 只负责 AppContainer profile/SID、ACL 或受支持的 BFS、最小环境、进程创建、Job Object、资源限制、等待、取消和清理，不实现 agent、Git 或通用 Broker 操作。

helper 在 Runtime 整个生命周期内保持运行并持有 process handle 与 Job handle。每次启动先生成 `runtimeInstanceId` 和单次 nonce，并持久化 `RuntimeProcessRecord`：supervisor PID、Runtime PID、进程创建时间、AppContainer SID 摘要、Job instance ID、实际映像摘要、状态与关联 task ID。PID 只用于显示和查找，不能单独证明身份，因为系统会复用 PID。

Runtime IPC 建连时，Broker/监督器通过管道取得客户端 PID，并与启动时保存的 process handle、创建时间、AppContainer token SID、映像和 Job 归属联合核对。原始 nonce、process handle 和完整 SID 不进入 session、日志或 trace。服务重启后若不能重新证明这些字段属于同一实例，任务标记为 `interrupted`，未确认的执行结果标记为 `unknown`，不得因 PID 数值相同而重新接管或重放。

## 5. Broker IPC 与能力模型

Runtime 与 Broker 使用任务专属命名管道或等价本地 IPC。管道 DACL 仅允许预期 AppContainer SID 和 Broker 服务 SID；Broker 在连接后读取客户端 PID/token，核对 AppContainer SID、任务 Job Object 归属、已登记可执行映像和单次启动 nonce。仅依赖管道名称、调用方声称的 task ID 或可猜 token 都不够。

每个帧都使用版本化 schema，设有最大帧长、消息序号、请求 ID、deadline、取消语义和关联 task/tool-call ID。Broker 发出的 capability 是短时、单用途、绑定任务/调用/请求摘要的不可伪造引用；Runtime 不能扩大它的路径、方法、主体、目标主机、输出上限或有效期。重放、重复 ID、过期、跨 Runtime、未知字段、嵌套过深或超配额的消息一律拒绝并记录安全摘要。

Broker 只实现有限的 typed operation，例如：

| 请求类别          | Broker 可做的受限动作                                                                     | 明确不做的事                                                    |
| ----------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `model.request`   | 使用宿主保存的固定服务配置发送 Responses 请求，限模型、参数、轮次、大小和超时             | 不提供 API key、任意 URL、任意认证头或通用 HTTP tunnel          |
| `external.read`   | 在获准的单一对象上读取有限文本/元数据，并生成清洗结果                                     | 不挂载目录、不返回真实路径、文件句柄或原始二进制流              |
| `external.write`  | 对确认过的单一对象执行受限、版本化的创建/精确编辑                                         | 不执行 Runtime 给出的 shell、脚本、递归复制或任意目录写入       |
| `network.fetch`   | 对明确允许的 HTTPS 读取做 DNS/IP/重定向/大小审查并返回受限响应                            | 不提供通用 socket、端口监听、内网/metadata 访问或上传默认许可   |
| `git.push.egress` | 为确认过的单次 Runtime Git push 开放精确 HTTPS scheme/host/port、短期凭据、时限与流量上限 | 不执行或解析 Git，不承诺限制仓库路径/ref，不开放 SSH 或通用网络 |
| `session.store`   | 持久化已验证的会话事件、工具结果和恢复账本                                                | 不允许 Runtime 查询或修改其他会话/项目的数据库记录              |

普通 `run_command` 和全部 Git action 始终在 AppContainer Runtime 内运行。Broker 不以“代理命令”或“代理 Git”为名在宿主执行 Runtime 传入的文本；无法映射为上述专用 operation 的宿主请求，返回 `BROKER_OPERATION_UNSUPPORTED`。这避免把 IPC 变成逃逸通道。

Git 默认没有网络。`status`、`diff`、`add`、`commit` 等本地操作直接使用 Runtime 可写的真实 `.git`。`push` 必须逐次确认，并在短生命周期的网络授权 Runtime 中执行；该实例复用同一工作区目录授权，但只允许精确 HTTPS host、固定端口、受限时间/字节数和尽可能短期且仓库范围最小的凭据。代理逐跳复核 DNS、IP 和重定向，拒绝 loopback、私网和 metadata 地址。应用层仍可检查 upstream、remote 与 ref 以避免误操作，但 host 级 Sandbox 不解析 Git receive-pack，不能把这些检查描述为网络安全边界。

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
                          └──────────────→ denied | failed | cancelled | unknown
```

Broker 在授予目录 ACL、启动 Runtime、接收代理请求、对象复核、执行、清洗、取消和清理时记录执行账本。Sandbox 开启与关闭时采用相同的产品取消语义：取消只终止进程树，不回滚已发生的工作区或 Git 副作用。AppContainer 模式由监督器关闭 Job Object，非 Sandbox 模式沿用现有进程树终止方式；确认终止记为 `cancelled`，无法确认进程或副作用结果则记为 `unknown`。之后才撤销 ACL 租约。

取消记录包含 `runtimeInstanceId`、Runtime PID、执行是否已经开始、取消和终止时间、受限部分输出，以及 `sideEffects: may_have_occurred` 和 `replayAllowed: false`。该结果作为工具结果/恢复事件追加到 session，下一次模型请求与历史一并发送，并明确要求先检查当前文件和 Git 状态。崩溃、服务重启、IPC 中断或无法确认写入状态同样进入 `unknown`；任何模式都绝不自动重放副作用。

`src/tracing` 的目标 span 至少包括 `sandbox.acl_lease`、`sandbox.runtime_provision`、`sandbox.runtime_attest`、`broker.request_review`、`broker.object_verify`、`broker.proxy_execute`、`broker.result_sanitize` 与 `sandbox.destroy`。span 只包含状态、耗时、数量、类别、关联 ID 和匿名化/受限路径摘要；不含外部文件正文、密钥、原始网络内容、完整命令、Capability 或 AppContainer SID。Pino 日志遵循同一数据边界。

UI 应显示实际 identity、任务是否已通过 attestation、直接目录数量及每项读写模式、Broker 请求类别、确认状态、脱敏/截断提示和清理失败。不得把“AppContainer 已创建”“ACL 已尝试”或“Broker 已收到请求”显示成已验证隔离。

## 8. Windows 实施与验收路线

| 阶段               | 交付物                                                                           | 必要行为证据                                                                      |
| ------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A0：契约与迁移     | 版本化 AccessManifest、RuntimeProcessRecord、Broker schema、旧 WSL2 路径退役计划 | 旧 Runtime 不会被标作 AppContainer；开关/模式显示与实际后端一致                   |
| A1：原生启动监督   | C++ supervisor、每任务 SID、最小环境、process/Job handle、PID 与创建时间记录     | Runtime 不能继承 API key；PID 复用、错误映像/Job/SID 和 supervisor 中断均安全失败 |
| A2：直接目录访问   | 工作区和用户额外目录的 ACL/BFS 授权、对象标识和清理                              | 整个授权根含 `.git`/`.env` 按模式可用；未授权根/重解析逃逸被拒绝；ACE 精确撤销    |
| A3：Broker IPC     | 客户端 PID/创建时间/token/SID/Job/nonce 证明、capability、限额                   | 非启动 Runtime、跨任务、重放、畸形/超限帧均不能获得能力                           |
| A4：代理审查与清洗 | 外部 read/write、模型、普通 HTTPS adapters；统一 Sanitizer                       | TOCTOU/重解析替换、敏感文本、控制字符、截断、扫描失败和无确认路径都安全失败       |
| A5：Git push 网络  | Runtime 内 Git、精确 HTTPS host 的一次性 egress、短期凭据                        | 默认无网络；DNS/IP/重定向/私网拒绝、超时/流量撤销和取消状态均以真实 push 夹具验证 |
| A6：取消与平台扩展 | 统一 session 取消结果、CPU/内存/PID/输出/墙钟限制和其它平台适配器                | cancelled/unknown 随下轮上下文发送；各平台以自身夹具证明边界                      |

在 A1--A4 完成并以实际 AppContainer 夹具验证前，产品不能声称 Windows 原生 Sandbox 已可用。`CODEATELIER_SANDBOX_ENABLED` 的现有 WSL2 行为也不能被重新解释为本设计的任何阶段完成。

## 9. 与现有 WSL2 实现的关系

当前仓库保留的 WSL2 bubblewrap `inspect` Runtime 仅是历史实现及本机验证证据，不是此目标架构的 fallback、组成部分或验收替代。迁移实现必须在新 AppContainer 后端可 attestation 且相应阶段测试通过后再切换默认路径；切换期间，用户可见模式应明确区分 `legacy-wsl2-inspect`、`appcontainer`、`non-isolated` 与 `unknown`。

如果 AppContainer 创建、ACL 租约、IPC 身份证明、Job Object 绑定或自检任一步失败，Broker 必须拒绝启动/执行，不能回退到 WSL2 或宿主权限。跨平台 Runtime 若未来需要，必须复用 Broker 的最小能力和清洗契约，但以各系统自身机制重新实现并验证，不能将 AppContainer 名称或 Windows 证据外推为跨平台保证。
