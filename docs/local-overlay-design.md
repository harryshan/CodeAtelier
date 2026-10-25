# Local 会话文件隔离与发布：重新定界

状态：2026-10-25 用户重新澄清目标（D170），随后授权继续验证并接入 agent。Overlay 与 Git worktree 完全并列，服务于同一 Local 工作区多个对话的文件修改隔离与冲突整合，不负责 Git 工作区管理。受控发布、Local WinFsp 双挂载、`.git` 屏蔽、真实 Sandbox 并行/取消/重挂载、原生捕获/冻结导出、Windows owner/group/DACL 保留发布及成功后确认/续轮刷新的 PoC 已验证；Engine 内部生命周期、明确选择发布和候选 Sandbox 命令已接入；模型选择工具和显式创建/状态入口已接入，真实 IPC v18 安装验证及恢复操作仍待完成，不改变现有服务或历史会话。

## 需求与模式

公开入口实施增量：在保留现有默认 Riftri/显式 Worktree 的同时，新增显式“隔离 Local”创建。HTTP 请求携带 `localOverlay:{id}`，与其它创建模式互斥，无 commit/branch；来源可以是普通非 Git 目录。首批公开创建、启动和恢复只接受 Windows 且 Sandbox 已启用，helper/驱动/运行时仍按真实启动验证，失败不自动改用其它模式。会话列表、快照及历史分页都返回单独的 Local overlay 元数据并按来源项目归组；错误清单仍可查看历史，不能把失效卷降格成普通目录。任务要求 Sandbox 时，Local 的启动失败不转宿主执行。该入口的源码/模拟测试不能替代待 Repair 后的真实 v18 验收。

2026-10-25 用户追加授权：继续验证完整方案，自审通过后接入 agent，实现安全、低消耗的多 session 并行工作。此授权不把 PoC 通过等同于产品完成；以下验收项持续跟踪，尚未通过的项目不得用其它阶段结果替代。

- 文件系统：Local 专用模式隐藏所有层级的 `.git` 文件/目录，拒绝重新创建和改名引入，保留普通源码配置文件；重挂载不得降级为允许私有 Git 的旧模式。
- 按需捕获：创建不枚举或复制来源；实际访问/修改时记录基线、变更与读版本，覆盖 shell 临时替换、删除、新建、rename 和二进制；导出时停止写入，不能猜测基线。
- 发布：按来源串行预检、冲突保留、合并候选验证、提交前复核、Windows 权限保留、成功后的会话刷新；失败/取消/未知结果保留现场，不盲目重放。
- 产品：入口、任务调度、来源身份/项目记忆、视图工具/Skills/subagent、历史/续聊/恢复、发布状态与冲突操作联动；普通 Worktree 保持独立，旧历史不静默迁移。
- Sandbox：真实专用账户执行及取消/恢复，精确授予视图，不为新 Local 模式追加来源/common Git 写根；不把宿主执行或 `.git` 隐藏描述为完整安全隔离。
- 验证：大文件树的创建耗时、目录枚举/读取计数与私有磁盘成本，真实并行任务和故障恢复；完成实现后自审，再按平台声明结果。Windows 优先，POSIX 实现与验证仍需独立完成。

- Local overlay：以当前实际目录为来源，可以用于非 Git 目录；多个会话拥有各自私有写层，最终将选定文件变更发布到该目录。
- Git worktree：保留现有按 Git 提交建立独立工作目录、HEAD/index 和分支工作流的实现。它不是 overlay 的 fallback，两者不互相替代。
- Overlay 不创建 commit/branch、linked worktree、Git index 或对象库，不解析 Git tree/blob，不承担 Git merge、push 或 PR。源文件的未提交状态自然可见，无须为此定义 Git 语义。
- 不在这次设计讨论中删除 D168/D169 代码、迁移已有会话、切换默认模式或自动回写文件。D169 的性能结果只描述旧实验，不能直接推导此方案性能。

## 建议结构

```text
主目录 ──实时读取──> 会话 A 的合并视图 + 私有写层
       └实时读取──> 会话 B 的合并视图 + 私有写层

A/B 的变更集 ──> 按来源目录串行的发布协调器 ──> 主目录
```

来源目录是工作文件来源；每个会话的内容写入、新建、删除和重命名先保留在私有层。首版沿用 Windows WinFsp 的路径/ACL/upper 基础，不建立 Git lower。Linux/macOS 后端需独立设计和实机验证，不把现有逐文件 Riftri CoW 当成免遍历实现。

Overlay 本身只解决写入分离。发布协调器负责变更范围、版本复核、冲突、恢复与来源目录写入；不允许把 upper 当成普通文件目录直接覆盖来源。

## 基线与一致性取舍

目录分页优化已接入：Local 单个打开句柄的同一次枚举使用 WinFsp 原生目录缓冲，续页不重新读取 lower；显式重启枚举或新句柄重新观察来源，关闭释放缓冲。只固定本次枚举的名称/元数据，不缓存文件内容、不改变路径打开和写入前检查，也不承诺目录变化的发布依赖完整性。缓冲容量按该句柄枚举条目的高水位增长，restart 可复用容量而非立即归还内存；填充失败会清空半份结果；旧 Riftri/Git 路径保持原回调。512 字节 Win32 实验已验证多页、跨 UTF-16 排序边界的 Unicode、同句柄重启、不同句柄、来源新增/删除和私有 whiteout。十万文件首次/再次遍历进一步为 75.51/12.38 s，lower 枚举 1001 次、打开 310003 次；计数和原始证据见成本报告的 `afterDirectoryBuffer`，同机单组测试不作普遍加速承诺。未测进程峰值内存，超大单目录或大量并发目录句柄仍有缓冲成本。

Local 首次枚举优化：目录枚举期间发现的新 lower 条目共享一次 SQLite 事务，普通路径 lookup 仍独立提交。保留 FULL 同步、逐文件来源身份/ACL/链接检查、稳定 inode、原有 dirty/clean 及失败回滚后停止使用视图的保护；不更改持久格式或把 live lower 当快照。`lowerImportCommits` 仅为进程累计计数，无路径/内容；旧 helper 缺少此可选字段仍可读取，其性能验收必须使用提供计数的新构建。此优化只减少首次元数据导入的提交次数，不能消除遍历/数据库增长或整文件 copy-up。

大目录验证计划（2026-10-26）：使用独占合成普通目录，分别测空目录、一万及十万文件树的原生挂载与生产 LocalOverlayService 创建。创建期读取原生 lower 打开/枚举计数并核对零内容对象；再测首次完整目录遍历、有限内容读取和单字节修改大文件的增量。磁盘使用 FILE_STANDARD_INFO 的 AllocationSize，区分 SQLite/对象/基线及总控制目录；排除来源准备、测量工具本身、NTFS MFT/目录索引/日志。此测试不清空 OS 缓存、不运行 Git status 或 Sandbox，也不把合成目录性能扩大为大型真实工程构建结论。脚本仅手动执行，失败保留现场、正常关闭自身挂载。

该计划已完成 Windows 合成夹具验证，执行 `pnpm overlay:verify-scale` 可复跑（可选 `--count=1000`）。优化后的十万文件三次生产创建为 72～79 ms；原生挂载控制文件实际分配 228 KiB，lower 打开/枚举与内容/基线对象均为零。首次完整遍历由 172.90 s 降为 87.33 s，导入提交为 1001 次，SQL exec 由 76.29 s 降为 1.29 s；这是同机两次运行，不承诺相同比例的普遍加速。遍历后元数据分配约 64.65 MiB，仍有 735024 次 lower 打开、3012 次枚举；后续仍值得优化重复枚举与路径/ACL 开销。修改 64 MiB 文件的一个字节仍新增约 128 MiB 原文/私有内容，属于整文件 copy-up，不是块级 CoW。摘要见 [大目录成本报告](local-overlay-scale-results.json)，不能用创建常量成本掩盖访问与修改成本。

当前实施增量：Local 原生层在内容读取时记录来源文件身份、大小、最后写入时间和 ChangeTime 等版本标记，不复制整文件；首次命名空间/内容修改前复核已观察版本，在禁止并发写入/删除的来源句柄下保存不可变 B。普通内容 copy-up 从同一 B 生成 O，避免两次读取不同来源版本。创建、删除和 rename 分别记录目标路径首次状态；临时文件最终消失可以保留空到空记录，发布批次构造时再消除。来源更新仍可被读取，但同一观察周期中旧版本对应的修改不能悄悄接受，需要后续受控刷新。此机制不承诺对恶意改写元数据、任意 shell 的全部跨文件依赖或目录原子快照提供隔离。冻结结果及有界发布批次构造已实现；成功发布后的刷新及失败/取消后的新观察周期均已有独立 Windows PoC，Engine 生命周期和公开显式创建入口已接入，真实 IPC v18 安装链路仍待验证。

建议默认接受实时 lower：尚未私有化的文件可随主目录变化；它不提供启动时的全目录快照，也不保证一个长期运行的命令看到跨文件一致版本。

对准备修改的普通文件，保留不可变的编辑基线 B、会话结果 O 和来源当前内容 T。基线保存与首次私有化需要协调，不能只留下被随后写入覆盖的 upper。新建保存“此前不存在”的前提；删除与重命名也保存原路径、目标路径和原内容身份。仅对涉及的文件保存内容与计算所需摘要，不在会话创建时遍历、hash 或复制整库。

基线必须对应编辑实际依据的版本。现有 `FileEditor.prepare/verify` 已检查任务读取哈希与写前内容，可接入版本和读记录；不能等发布时才把新来源内容当成旧基线。读取后来源变化时，受控编辑应拒绝并要求重读，不能盲目重试旧补丁。

任意 shell 命令的读取、计算和稍后写入更难：单纯首次写入 copy-up 不能证明命令此前读过的内容仍有效。首版需明确区分“写入已隔离”和“读依赖一致性已保证”；对已知读版本/来源代次变化要求重新检查或重跑相关验证，不宣称完整 serializable 事务。要获得更强的重复读取语义，需要首读固定内容或文件系统快照；全量扫描时前者可能缓存整库，不能同时承诺零遍历、零拷贝和启动时完整快照。

### 原生自动捕获与冻结验证

`pnpm overlay:verify-capture` 通过真实挂载读写普通非 Git 夹具，不预先声明编辑基线。首次读仅记录版本；首次写/替换/删除/rename 保存原文，二进制同样按字节保存；新建后删除保留 absence 到 absence 的原始记录。普通首次内容修改保存 B 和 O 两份内容，成本与修改文件大小相关，不能称为文件内部块级 CoW。首次创建和纯读取均没有私有内容对象，创建期 lower 打开/枚举计数为零（不含固定根身份句柄）。

实测覆盖：主目录同长度修改并恢复 mtime 后，覆盖、删除与临时替换仍被拒绝；属性操作已经记录 B、但尚未私有化内容时，后续来源变化也拒绝旧基线复用；已私有化的文件继续编辑不改原始 B。读取前后版本校验只覆盖单次原生读取，不将多次读取声明为原子快照。

`OverlayManager.withFrozen` 要求调用方先排空任务进程，然后发送原生 `freeze`：停止 dispatcher、撤销卷、仅按已捕获路径写入 `sealed_changes`。helper 继续持有控制目录独占租约，宿主只读导出；收到 frozen 前不读取，导出时失去 helper 不返回成功结果，结束后等待正常 stopped/exit。实测冻结后挂载不可访问、封存内容可读、第二个 helper 不能接管；干净退出后可恢复私有状态。旧普通模式不接受 freeze。生命周期复用 `overlay.local_freeze` tracing，仅记录 ID、状态与耗时。

首次捕获实验使用 v4，发布确认实验使用 v5，续轮与私有读依赖传递使用当前 v6；旧 v3 没有原文记录，v4 没有修改代次关联，v5 缺少对象来源/私有读传递，均拒绝自动转换或猜测旧依赖。旧 D168 v2 格式保持不变。封存表中的目录、重解析及尚未私有化的 live 内容有独立类型，不自动当普通文件发布；复杂目录重命名、显式权限修改发布仍未支持。原始结果见 [捕获报告](local-overlay-capture-results.json)，各格式重跑见 verification。

### 原生结果到发布 PoC 的衔接

`pnpm overlay:verify-filesystem --native` 不再调用 `EditSession.read/edit` 建立 B。真实子进程的读写和临时替换触发原生捕获，随后 `native-batch.ts` 在冻结租约内仅提取选定路径的 B/O、消除相等结果，拒绝目录、链接、显式属性修改和未私有化的内容。不会从当前 lower 重建 B；选择了最终无变化的已读文件时，它仍作为依赖参与检查。

选择的子文件只要存在已捕获变更的祖先目录，也保守拒绝，不能绕过目录 rename/new-directory 的未支持边界。否则外部随后建立同名目标目录时，子文件可能被错误地绑定到新的目标基线。普通内容 copy-up 固定父目录不会自动产生这种目录变更记录。

其它已读取路径先获取宿主内容版本，再调用冻结 helper 的 `check-reads` 复核原生首次观察版本；失效或缺少收据拒绝生成批次。Publisher 继续在验证后、应用前复核这些内容版本。此路径不是完整 shell 事务隔离：外部写入仍不受协调锁约束，读取的目录/缺失路径及工作区外状态不属于完整依赖集；暂沿用 PoC 的最多 100 个观察文件、100 个变更、单文件 2 MiB 和批次 16 MiB 限制，超限明确失败。

Windows 实测：两个挂载独立修改同一文件，私有程序输出 `12` 和 `21`；自动捕获的原文均为初始版本。只选择 `module.mjs`，在每次全新的临时候选 overlay 运行语法检查和程序，结果依次 `12`、`30`，来源最终 `30`。临时候选看不到未选择的 `generated.txt`，也不覆盖原会话修改；原视图重挂载仍是 `12` 和 `21`。该脚本特意不确认，保留旧视图作对照；新增刷新脚本验证确认后的续轮行为。另一个真实挂载测试确认未选择的已读文件过期时返回 `STALE_DEPENDENCY`。[自动发布桥接报告](local-overlay-native-batch-results.json)。

这仍是手动宿主 PoC，不是生产自动发布：明确路径由实验指定，尚无产品源码选择入口；未知发布后的恢复操作要继续接入。Windows 已追加下述 owner/group/DACL 保留替换及独立刷新实验；默认不带 `--native` 的脚本保留先前显式基线对照。

### Windows 原生发布与权限保留

`pnpm overlay:verify-native-publish` 与 `overlay:verify-filesystem --native` 已接入原生发布短命令；默认不带 `--native` 的对照仍沿用旧 rename。显式 `nativeWindows` 不允许缺 helper 时降级。原生代码固定同目录候选，持有祖先目录句柄并拒绝 reparse/多硬链接等不支持文件；以系统 BCrypt 复核前后 SHA-256，将来源实际 owner/group/DACL 应用到候选，再调用不忽略元数据错误的 `ReplaceFileW`。替换后再次核对正文与完整 owner/group/DACL SDDL，只有正常退出和成功收据同时存在才确认。

相同 owner/group 不重复申请 `WRITE_OWNER`；不同时先应用来源原有 DACL，再按它真实授予的权限设置原 SID，不能为方便发布额外增加权限 ACE。使用文件系统 `SetSecurityInfo` 保留 NTFS 自动继承标记；测试发现通用 `SetKernelObjectSecurity` 会改变这一控制位，因此未降低 SDDL 一致性断言来绕过差异。来源的显式写拒绝、陈旧哈希、硬链接及独立 junction 夹具均在来源改动前被拒绝。

原生替换把原文件保留为同目录、随机批次命名的 `.codeatelier-publish-*.backup`；路径先写入 intent，替换后核对真实备份的身份、原文和安全描述符，成功收据再记录 volume/file ID。部分失败或收据丢失保留备份、候选与 unknown 日志/协调锁，不自动重试。整批 complete 日志持久化后才按备份身份和原文 hash 打开句柄删除；备份被替换或修改时保留并返回 `cleanupPending`，不把已完成的发布改写成 aborted。后台清理或跨会话恢复尚未接入产品。

NTFS 实测覆盖保护 DACL、显式拒绝 ACE、与候选不同的 primary group、原有命名流保留、错误备份身份/内容拒绝清理、写后故障保留及重放拒绝。夹具只修改自身文件 ACL，不申请系统提权；异属主情况下所需权限不足仍会拒绝，不保证任意 foreign owner、SACL 或完整性标签保真。现阶段仅支持有界普通文件；不声明外部写入 CAS、多文件原子提交或断电保证。官方 API 的部分失败状态也是保留 unknown 的理由。[ReplaceFileW 语义](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)、[文件安全描述符设置](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo)。结果见 [原生发布报告](local-overlay-native-publish-results.json)。

观测复用 `local_overlay.apply/cleanup` trace 和批次关联 ID。helper 错误仅提供固定阶段号与 NTSTATUS；stdout/stderr 不包含路径、正文或安全描述符。候选/备份路径仅保存在私有 journal，不能写入 Perfetto 属性。

## 文件发布建议

### 模型选择工具（2026-10-26）

主任务的 `local_publish` 只登记或撤销本轮计划：`request:{action:"select",paths:["src/example.ts"],commands:["pnpm test"]}` 替换整个选择，`request:{action:"clear"}` 清空选择但保留私有修改。选定路径和命令不允许附带工作区、任务 ID、环境或权限覆盖；路径由来源服务重新校验。每个模型响应最多一个选择调用，避免并发覆盖；下一轮不继承计划。工具返回 `{selected:1,published:false}` 只表示登记成功，候选验证和来源写入仍在成功且已排空的收尾阶段发生。

入口只对 Broker 验证的 Local overlay 主 Runtime 启用；普通 Local、Worktree、宿主 fallback、候选 Runtime 和只读子任务不声明此工具，也不能通过伪造调用获得能力。Runtime IPC v18 增加显式能力标志及 `local_publication` 请求；Broker 用认证连接身份路由，并核对当前已记录调用 ID/名称/参数，不能指定另一任务或来源。旧 v17 握手拒绝，真实安装升级必须显式进行，源码构建和 stdio 子进程测试不替代安装态验证。

选择事件留在正常脱敏历史；工具 trace 只保存阶段、关联 ID、耗时与状态，不保存选定路径和命令正文。当前仅接入 Sandbox 验证计划；显式创建/状态 UI 已接入，宿主候选执行、恢复操作以及 POSIX 仍未完成。`pnpm overlay:verify-sandbox --commands` 已改为固定 provider 返回真实工具调用，包含模型→Runtime→Broker→候选 Runtime→发布链路；其安装态执行结果必须单独记录。

### 候选工程验证器（2026-10-26）

产品执行接线增量：验证命令以有界、明确顺序的计划绑定当前任务，成功收尾时由 Broker 启动另一份既有 Agent Runtime，仅把候选视图作为工作目录，不授来源/Git 写根。固定命令序列通过现有 `run_command` 与 IPC 执行，不调用真实模型、不继承主会话上下文，不提供宿主权限扩展或 MCP；每条命令的实际回执决定是否继续。所有回执与执行实例归属原任务，取消须等待 stopping 与平台 clean。缺 Sandbox 或启动失败不转宿主执行验证。此内部接口现由任务绑定的模型工具调用，公开 UI 尚未接入；普通宿主执行适配器仍需独立按原权限接线。

候选验证建立一次性 Local 视图，以主目录为实时 lower，只写入 Publisher 已计算的合并候选；不叠加原会话未选文件，不遍历或复制工程。可信执行适配器在该目录运行验证，必须返回真实执行模式及进程树排空结果；异常或排空未知不能按普通验证拒绝恢复会话。此适配器不自动提升权限，Sandbox 启用时不得把宿主 fallback 当作验证成功。

`src/local-overlays/candidate-validator.ts` 已实现一次性视图与可信 `CandidateExecutor` 契约，`candidate-reads.ts` 在冻结租约中核对选定文件仍等于输入候选（验证命令自行修复源码不算验证通过），提取新读取的来源版本，经原生观察复核后交给 Publisher 在应用前再次检查。凭据保存到 journal 的可选 validation 字段；旧日志不伪造依赖。目录枚举、缺失路径及工作区外依赖仍不属于完整读取集；沿用有界文件限制，不宣称任意测试的完整事务隔离。正常卸载后才删除一次性 UUID 控制目录；未知状态保留，不恢复或重跑命令。内部执行器若抛异常而未交付排空证明，按 unknown 处理，不降为可续聊的普通拒绝。

`pnpm overlay:verify-candidate` 以生产 Engine、固定内存 provider 与已安装专用账户 Runtime 验证真实候选命令；来源发布仍由生产 Publisher 执行。脚本提供可信执行适配器，核对 Runtime 终态、无 fallback 和零活动租约，验证真实合并结果、新读依赖与取消；不需要修改 IPC 或安装 Runtime。该脚本最初验证时模型工具、产品执行适配器与公开入口尚未接线；后续实现见上节，不能将旧脚本结果视为新 v18 安装链路已完成。

### 发布确认与下一轮观察（Windows PoC）

发布与视图确认分开记录：来源 journal 已 complete 才允许在仍持独占冻结租约的 helper 中确认。确认按 batch ID、冻结标识、观察代次和明确路径形成持久收据，只释放这些普通文件的私有命名空间覆盖和基线；未选择的修改、产物及历史对象保留。确认失败返回 refresh-pending，不能将来源 complete 改写成未发布或重做来源写入。下一轮须干净重挂载，以清除旧句柄和缓存。

不能直接清空所有读记录：未发布的旧修改可能依赖上一轮读取。实验格式新增观察代次及路径修改与代次的关联；确认后开启新代次，旧修改保留旧依赖，新修改使用当前代次。后续编辑已有私有文件也关联新代次。导出检查选中修改涉及的代次和当前代次，不把旧依赖伪装成新读取。首次实现保留历史对象/观察记录，不扫描来源或自动垃圾回收；异常退出仍拒绝自动恢复，幂等确认只在可验证的干净状态下使用。

`pnpm overlay:verify-refresh` 已在真实双挂载验证：私有输出 `12/21` 合并后来源和两个刷新视图均为 `30`；下一轮修改后来源 `120`。未选产物保留，发布时旧依赖过期仍拒绝。确认后模拟收据丢失，来源日志保持 complete、refresh 保持 pending；同一冻结租约和后续干净重挂载重复确认均幂等，不删除其间新产生的私有编辑。新建/删除确认释放对应覆盖，外部重建的文件可见。原生只复核相关代次的观察，不随每次确认重新扫描历史读集；历史记录/对象暂保留，不声称磁盘已回收。

收据绑定批次 ID、冻结标识、原代次和规范化选择；选择不同、代次过期，或尚未执行的旧确认来自另一冻结快照时拒绝。已经提交的完全相同收据才允许跨干净重挂载幂等返回。自审回归先复现了“确认前中断、重挂载后又编辑、重放旧确认会删掉新编辑”，随后用每次冻结的新标识修复；不只依赖观察代次，因为未确认时它尚未增加。

源发布前检查确认请求的大小/格式，来源 complete 后单独记录确认终态。trace 增加 `overlay.local_acknowledge` 与 `local_overlay.refresh`，只含 ID/耗时/状态，不含路径或正文；确认无可信回执记为 unknown。后续增量补充了下述恢复和显式内容回收；失败/取消的新观察周期见下述 v6 增量；产品恢复入口及大读集开销仍待实现。本实验没有改变用户会话。结果见 [刷新报告](local-overlay-refresh-results.json)。

### 冻结租约失效、取消与排空（Windows PoC）

`withFrozen` 现在向回调提供失效信号，helper 故障、调用方取消或管理器关闭都会中止它；取消后等待回调结束，再卸载。它不再通过 Promise.race 提前结束仍有副作用的宿主回调。重复关闭共享同一次卸载；冻结作用域排空前保留 helper，已失去 helper 时也仍等待宿主回调完成。忽略取消而未结束的回调继续保持 draining，不提前宣称已停止或开启新任务。

Publisher 在候选验证和逐文件写入边界检查信号，并传给验证函数；刷新脚本使用已有 `executeProcess` 停止验证进程树并等待 close。在途原生替换等待确切退出，不靠杀死发布短命令假定写入未发生。写入前取消记录 aborted 并释放来源锁；部分写入后取消记录 unknown、保留原文备份与锁，不继续下一文件；全部写入已确认后发生取消保留 complete，但不启动新的视图确认。日志区分来源已完成和视图 pending。

`pnpm overlay:verify-drain` 在独占夹具中终止本脚本拥有的原视图 helper：验证阶段真实 Node 父子进程退出后回调才结束，来源两文件均未改；首文件发布后故障则次文件未改、备份为原文、日志/锁保留，重试被拒绝。匹配 PID 时限定本进程子 helper 和控制目录，不终止产品服务。此脚本是宿主故障验证；Sandbox 产品发布、未知恢复和不合作回调的人工处理入口仍待接入。结果见 [排空报告](local-overlay-drain-results.json)。

### 已完成来源的视图恢复 PoC

恢复按来源状态分流。complete/refresh pending 可进入不写来源的恢复：仍需来源协调锁、干净冻结视图和完整 journal。若原生已有完全匹配的确认收据，只重获该收据；否则逐一核对发布前保存的私有检查点，包括控制目录身份、基线/结果映射、相关观察代次及 B/O 对象的内容与文件版本。全部未变才生成绑定当前冻结标识的新确认请求；任何后来修改、缺失证明、格式不兼容或异常私有卷均保留 pending，不丢弃内容。原请求及恢复请求分别留存，收到确认后才更新完成状态，重复恢复不写来源。

unknown/applying 不走这条路径，也不因为当前内容等于候选就解锁。JSON 协调锁不能独立证明旧进程及其在途原生写入全部退出；下节的原生执行排他与明确现场接受协议单独处理未知发布。恢复验证只使用新建实验夹具，不修改真实用户数据。

`Publisher.recoverRefresh` 已实现上述协议。`nativeBatch` 只为明确选择的修改补充私有检查点，额外读取/校验这些 B/O 文件，不遍历来源或在创建时计算 hash。日志读取限制类型/大小、验证批次归属并复核读取前后身份；恢复写入前检查日志摘要。原生格式仍为 v5；旧日志没有检查点时只接受已经存在的原生确认收据，不能生成未执行确认的新证明。恢复 trace 使用 `local_overlay.recover_refresh`，不记录路径、正文或版本摘要。

`pnpm overlay:verify-recovery` 在独占夹具中由独立 Node 进程发布、干净卸载退出，再由新进程读取日志并恢复。确认前中断后允许未变 B/O 绑定新 seal，外部后来修改的来源保持不变且在刷新视图可见；原确认/恢复确认丢失回执后，幂等重试保留后来私有修改。未执行确认且私有状态变化时拒绝清理，未选产物始终保留。结果见 [恢复报告](local-overlay-recovery-results.json)。这是干净退出的持久恢复，不是宿主/helper 强杀、断电、未知来源解锁、Sandbox 自动发布或产品入口验收。

### 未知发布执行排他与明确现场接受 PoC

Windows 原生发布使用单个 `PublicationLease` helper 持有来源协调目录内的独占句柄，串行处理替换、新建、删除和备份清理；Publisher 不再为这些动作启动短命令。私有 `execution.lease` 记录宿主/helper 的 PID 与创建时间、generation 及显式结束状态。EOF/强杀不写成正常结束。检查必须取得独占句柄、核对 generation 并证明旧 helper 已终止；未显式 finish 的 active 记录还要求旧宿主已终止。权限不足、损坏记录、身份不明均保留阻塞。显式 finish 表示原生执行排空，不等于批次成功；未知来源协调锁仍保留。租约失败的信号和冻结视图信号组合后交给候选验证，任一失败都必须排空候选进程。

`Publisher.reviewUnknown` 在检查租约内返回逐文件 B/O/T、记录状态和绑定 journal/锁/现场版本的审核 token，不写来源。`acceptUnknown` 明确接受当前现场，重新取排他并核对 token 后先保存 `reconciled` 决定，再由仍持排他的 native helper 按哈希和文件句柄删除固定 `publish.lock`，避免宿主 check/unlink 竞争。原批次永不重放，不补齐未发布文件、不回滚已发布文件、不确认/删除私有编辑或备份。已落盘决定而解锁失败可重试；重复已完成决定不会删除新所有者的锁。`reconciled` 不等于 complete，不能调用完成态视图确认。支持有证明的 applying/unknown，以及执行排空失败留下锁的 aborted；缺少证明的旧记录拒绝迁移。

`pnpm overlay:verify-lease` 真实验证了活跃 helper、helper 已死但宿主仍活跃、宿主已死但 helper 仍活跃、双方退出、错误 generation、首文件发布后宿主直接退出，以及陈旧审核拒绝和接受当前现场后新批次继续。来源只保留已经发生的修改与外部后续修改，旧备份保留。结果见 [执行租约与未知恢复报告](local-overlay-lease-results.json)。`overlay:verify-drain` 额外覆盖发布 helper 被终止时，组合信号排空真实候选进程树；视图可干净关闭，但无法证明执行 finish 时仍保留锁。

边界：这是 Windows/NTFS 宿主 PoC，不排斥非 CodeAtelier 外部写者，不声称多文件原子性或断电证明。宿主仍活跃但 helper 被强杀时保守拒绝接管；尚未建立匹配执行记录的孤立锁、异常私有卷恢复、产品审核入口、POSIX、对象回收及完整任务生命周期仍待接入。每个来源只新增常量大小执行记录，不扫描来源。trace 增加 `local_overlay.execution_lease` 和 `local_overlay.unknown_review/unknown_accept`，不含路径、正文、token 或版本摘要。

句柄与进程终止判定依据 Windows 官方 [CreateFile 共享语义](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)、[进程时间](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes) 和 [等待函数](https://learn.microsoft.com/en-us/windows/win32/sync/wait-functions)。

### 失败或取消后的新观察周期

续轮不等于确认发布。新增冻结控制 `next-epoch` 只根据请求 ID、当前 epoch/seal 持久化幂等收据并增加观察代次；不删除修改、基线、读取记录，不写来源，也不自动发布。正常排空后冻结，再由宿主以独立清理生命周期显式调用，下一轮干净重挂载。旧修改仍关联旧代次；只读后失败而未编辑的路径，下一轮可以重新读取当前来源后编辑。原生确认已完成时通常已有新代次，不必重复推进。

只增加 epoch 会漏掉跨轮私有内容依赖。Local v6 增加 object_epochs（私有内容来源代次）和 epoch_links（本轮读取私有内容所依赖的较早代次）；写入前关联对象与当前/路径已有代次，rename 不丢失对象关联。读取私有文件时建立向旧代次的边；导出从当前代次、所选路径及结果对象的关联出发，展开有界依赖闭包，再复核对应来源观察。新文件不能借读取旧私有结果绕过原有依赖。重复边去重，不扫描来源；超出既有 100 代次/读取限制拒绝导出。

v5 没有完整私有读传递记录，不能猜测迁移或把缺失依赖当作空集；新 Local helper/导出使用 v6，旧 v5 实验卷保留且拒绝自动恢复，D168 v2 与 Git worktree 不变。旧已确认收据可在同一 v6 卷幂等重取，未执行的旧 epoch 请求跨冻结拒绝；来源 complete 的 pending 确认仍走既有检查点恢复。保留旧私有修改的过期依赖是预期行为，重新计算/显式解决冲突另行处理。此机制只覆盖已捕获文件读取，不承诺 LLM 历史、目录或外部依赖的完整事务隔离。

`withFrozen` 第五个回调参数提供 `nextEpoch(request)`；只在 dispatcher 销毁且租约有效期间可用，与确认/回收/读取复核互斥。trace `overlay.local_next_epoch` 保存 ID、开始/结束、耗时与未知终态，无正文或路径；收据绑定错误、丢失或 30 秒超时均不能假定推进未发生。正常取消命令后必须先证明进程排空，再以独立清理信号进入冻结，不能复用已取消信号也不能继续执行任务命令。

2026-10-26 `pnpm overlay:verify-epochs` 真实命令以 7 退出、另一命令在写入和重命名后被取消并排空；两者均未自动发布。新周期重新读到当前来源并能发布独立修改；旧私有结果经过 rename 和两轮派生后仍继承过期依赖，在内容回收前后均拒绝导出。已提交推进请求在重挂载后重取收据，不再次增加 epoch；未执行旧 seal 请求拒绝并保留异常卷。[实验摘要](local-overlay-epochs-results.json)。这不等于产品任务自动续轮、Sandbox 清理或异常私有卷恢复已完成。

### 冻结后的私有内容回收

本增量只回收私有内容，不清理发布 journal、确认收据或历史读依赖。`collect` 只能在 Local dispatcher 已销毁、Store 独占租约仍有效且未 poisoned 时调用；不在创建或挂载时执行。宿主在冻结回调内显式调用，回收失败不能反向改写来源 complete 或确认结果。

引用根包括所有 namespace entries 的目标、父目录及其祖先、根 inode、全部未释放基线和 sealed_changes 内容。先在 FULL SQLite 事务中删除无 namespace 引用的 inode，再以仍存活 inode/冻结结果/基线的对象名保护内容；持久引用删除完成后才删除物理文件。中途退出只留下可重试的孤立内容，不让数据库引用已删除对象。未确认、冲突及未选择的修改仍有基线和命名空间引用，不能因来源已变化而回收。

仅枚举控制目录中固定的 objects/baselines 两个平面目录；只接受生成的 GUID 名称，打开时拒绝重解析、目录和多硬链接，按已打开的文件句柄删除。不递归、不清空目录、不改变 ACL；未知名称/类型、占用或权限失败保留并计数。根目录由既有拒绝 rename/delete 的句柄固定。回收成本与私有存储规模有关，不访问 lower，也不枚举整个 repo。保留仍有 entry 的历史节点及数据库空闲页；不将逻辑内容字节减少宣称为全应用磁盘完全回收。

`OverlayManager.withFrozen` 第四个回调参数提供 `collect()`，回收/复核/确认控制请求互斥，离开冻结作用域后拒绝调用。trace `overlay.local_collect` 记录开始/结束、ID、耗时和失败/未知终态；计数日志记录扫描数、删除数、逻辑字节和保留数，不含路径或正文。当前收据等待上限 30 秒；超时停止继续控制操作并走既有 helper 排空，不伪造回收全部完成。产品尚未自动调度此操作。

2026-10-26 `pnpm overlay:verify-collection` 实测：连续五轮修改约 256 KiB 的同一文件，每轮确认后回收 524,304 字节 B/O，私有内容均回落至 131,100 字节（未选产物、未发布修改与移动目录内容），未逐轮累积。未执行确认前回收不破坏检查点；已确认但回执丢失时，物理 B/O 回收后仍可凭收据恢复；旧收据重放不丢弃新修改。过期读依赖仍被拒绝，硬链接/junction/目录/未知文件保留，只读孤立文件解除只读后重试成功。原始摘要见 [回收报告](local-overlay-collection-results.json)。仅是 Windows 宿主夹具，不是全应用磁盘上限、断电证明或 Sandbox 自动回收验收。

### 未开始和已完成发布的残留锁恢复 PoC

新原生发布将 v2 协调锁 ID 直接用作执行 generation，并在锁内记录 batch ID。`publicationClaim` 只提供待核查的原生锁身份，不宣称执行已停止。`releaseUnstartedLock` 要求匹配的原生租约证明旧执行排空、明确记录尚未开始来源写入、且对应 journal 确实不存在；任何现存 journal（包括损坏文件）都不走此路径。原生执行记录 v2 在第一次替换/新建/删除/备份清理前 flush `mutated`，因此后来删除 journal 不能抹掉写入证据。旧 v1 记录按可能写入处理，旧 helper 缺少该字段时不默认 false。Local 文件视图数据库仍为 v5，没有迁移私有文件。

`releaseCompletedLock` 核对 complete journal、执行 generation 与原锁摘要后只释放协调锁；不改来源完成态、文件、私有编辑或视图 pending 确认。两条路径都在原生排他内再次检查前提，先保存恢复决定，再由原生按句柄释放固定锁。缺失锁可重复调用，旧锁身份不能删除新所有者的锁，恢复 trace 不包含路径、正文或版本摘要。

`pnpm overlay:verify-residual` 在真实宿主子进程中分别于原生 ready 后、Publisher 结束执行租约前直接退出，验证无 journal/complete 两种残留锁；错误锁 ID、损坏 journal、原生已写但 journal 被删除均拒绝，恢复后新批次可以继续。来源后续修改和完整 journal 保留。结果见 [残留锁恢复报告](local-overlay-residual-results.json)。尚未建立匹配执行记录、记录损坏、未知私有卷及产品 UI 的恢复仍未完成；不根据单独 PID 或文件缺失推断安全。

### 完整发布流程与后续产品接入

1. 会话准备有明确文件范围的变更集。区分应发布文件与临时文件/缓存/构建产物；规则独立于 Git，不能默认把全部 upper 发布。
2. 按来源真实目录身份进入发布队列。同一来源的所有 CodeAtelier 发布和直接写入路径需要共同协调，不能只按不同挂载路径认为互不影响。
3. 对变更集全部路径先复核：路径未被链接替换、目标存在状态、文件类型、权限，以及 B/O/T 内容版本。发现冲突先保留整个候选集，不先发布其中一半。
4. T 与 B 相同：可发布 O。O 与 T 相同：视为已满足，不重复写。双方都变化的普通文本可尝试有界三方合并；无文本冲突不等于语义正确，需要验证合并后的候选内容。
5. 同段文本冲突、二进制双改、删除对修改、同名新建、复杂目录 rename 和权限冲突保守拒绝自动整合。返回有界冲突信息，由会话在最新基线上处理；自动修复次数和人工接管入口需要明确，不无限重试。
6. 将最新候选放回隔离视图运行必要验证，验证后发布前再次检查来源代次/内容。排队期间来源又变化则使候选失效，不将旧测试结果当成最新结果。
7. 写入使用预备文件、逐文件替换、发布日志与原版本备份；成功后记录来源代次和新基线，清理只属于此次成功发布的私有增量，并作废对应读取缓存。

用户于 2026-10-25 确认：每轮成功完成后自动发布明确选择的源码变更；冲突或验证失败时保留私有修改。不是每个写工具立即同步，也不把全部 upper 当作源码发布。失败、取消不自动发布；该生命周期尚待实现与验证。

队列只能串行化参与协调的 CodeAtelier 写入者。外部 IDE、终端或构建工具不受应用锁自动约束；需要检测其变化并停止过期发布，但普通跨平台文件替换不提供通用的内容 compare-and-swap。不能宣称任意非合作外部写入下完全无竞争。多文件发布也不是文件系统级原子事务：预检避免已知冲突的部分发布，执行中故障仍可能部分完成；日志必须区分 published/failed/unknown，恢复检查真实内容，不盲目重放或覆盖后续外部修改。

## Git 与其它共享状态

不实现 Git 隔离是此方案的边界，不代表可以安全地把共享 `.git` 当普通源码自动合并。建议 `.git` 等管理状态不进入可发布集；隔离视图不提供会话私有 Git 工作区。Git CLI 的写操作在文件发布后进入主目录协调执行，需要独立分支/暂存区的任务选择现有 Worktree 模式。具体可见性和执行路由需明确设计；不能只靠提示词禁止绕过，也不能偷偷提供失真的 Git status/commit。

同样，端口、进程、外部数据库、网络副作用和工作区外文件不被文件 overlay 隔离。MCP、获批宿主命令以及绝对来源路径均可能绕过挂载，必须在产品接入时明确归属；不能把“cwd 指向 overlay”称为全面隔离。

## 系统联动与可复用部分

- 调度使用两个身份：逻辑来源目录用于项目分组、共享记忆、发布/共享状态协调；会话实际挂载用于隔离执行。当前同真实目录串行规则不能直接删除。
- 文件工具、命令 cwd、AGENTS/Skills、只读 subagent 使用会话视图；执行上下文和历史固定记录来源、视图及发布代次。显式来源路径和宿主执行不隐式重写为另一位置。
- Sandbox 仍只授权会话挂载及显式许可根。发布由宿主协调器按既有工作区写入政策执行，不能为方便回写向 Runtime 增加来源写权限；overlay 不升级既有任务间安全保证。
- 每次 publish/merge/validate/recover 记录会话、变更集、来源代次、开始/结束、耗时和 failed/conflict/cancelled/unknown 状态；trace 不包含正文、补丁、密钥或原始路径。
- 沿用 WinFsp ACL、句柄、copy-up、whiteout、干净卸载等能力，但补充原文基线、可导出的变更集和发布状态机。SQLite 可继续保存映射/日志；不需要用它建立完整 Git 文件清单。
- 源文件和依赖实时可读；私有新建缓存/构建产物仍占空间。首读快照、首写整文件副本与验证命令自身的扫描成本必须分别测量。

## 建议实施顺序与验收

### Engine 内部生命周期接入（2026-10-26）

发布协议已移入 `src/local-overlays/publication`，由 `publication.ts` 在私有视图冻结收尾时调用。`engine.localOverlays.select(workspace, sessionId, taskId, { paths, validate })` 只接受当前活动任务和可信集成层提供的验证函数；选择替换本轮已有选择，复制路径数组，不跨轮继承。无选择不发布，缺失验证器、重复/越界路径或管理目录拒绝。验证器必须消费合并后的候选内容并确认结果，不能用“此前测试通过”代替候选验证。失败/取消任务不执行已选择发布。

选择在排空收尾时持久化，导出成功后先保存 publishing/batchId 再调用来源级协调器；来源完成且私有确认成功后保存 published，已确认覆盖释放，未选内容保留。仅在本次来源写入尚未开始且执行租约已排空时返回 rejected，使视图可续聊且任务失败；写入/清理未知、来源完成后确认缺失则保留任务清单和锁，不能重放。Publisher 错误明确区分 unapplied/unknown；完成后的备份记账异常不把 complete journal 降格为 aborted。协调目录固定在 `<data-dir>/local-overlays/publications`，参与视图共用来源锁。

这是内部发布接线的最初验证范围；后续已接入模型选择、候选 Sandbox 命令及显式创建/状态 UI，真实 v18 安装链路仍待验证。内部生命周期脚本精确检查候选字节，新增独立候选脚本在真实 Sandbox 执行命令并返回新读依赖；两者的证据范围分别记录，不把普通回调当成权限边界，也不承诺任意 shell 的依赖完整性。生产接口不从 HTTP/模型输入反序列化函数。原有单文件/总内容/100 路径与读依赖限额仍有效，不扩大为任意大型构建或目录发布验收。

Local overlay 使用独立于 WorktreeService 的清单和 UNC 命名空间，清单绑定来源/控制目录/虚拟卷身份及会话，不包含 Git metadata。内部创建先持久 preparing，再创建 v6 空视图、核对身份、干净卸载并保存 ready；创建或任务执行的未知结果保留锁和失败状态，不重新创建。旧 Local/Riftri/Worktree 不迁移。内部生命周期的初始增量不开放 UI/API 创建选择；后续显式入口见文首，默认模式保持不变。

实现位于 `src/local-overlays/service.ts` 和 `backend.ts`。私有文件及清单位于 `<data-dir>/local-overlays`，实际路径由该目录派生独立的稳定 UNC 命名空间；不在来源内建立目录。空闲视图卸载，清单校验不访问其 UNC，下一轮执行时才重新挂载。来源必须与私有数据目录分离。`engine.localOverlays.create({ id, source }, bind)` 是内部入口；bind 必须按固定 workspace 查找已有会话再创建，以覆盖会话已保存而清单回执丢失。重复 UUID 只重试绑定，不重建文件层；纯请求不匹配不破坏已有 ready 清单。

Engine admission 只校验清单及来源/控制目录；开始执行才持有该视图的跨进程租约并挂载。不同视图沿用实际路径并行，同一视图排队，项目记忆映射回来源；工具、AGENTS、Skills、子任务与 Sandbox 仍使用实际视图。新路径不申请来源或 Git common 写根。任务结束先排空工具调用、MCP、subagent 和 Runtime，再冻结、推进观察周期、回收无引用内容并正常卸载，最后持久 ready；无发布选择时保留私有修改；明确选择只在成功且验证通过时发布，失败/取消始终保留。执行或清理 unknown 时只停止挂载、隔离清单，不确认或恢复该视图。

每轮结束事件明确区分“私有内容已保留”与“所选文件已发布”，不把命令运行成功等同于来源发布成功。模型明确选择、候选工程命令验证、冲突 UI 与跨平台适配仍在完整目标内。宿主命令任意脱离进程树的后台进程仍是已有执行边界，不能凭 helper 卸载宣称它们已被 OS 隔离；真实 Sandbox 必须以 Runtime 清理结果为依据。

宿主和 Runtime 模型均收到私有目录、无 Git、不得提前声称发布的可信提示。Runtime 通过已有 Broker 上下文通道接收，参与既有 token 预算，不新增协议字段或修改安装态。`local_overlay` 事件包含私有/发布状态、观察周期、已捕获路径数量（不是最终 diff 数）和有界发布摘要；`published:true` 只在来源及私有确认均完成时给出。日志/trace 记录创建、选择、挂载任务和冻结/发布阶段的 ID、耗时与结果，不写源码、路径或提示正文。清单锁面向合作的宿主进程，不能作为对恶意宿主改写的文件 CAS 保证。

第一步先验证独立于 Git 的发布协议：在普通目录上用受控文本工具构建 B/O/T，覆盖两会话不重叠编辑、同文件非重叠编辑、同段冲突、同名新建、删除对修改，以及陈旧读取拒绝。此步仍不解除所有命令的工作区串行约束。

第二步给 WinFsp 实时后端增加不可变基线和变更集导出，接入 shell 私有写层；验证 rename/临时文件替换编辑器、二进制写入、ACL、外部来源变化、正常恢复和发布途中崩溃。记录任意命令读依赖仍不完备的边界。

第三步才接入会话入口、发布时机、来源级协调、Sandbox、取消/续聊与冲突 UI。测试发布完成后其它会话的旧读记录失效、合并后测试重跑、未知结果不重放。平台实现和性能按系统分别验收。

完成这些验证前，保留普通 Worktree 和现有 Local 串行路径。新方向优先验证“不会丢失另一会话的修改”，而不是继续优化 Git 首次 status。

## 第一阶段 PoC：受控编辑与发布

第一阶段最初实现于 `scripts/local-overlay/`；共享协议已移至 `src/local-overlays/publication`，实验 worker/原生短命令仍留在脚本目录。以下描述该独立验证阶段，不代替后续 Engine 接入证据。`EditSession` 只读取调用方指定的普通文件，保存读取版本，首次编辑前复核来源，私有修改保存在会话变更集中。会话建立不递归遍历来源，也不调用 Git；该阶段只读少量夹具，不能推导巨型目录创建成本或真实 overlay 磁盘占用。文件基线和版本计算的成本发生在实际读取/复核文件时。

`Publisher` 使用调用方指定、位于来源之外的统一协调目录，以来源真实路径和目录身份派生独占锁。所有参与者必须使用同一协调目录；不同协调目录、外部 IDE 和旧产品直接写路径不受此锁串行化。整批预检 B/O/T，验证合并后的候选，再复核候选版本和显式读取的依赖，然后逐文件写入。相同文件不同行可合并；同段冲突、二进制双改、删除对修改及不同内容同名新建拒绝整批发布。

私有 JSON journal 保存批次基线、发布前原文、候选和逐文件 intent/written 状态，不依赖数据库或 Git metadata。写入成功但确认丢失时保留锁；`inspect` 只核对现场是否匹配 before/after 或已经 diverged，不自动补写、回滚或解除锁。一个封存批次只能尝试一次；明确失败后的重新尝试需要重新读取并创建新批次。第一阶段不处理视图刷新；后述原生确认实验覆盖成功续轮，未知恢复和日志清理仍未实现。

运行方式（仓库根目录，使用项目 Node/pnpm）：

```powershell
pnpm test -- tests/local-overlay-poc.test.ts
pnpm overlay:verify-publish
```

手动脚本在 `.local/local-overlay-poc-*` 创建独占实验目录，启动两个独立 Node 进程，经 IPC 屏障同时发布同文件不同行修改，对每次合并候选运行 `node --check`，并执行最终程序检查两项修改都生效。另一个子进程在首个文件替换后、写入确认前立即退出，检查部分发布、重放阻塞和后续外部修改保留。脚本不连接模型、不操作用户目录、驱动或产品服务，不属于 Evaluation，不进入默认检查。

Windows 11 / Node 26.10.0 本机结果：28 个回归用例通过；双进程发布和真实进程退出实验通过。日志与平台信息的可提交摘要见 [PoC 报告](local-overlay-poc-results.json)，完整验证记录见 [verification](verification.md)。回归还覆盖 BOM/CRLF/EOF、132 组方向对称的非重叠替换检查、陈旧读取/依赖、候选验证失败或来源变化、取消、路径被 junction 替换、重复批次和 trace 脱敏。

边界：

- 只支持已存在父目录中的单链接普通文件；每文件最多 2 MiB、文本最多 20,000 行、变更最多 100 个文件，基线与私有内容合计最多 16 MiB。文本 diff 设超时和编辑距离上限；拒绝复杂合并，不做语义自动修复。
- 私有会话是受控 API 的内容记录，没有 WinFsp 挂载、shell 截获或完整读依赖跟踪；验证函数只获得本批次候选文件，不提供完整工程验证视图。本次语法检查与最终夹具执行不能代表大型工程构建通过。
- 路径/版本复核不提供内核级 CAS，不能消除任意外部写入在检查与替换之间的竞争。新建文件避免覆盖已有目标；多文件发布、目录树及断电恢复没有原子事务保证。
- 拒绝管理目录、链接、路径穿越及复杂目录操作；普通 mode 保留不等于 Windows DACL/owner/ADS 保真。不将旧 WinFsp 的 ACL 或 Sandbox 验证结果转移到这个新发布器。
- 接入既有 `src/tracing` 的 queue/prepare/validate/apply，记录批次/操作 ID、数量、耗时和终态，无文件正文或原始路径。进入批次目录后的普通流程导出 trace；进程立即退出可能没有 trace 尾部，恢复以已落盘 journal 和现场为依据。队列失败保留生命周期日志，不保证生成批次 trace 文件。
- 目前只在本机 Windows 验证；未验证 Linux/macOS，不改变产品默认模式、Local 串行调度或 Git worktree。

## 文件系统接入前选型复核（2026-10-25）

用户授权继续接入文件系统，并要求先重新评估 Riftri、WinFsp 和可直接使用的替代品。下面是本次工程选择，不把上游宣传、编译通过或旧验证推导为 CodeAtelier 实机兼容。当前产品和历史会话暂时保持既有行为。

所需能力是普通目录实时读取、每会话私有写入、创建不遍历或复制来源、来源持续接收发布，以及可冻结并导出的修改集。Windows 还需要原生安全描述符、跨专用账户挂载访问及持久 capability；“能通过 FUSE 挂载”不足以满足这组条件。

| 候选                  | 已核实的实现与差距                                                                                                                                                                                         | 本次选择                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Riftri                | 上游管理 Git linked worktree、不可变基线和原生 CoW；项目当前只抽取其 storage API，Windows 自研 WinFsp 已不依赖它的克隆代码                                                                                 | 新 Local overlay 链路不依赖 Riftri；旧模式暂不删除，避免破坏历史目录                                  |
| WinFsp + 现有原生后端 | WinFsp 是文件系统框架，不是现成 unionfs。现有 `Store` 已实现普通目录 lower、私有对象、whiteout、ACL 和稳定 UNC；普通 create/restore 不需要 Git 参数                                                        | Windows 优先复用；不经 `WorktreeService` 的 Riftri/Git 注册路径。原生基线、修改记录和冻结导出仍需补充 |
| unionfs-fuse          | 有普通目录 CoW union，README 明确 Linux/macOS 路径；未核实官方 Windows 原生 ACL 实现。其 copy-up/whiteout 不能代替编辑时原文和冲突发布                                                                     | POSIX 后端首批候选，需要验证实时来源、缓存、rename、恢复及 Sandbox；尚未安装实测                      |
| Linux OverlayFS       | 官方明确禁止挂载期间修改底层文件系统；我们的发布会修改其它会话的 lower                                                                                                                                     | 不直接用于实时主目录。若未来采用稳定快照/统一停挂发布，才重新评估                                     |
| fuse-overlayfs        | 为 Linux rootless 容器提供 upper/lower/workdir，依赖 libfuse；未核实支持我们要求的外部 live lower 变化                                                                                                     | 保留 Linux 候选，不根据名称假定解决实时来源一致性，也不作为三平台实现                                 |
| HUBFS 内部 unionfs    | `Config.Fslist` 可组合一般 FUSE 文件系统，不强依赖 Git 类型；但产品 CLI 面向 Git/GitHub，内部仍需单独封装。使用 cgofuse；代码许可为 AGPLv3；缓存负查找，未证明动态 lower 新建的完整失效语义                | 可参考接口，不能直接替换原生 Windows ACL 后端；不能把可抽取库描述为现成命令                           |
| Turso AgentFS         | 固定提交 `0a014ebd4918615baff589ed17486e557e7c6a23`：Windows `run` 明确不支持，`mount_stub.rs` 只允许 Unix 挂载；SQLite SDK/Windows CLI 发布不等于 Windows 文件系统挂载                                    | 当前不满足 Windows 接入                                                                               |
| ContextFS             | 固定提交 `5daff08f620cfcd04384e16f5fe34829a874bba9`：有 WinFsp 原生挂载，但 `GetSecurity/SetSecurity` 为空，按名称查询返回固定描述符并向 Everyone 授完全访问；启动调用后台 Bootstrap，逐文件读取并写入 CAS | 不直接采用；与 capability ACL 和不全量导入要求冲突，换用它仍需改写关键部分                            |
| AgentHarborFS         | 官方文档描述 lazy live overlay、Linux FUSE/macOS FSKit/Windows WinFsp，语义最接近；文档链接的公开 `agent-harbor/agent-harbor` 仓库本次网页和 API 均返回 404                                                | 待核实源码、许可、独立使用接口及 ACL，不能仅据文档认定是可集成依赖                                    |
| OmniVFS               | 固定提交 `cfa9a1526253088f345507fea18b79349ec8ffc9`：README 提及 Windows FUSE，但 CLI `handle_mount` 仅 `cfg(unix)` 执行真实挂载，非 Unix 只打印不支持提示                                                 | 不视为已提供 Windows 后端                                                                             |

另排除 mergerfs（上游明确不提供 OverlayFS 式只读 lower + 可写 upper 和 whiteout）、absfs/unionfs（应用内 Go 文件接口，不是给任意程序使用的系统挂载）、面向 squashfs/EROFS 固定镜像的 Windows overlay（需先生成镜像，不满足直接读取可变目录），以及通过进程注入实现的 winrsbox（改变执行/沙箱路径，不是可直接替换的挂载后端）。不宣称全世界不存在其它实现；结论是本次核查未找到可直接满足全部要求的三平台替换件。

因此下一增量采用“独立 Local overlay 管理 + Windows 原生 WinFsp 后端 + 发布协调器”，不增加 Git base、index 或对象库。复用既有文件系统代码的理由是当前 ACL/UNC/Runtime 路径有可追踪实现和既有证据，不是因为已经投入过开发。`git-lower.*`、`overlay-git.ts` 和 Riftri CoW helper 不进入新路径；旧代码保留到历史兼容迁移明确后再处理。

### LayerFS 追加调查与 Windows 移植边界（2026-10-25）

后续决定：用户了解差异后明确继续自研方案和原有 goal，不采用 LayerFS 或开展其 Windows 移植。下面保留调查证据，候选实验不再是当前执行计划。

用户指出 LayerFS，并询问能否给它增加 WinFsp 后端。此前候选清单漏掉了该项目；本次固定源码 `ad78914e36b258b360daf13aec164b5655814689` 核查，不运行其安装提示或第三方代码。它是值得进一步验证的版本化文件核心候选，不是已验证的原生 Windows 替代品，也未在本项目接入。

- 架构契合：自己的 Branch/Commit 与 Git 无关；content/history/overlay/workspace 与 Linux FUSE 适配层分开，后续 Workspace 共享 Store 的不可变内容。`layerfs-fuse/src/ports.rs` 已有访问 Workspace/Store 的接口，适合评估增加 WinFsp 原生适配，而不是维护两套修改/合并核心。
- 初次成本不能混淆：`layerfs-project/src/import/scan.rs` 递归枚举目录，`files.rs::construct_file` 打开并读取文件构造内容对象；首次 Init 包含整个来源，后续 mount 才无需复制或扫描。内容去重/压缩可能降低存储量，但不是直接使用宿主实时目录，也不消除首次导入。若坚持不导入、直接 live lower，则还要另做来源适配与版本/基线协议，不能称为仅加 WinFsp。
- Windows 不止挂载：现有 Windows runtime 启动 `wsl.exe`，Store/命令在 Linux worker/容器内；`init_observed` 的非 Unix 分支明确返回 Unsupported。原生 NTFS 路线必须验证或移植 Store 支持检查、进程协调、导入元数据、取消和干净退出，不能只替换 FUSE 回调。
- ACL：可移植属性定义仅含 mode/mtime，属性键支持自定义 domain，但此层明确不执行平台权限。可评估独立 Windows security-descriptor 属性域；仍需实现 owner/group/DACL 保存、继承、GetSecurity/SetSecurity、跨专用账户访问和 capability 验证，不能用 POSIX mode 或固定 Everyone ACL 代替。
- 发布与恢复：上游 `branch.publish` 更新 Store 的 main Layer，不等于安全写回用户原目录；CodeAtelier 的显式源码选择、来源协调、外部改动检测、测试、ACL 保留及未知结果处理仍需保留。文档称当前开放 Disposable（WAL/synchronous=OFF），核心源码有 Durable 配置；选择 FULL 仍不足以证明完整断电/私有层恢复协议，须专项验证。
- 文档漂移：官网部分比较/并发描述仍称同路径双改一律冲突；本次源码 `merge/decide.rs` 实际调用文本 merge3 并记录二进制等冲突。后续 PoC 必须固定版本实测，不从旧宣传或单段文档推导合并保证。

可评审的下一实验是“固定 LayerFS 核心 + 原生 Windows Store + WinFsp 适配 + 现有 CodeAtelier Sandbox/发布协调器”。先在小型独占夹具验证核心可运行，再验证两挂载共享基线、私有增量、冲突与恢复；分别计量首次导入和每会话创建，不能把两项合并成一次快速 mount。Local 模式继续屏蔽/排除 `.git`。是否采用一次导入后的 Store 作为权威文件源，和最终宿主目录同步语义仍需在替换产品路径前明确。

参考：[源码与许可证](https://github.com/Ephemeral-AI-Lab/layerfs/tree/ad78914e36b258b360daf13aec164b5655814689)、[导入实现](https://github.com/Ephemeral-AI-Lab/layerfs/blob/ad78914e36b258b360daf13aec164b5655814689/core/crates/layerfs-project/src/import/init.rs)、[挂载接口](https://github.com/Ephemeral-AI-Lab/layerfs/blob/ad78914e36b258b360daf13aec164b5655814689/core/crates/layerfs-fuse/src/ports.rs)、[属性域](https://github.com/Ephemeral-AI-Lab/layerfs/blob/ad78914e36b258b360daf13aec164b5655814689/core/crates/layerfs-content/src/filesystem/attributes/keys.rs)、[平台与持久化边界](https://layerfs.ai/docs/platform/)。

接入顺序：先用既有 `OverlayManager` 直接建立普通目录双挂载，真实命令修改并验证私有视图，然后将预先记录基线的显式路径交给发布 PoC。此小实验只证明文件后端与发布器能够衔接，不自动发现全部 shell 写入，不给未知文件猜测 B。之后才在原生层补充不可变基线、内容/namespace 变化记录、停止写入后的导出以及元数据变化分类，并复验 ACL 和真实 Sandbox。首写 copy-up 捕获的是写入时内容，不能冒充此前模型或命令读到的版本；来源变化时必须保留旧读版本或拒绝过期结果。

参考与可复核来源（本次未运行第三方安装脚本或改变驱动）：

- [Riftri](https://github.com/assistant-ui/riftri)、[WinFsp 原生 API 与 FUSE 的安全描述符差别](https://winfsp.dev/doc/Native-API-vs-FUSE/)。
- [unionfs-fuse](https://github.com/rpodgorny/unionfs-fuse)、[Linux OverlayFS 底层修改限制](https://docs.kernel.org/filesystems/overlayfs.html#changes-to-underlying-filesystems)、[fuse-overlayfs](https://github.com/containers/fuse-overlayfs)。
- [HUBFS unionfs 源码](https://github.com/winfsp/hubfs/blob/master/src/fs/unionfs/unionfs.go)、[HUBFS CLI 和平台](https://github.com/winfsp/hubfs)。
- [AgentFS Windows run](https://github.com/tursodatabase/agentfs/blob/0a014ebd4918615baff589ed17486e557e7c6a23/cli/src/cmd/run_windows.rs)、[mount stub](https://github.com/tursodatabase/agentfs/blob/0a014ebd4918615baff589ed17486e557e7c6a23/cli/src/cmd/mount_stub.rs)。
- [ContextFS Windows ACL](https://github.com/thustorage/ContextFS/blob/5daff08f620cfcd04384e16f5fe34829a874bba9/src/cas/platform/windows/winfsp_adapter.cpp)、[启动](https://github.com/thustorage/ContextFS/blob/5daff08f620cfcd04384e16f5fe34829a874bba9/src/cas/platform/windows/main_windows.cpp)、[后台导入](https://github.com/thustorage/ContextFS/blob/5daff08f620cfcd04384e16f5fe34829a874bba9/src/cas/bootstrap.cpp)。
- [AgentHarborFS 文档](https://docs.agent-harbor.com/agentharborfs)、[其安装文档所指仓库](https://docs.agent-harbor.com/getting-started/installation)、[OmniVFS 挂载入口](https://github.com/The-Arc-Studios/OmniVFS/blob/cfa9a1526253088f345507fea18b79349ec8ffc9/crates/omnivfs-cli/src/main.rs)。
- [mergerfs 非目标](https://github.com/trapexit/mergerfs#non-features)、[absfs/unionfs](https://github.com/absfs/unionfs)、[squashfs overlay](https://github.com/aderumier/mount_squashfs_overlay)、[winrsbox](https://github.com/PHPCraftdream/winrsbox)。

## WinFsp 与发布器最小衔接验证

新增手动入口 `pnpm overlay:verify-filesystem`（`scripts/verify-local-overlay-winfsp.ts`），要求本机已有 WinFsp Runtime 和已构建的 `codeatelier-overlay.exe`。在 `.local/local-overlay-winfsp-*` 中建立未初始化 Git 的普通来源目录，直接调用 `OverlayManager.start` 的 live 模式，不执行 Git CLI 或 Riftri helper，也不经过现有产品的工作区创建策略。

2026-10-25 本机 Windows 实测通过：建立两个真实 UNC 挂载后，私有内容对象均为零；先明确记录 `module.mjs` 的基线，然后两个宿主 Node 进程分别通过临时文件 + rename 修改挂载内文件，执行各自程序得到 `12` 和 `21`，来源仍为原文。未修改文件继续读取更新后的 lower；每个视图各自产生 `generated.txt`，没有写入来源。

脚本随后仅提取已声明的 `module.mjs` 私有内容，交给第一阶段 Publisher。发布候选放回对应挂载运行真实 `node --check` 和程序执行，结果依次为 `12`、合并后的 `30`，最终来源程序输出 `30`。干净卸载、重挂载后两视图分别仍是 `12` 和 `30`，私有产物也保留：此结果同时说明旧视图不会自动 rebase 成最新来源。再次卸载均收到成功收据并确认 helper 退出。摘要见 [JSON 报告](local-overlay-filesystem-results.json)。

这个实验验证了既有 Windows 文件后端能够独立于 Riftri/Git 与发布 PoC 衔接。它不提供原生自动变化捕获：选择路径和旧基线由脚本明确给出，任意 shell 新增/删除/rename 的自动导出仍待实现；`generated.txt` 未发布来自显式选择，不是已有自动产物识别策略。本次运行身份是宿主 Node，未使用 Sandbox，未测巨型目录创建速度/磁盘或完整 lower 遍历计数。发布器仍有第一阶段 ACL 保真和外部竞争限制，不应接到真实项目的自动回写路径。
