# Sandbox 架构设计

状态：架构设计已完成，**尚未实现**。本文描述 CodeAtelier 在初版之后可选的操作系统级隔离路线；它不改变当前 V1 的应用层审批、直接工作区编辑或受限 Git 工具行为。实施每个阶段前均须另行获得授权，并以实际支持的平台、隔离后端和验证结果为准。

## 1. 目标、范围与安全结论

当前产品的路径校验、审批、命令拒绝规则和超时属于应用层控制。它们能降低误操作与提示词注入带来的风险，但获准的命令仍以启动 CodeAtelier 的本机用户权限运行。因此，面对恶意仓库、依赖安装脚本或被诱导执行的命令，V1 不构成操作系统级 sandbox。

未来 sandbox 的目标是把**不可信的仓库内容、模型生成的命令及其子进程**与用户主机、凭据和其他项目隔开，同时保留代码阅读、修改、构建、测试、可审计恢复与显式审批的编码闭环。安全结论应限定为：

- 未经显式能力授予的主机文件、环境变量、网络、设备、Git 元数据和宿主进程不可被 sandbox 工作负载访问。
- agent 对代码的修改先留在任务级暂存工作区；只有受信任的宿主 broker 校验并在所需确认后才会合并回真实工作区。
- 隔离后端不可用、创建失败、健康检查失败或其执行状态未知时，任务安全失败；不得静默退回为宿主权限执行。用户若主动选择 V1 的“非隔离模式”，UI 必须持续显示其风险，且该选择不能伪装为 sandbox 成功。
- sandbox 不是对恶意本机管理员、已被攻破的内核/虚拟化层、硬件攻击或用户主动批准的外部副作用的防护承诺；本机诊断、历史和暂存数据仍须按敏感数据保护。

该设计不引入多 agent、MCP、插件或无人值守恢复。模型服务请求继续由宿主后端发起，模型 API key 永不进入 sandbox。

## 2. 威胁模型与非目标

### 2.1 需要缓解的威胁

| 攻击面 | 例子 | 预期防护 |
| --- | --- | --- |
| 不可信项目内容 | `AGENTS.md`、README、测试输出或依赖脚本诱导读取密钥、删除文件或联网 | 所有仓库材料仅为数据；隔离进程没有宿主密钥、用户主目录或未授予网络 |
| 任意命令及其子进程 | 测试脚本启动挖矿、扫描本机、写入启动项、持续派生进程 | 任务级进程树、最小挂载、资源配额、受限系统调用与可靠终止 |
| 路径与链接逃逸 | 符号链接、junction、挂载点、`..`、case 差异或 TOCTOU | broker 按真实路径构造只读输入与暂存输出；sandbox 内不挂载宿主父目录 |
| 凭据与配置泄露 | `.env`、SSH/Git 凭据、包管理器 token、云元数据服务 | 进程环境白名单、无 home/凭据挂载、网络默认拒绝、输出脱敏与大小限制 |
| 网络外传与横向访问 | DNS 隧道、访问内网服务、下载恶意二进制 | 默认无网络；例外仅经受控代理、精确目标和时限能力令牌 |
| 资源耗尽与逃逸残留 | fork bomb、磁盘填满、超时后子进程存活 | CPU、内存、PID、磁盘、进程树和 wall-clock 限制；终止后验证 cgroup/job/VM 已为空 |
| 恢复时重复副作用 | 服务崩溃后重复构建、写入或网络请求 | 持久化执行账本；未知状态不重放，先检查暂存区和 sandbox 生命周期 |

### 2.2 明确非目标

- 不保证用户主动批准的真实工作区合并、受限 Git 提交或受控网络操作没有业务副作用。
- 不把容器当作所有平台的等强安全边界；弱于预设安全级别的后端不得标记为“强隔离”。
- 不尝试在同一 OS 用户与同一内核已完全失陷时保护秘密；需要该等级时使用受支持的 VM/独立主机并配合操作系统补丁与磁盘加密。
- 不默认支持图形界面、交互式终端、USB/串口、Docker socket、宿主 daemon socket、嵌套虚拟化或任意端口监听。

## 3. 分层架构

采用“策略与副作用分离、最小能力、默认拒绝、可验证降级”的五层模型。上层判断不可信输入不能放宽下层限制；下层隔离也不能替代审批与精确编辑校验。

```text
Web UI / SSE
  │  展示 profile、隔离状态、能力申请、暂存 diff 与失败原因
  ▼
Agent Engine ── PolicyEngine ── ApprovalManager
  │                  │
  │                  └─ 生成不可伪造的任务能力清单（非 shell 文本）
  ▼
SandboxBroker（宿主可信边界）
  ├─ WorkspaceStager：快照、只读输入、任务级可写暂存区、合并
  ├─ SandboxManager：选择后端、创建/探测/销毁实例
  ├─ NetworkBroker：默认拒绝；可选受控 DNS/HTTPS 代理
  ├─ ResultCollector：输出限额、退出事实、产物清单与摘要
  └─ ExecutionLedger：持久化阶段、nonce、状态与安全摘要
  │
  ▼
SandboxRuntime（每任务独立、无宿主密钥）
  └─ sandbox-init → 受限 shell / 编译器 / 测试子进程树
```

### 3.1 PolicyEngine：统一能力决策

现有 `permissions` 的路径、敏感文件、提权、Git 与人工审批规则继续作为第一道防线，并演进为与运行后端无关的 `SandboxPolicy`。它接收规范化的工具意图，不解析或信任仓库文本；输出不可变的能力清单，而不是把“已审批”变成一段可自由解释的 shell 字符串。

建议的最小能力模型如下：

| 能力 | 默认值 | 授予方式 | 限制 |
| --- | --- | --- | --- |
| `workspace.read` | 允许 | 会话绑定工作区 | 仅 broker 制作的输入快照 |
| `workspace.stage-write` | 允许 | 普通编辑/命令流程 | 仅任务暂存区，不直接写宿主工作区 |
| `host.workspace.apply` | 拒绝 | diff 审核与现有编辑规则 | 仅显式清单中的普通文件；复核版本、链接和敏感路径 |
| `network.connect` | 拒绝 | 每次精确确认 | 仅代理允许的 scheme、主机、端口、字节数和到期时间 |
| `package-cache.read` | 拒绝 | 已验证的构建 profile | 只读、内容寻址缓存；无用户 home 配置 |
| `git.metadata` | 拒绝 | 受限 Git 专用路径 | 不挂载给一般命令；禁用 hook/filter/credential helper |
| `host.read` / `host.write` | 拒绝 | 不在 sandbox 中授予 | 继续走宿主端明确工具与确认，不能由 sandbox 命令间接获得 |
| `privilege`, `device`, `socket`, `daemon` | 永久拒绝 | 不可授予 | 包括管理员权限、Docker socket、SSH agent 与系统服务 |

`inspect`、`build`、`modify`、`networked-build` 是 UI 可理解的 profile，底层仍展开为以上具体能力。profile 只能缩小默认能力；任何增加能力都必须生成新的、可见且可记录的确认，不继承上次网络或宿主写入批准。

### 3.2 SandboxBroker：唯一宿主副作用入口

Broker 运行在 CodeAtelier 后端进程（或其后续专用受信任 helper）中，承担宿主文件、网络例外、Git 和进程管理。SandboxRuntime 不获得任意宿主 IPC、继承文件描述符、父进程环境或工作目录。

Broker 与 runtime 使用每任务新建的受保护本地通道，消息由严格 schema 编码，至少包含 `sessionId`、`taskId`、`toolCallId`、单调序号、一次性 nonce、能力清单哈希及截止时间。runtime 只能接收 `prepare`、`execute`、`cancel`、`collect`、`destroy` 等固定操作；不能要求 broker “代为执行”任意路径或命令。Broker 对每条消息复核 task 归属、阶段转换、资源预算与 nonce，拒绝重放、跨任务引用和过期请求。

执行结果是受限数据：退出类型、退出码、受限 stdout/stderr、资源统计、暂存变更清单与内容哈希。它不能让 runtime 指定宿主输出路径。结果先经控制序列剥离、密钥/认证模式脱敏、单流与总量截断，再写入会话、UI 或日志。

### 3.3 WorkspaceStager：写入前隔离、合并时复核

为避免获准命令直接修改用户文件，sandbox 不挂载真实工作区为可写目录。每个任务按以下方式准备视图：

1. Broker 解析真实工作区根目录，拒绝敏感文件、链接逃逸、设备文件和不可识别的文件类型，并记录输入文件清单与哈希。
2. 将允许读取的普通文件复制或以只读快照方式提供给 runtime；`.git`、用户 home、父目录、真实 `.env` 与凭据文件均不进入视图。
3. runtime 仅在专用、配额受限的 staging 目录修改文件；构建产物、临时目录和 package cache 使用彼此分离的挂载点。
4. 任务结束后，Broker 从 staging 生成普通文件变更清单与 diff，重新检查路径、类型、大小、敏感规则、链接、输入版本及总量。
5. 对应 `host.workspace.apply` 已获批准时，Broker 通过现有精确编辑/原子替换机制合并；发生冲突、未知执行状态或验证失败时保留 staging 供人工检查，绝不猜测合并或回滚。

这样会改变 V1“直接修改工作区”的行为，因此只能随 sandbox 阶段整体推出，并为用户明确显示“暂存修改，尚未合并”。多文件合并仍不承诺跨文件事务；每个已应用文件须写入执行账本，服务中断后以真实工作区与 staging 清单核对。

### 3.4 SandboxRuntime：最小运行环境

每个运行任务创建独立实例，使用无特权身份、固定 cwd、空白/白名单环境和只读运行时根。运行时必须：

- 只继承明确允许的 `PATH`、区域/编码和工具所需的非秘密变量；固定 `HOME`、`TMPDIR`、缓存目录至实例私有位置，移除代理、云凭据、SSH/Git/包管理器 token 与动态加载器危险变量。
- 禁止访问宿主设备、IPC、其他用户进程、系统服务 socket、挂载管理接口与调试接口；不映射 Docker/Podman、SSH agent、X11/Wayland、浏览器或密码库 socket。
- 默认关闭网络；模型请求仍由宿主 provider 完成，runtime 不需要 API key。
- 以 cgroup/job/VM 级别限制 CPU 时间、内存、进程数、打开文件数、磁盘配额、输出字节和墙钟时间；超时、取消或协议错误均终止完整子进程树。
- 在启动前和退出后执行健康检查：确认策略实际生效、工作目录属于实例、无残留成员，并在销毁后删除私有临时数据或按恢复策略加密保留 staging。

## 4. 平台后端与安全等级

策略和 Broker 对所有平台一致，但隔离实现必须明确报告实际等级，不能假设 Node.js 子进程选项等同 sandbox。

| 平台 | 基线后端 | 强隔离后端 | 关键要求 |
| --- | --- | --- | --- |
| Linux | rootless namespace runtime（user/mount/pid/net）、只读 root、seccomp、Landlock、cgroup v2；可基于经过审计的 bubblewrap 类基础设施 | KVM/microVM 或受管 VM | 不允许特权容器、host PID/network、Docker socket 或宽泛 bind mount；验证 user namespace、cgroup v2 与 LSM 可用性 |
| Windows | 受限 token + Low Integrity/AppContainer + Job Object + 受限 ACL 的任务目录 | Hyper-V/Windows Sandbox 风格的短生命周期 VM | 不能只依赖隐藏窗口或 `taskkill`；必须验证 capability SID、网络能力、Job 中的全部后代和 reparse point 处理 |
| macOS | 不把已废弃的 `sandbox-exec` 当作安全后端；仅在受支持、签名的系统 sandbox helper 可满足策略时作为受限基线 | Apple Virtualization Framework 的短生命周期 Linux/受管 VM | 需要明确的 entitlement、seatbelt profile 审计和宿主共享目录限制；不能把未验证的 shell profile 宣称为强隔离 |

首次实现应以 Linux 参考后端验证完整闭环；Windows 与 macOS 只有在各自后端通过相同的逃逸、取消与资源测试后才可启用。若用户要求跨平台一致的强隔离，优先选择 VM 等级后端，而不是把三个基线后端标为等价。受限设备、企业策略或虚拟化不可用时，UI 只允许选择已通过自检的 profile，默认拒绝启动隔离任务。

## 5. 网络、依赖与 Git

### 5.1 网络

默认运行时没有 DNS 或任意 socket 权限。确实需要安装依赖或下载受信任工具时，先优先使用宿主预填充的只读、内容寻址缓存；缓存不能带入用户的 `.npmrc`、`.pypirc`、Git credential helper 或 token。

若缓存不足，`networked-build` 必须请求一次性网络能力：协议、精确主机/端口、最大上传/下载字节、有效期和目的显示在确认卡中。runtime 只可连到 broker 管理的代理；代理负责 DNS、TLS、主机 allowlist、重定向复核、审计及速率/字节限制，禁止 loopback、RFC1918/本地链路、云元数据和任意 IP 直连。代理本身不解密或记录无必要的内容，不持久化认证头；私有 registry 凭据若未来支持，应由独立凭据 broker 按最小 scope 注入，不能作为环境变量暴露给 shell。

### 5.2 Git

一般 sandbox 视图不包含真实 `.git`。状态、diff 与测试针对暂存快照完成；需要 Git 历史的只读操作由 Broker 在受限实现中提供最小数据视图，或使用禁用 hooks、filters、外部 diff/textconv、pager、编辑器和 credential helper 的宿主专用 Git 工具。提交与推送仍由既有受限 Git 策略决定，且必须在暂存变更安全合并到真实工作区、用户可见 diff 与 worktree 复核后执行。Git 配置、filter、hook 或 submodule 不得成为从 sandbox 返回宿主执行的通道。

## 6. 任务生命周期、取消与恢复

```text
queued
  → policy-resolved
  → sandbox-provisioning
  → staged
  → executing
  → collecting
  → awaiting-apply | completed-without-changes
  → applying
  → completed

任一阶段 → cancelled | failed | interrupted | unknown
```

1. Engine 先完成现有工具 schema、DAG、审批及工作目录互斥检查，再向 Broker 提交已固定的工具意图与能力清单。
2. Broker 记录 `sandbox.provisioning` 账本条目，创建实例、准备 staging 并执行后端自检；失败时不启动命令。
3. Broker 启动 runtime 后才记录 `sandbox.executing`。它持续收集受限输出和资源用量，取消会先发送运行时取消，再按平台可靠地终止整个隔离边界。
4. 收集完成后销毁实例或把 staging 标记为可恢复证据。只有获得完整终态和清单时，才允许进入 apply；否则记录 `unknown`。
5. 服务重启、broker 崩溃或失去 runtime 通信时，不自动创建新实例或重放命令。恢复入口先检查实例是否仍存在、其状态、staging 清单及真实工作区版本；状态不能可靠判定时要求用户选择丢弃暂存证据或人工检查。
6. staging 的保留期、磁盘上限和清理结果需独立配置。保留数据应位于 CodeAtelier 数据目录并采用仅当前用户可访问的权限；清理失败记录告警，不能以递归删除任意用户路径补救。

这与现有“不重放未知副作用”原则一致，并额外把实例 ID、策略哈希、快照哈希和 apply 逐文件状态写入账本。

## 7. 可观测性、审计与隐私

新增隔离功能须在 `src/tracing` 中产生以下安全摘要 span：`sandbox.policy_resolved`、`sandbox.provision`、`sandbox.stage`、`sandbox.execute`、`sandbox.collect`、`sandbox.apply`、`sandbox.destroy`。每项至少记录 task/tool 关联 ID、后端类型与版本、安全等级、能力类别、状态、错误类别、资源计数与耗时；不把完整命令、源码、输出、密钥、代理认证或宿主绝对路径写进普通日志或 Perfetto 属性。

SQLite 执行账本保存可恢复所需的最小事实：实例随机 ID（不作为授权凭据）、状态转移、策略/快照/结果清单哈希、批准 ID、开始结束时间、截断和 apply 状态。它用于检测状态缺失和指导人工检查，不是抵抗拥有本机数据目录写权限者的不可篡改审计。详细命令与 diff 仍遵循现有会话历史和 trace 的本机敏感数据保护规则、访问控制与保留限制。

UI 必须持续显示当前任务是 `sandboxed`、`staging`、`awaiting apply`、`non-isolated` 还是 `unknown`；隔离层级、已授予网络例外、资源终止原因和未合并变更也应可查看。不得把辅助模型的 `approve` 分类、成功创建子进程或仅有应用层路径校验显示为“已安全隔离”。

## 8. 实施阶段与验收门槛

| 阶段 | 交付物 | 进入下一阶段的证据 |
| --- | --- | --- |
| S0：契约与观测 | `SandboxPolicy`、Broker 接口、账本 schema、UI 状态、dry-run；不改变 V1 执行路径 | schema、状态机、脱敏 tracing 与拒绝默认值的单元测试 |
| S1：暂存写入 | 跨平台 staging、清单/diff、冲突与恢复流程；仍可选择非隔离执行 | 链接/敏感路径/版本变化/部分 apply/崩溃恢复回归测试 |
| S2：Linux 参考 | rootless 隔离后端、无网络、资源与进程树清理 | 逃逸探测、fork/磁盘/内存限制、取消、无凭据环境、真实构建闭环 |
| S3：受控网络与缓存 | 只读缓存、代理、一次性网络能力和审计 | 内网/metadata/DNS/重定向拒绝、allowlist 与凭据不泄露测试 |
| S4：Windows 与 macOS | 平台 adapter、自检、明确等级和失败 UI | 各自真实平台上的路径、子进程、取消、网络、资源与 staging 验收；未测平台保持禁用 |
| S5：强隔离 VM | 可选 VM 后端、镜像供应链与清理 | 冷启动/复用隔离证明、镜像签名/更新、宿主共享目录与故障恢复测试 |

所有阶段都需要：单元测试观察策略和 Broker 外部行为；集成测试使用专门的无害逃逸夹具；真实平台测试记录 OS/后端版本与未覆盖项；安全回归不得依赖真实模型密钥或用户项目。Evaluation 不因 sandbox 开发而自动执行。

## 9. 需要在实施前确认的产品决定

以下选择会影响产品行为、性能与兼容性，不能由本设计静默决定：

1. sandbox 是否成为默认模式，及用户是否允许明确选择现有非隔离模式；
2. 暂存修改的默认合并策略（逐文件确认、整批确认，或满足何种低风险规则后自动合并）；
3. 是否支持网络依赖安装、允许哪些 registry，以及私有凭据如何由独立 broker 管理；
4. 各平台承诺的最低安全等级和虚拟化前置条件；
5. staging、输出、账本和诊断数据的保留期、配额、加密/清理要求；
6. Git 提交/推送是否必须要求强隔离任务已经成功合并，及对 Git filter/submodule 的兼容边界。

在这些决定与平台验证完成前，CodeAtelier 应继续如实说明：当前 V1 使用应用层审批，不提供操作系统级 sandbox。
