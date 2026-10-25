# Local 会话文件隔离与发布：重新定界

状态：2026-10-25 用户重新澄清目标（D170），随后授权继续验证并接入 agent。Overlay 与 Git worktree 完全并列，服务于同一 Local 工作区多个对话的文件修改隔离与冲突整合，不负责 Git 工作区管理。受控发布、Local WinFsp 双挂载、`.git` 屏蔽、真实 Sandbox 并行/取消/重挂载、原生捕获/冻结导出、Windows owner/group/DACL 保留发布及成功后确认/续轮刷新的 PoC 已验证；产品自动发布和恢复入口仍待接入，不改变现有服务或历史会话。

## 需求与模式

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

当前实施增量：Local 原生层在内容读取时记录来源文件身份、大小、最后写入时间和 ChangeTime 等版本标记，不复制整文件；首次命名空间/内容修改前复核已观察版本，在禁止并发写入/删除的来源句柄下保存不可变 B。普通内容 copy-up 从同一 B 生成 O，避免两次读取不同来源版本。创建、删除和 rename 分别记录目标路径首次状态；临时文件最终消失可以保留空到空记录，发布批次构造时再消除。来源更新仍可被读取，但同一观察周期中旧版本对应的修改不能悄悄接受，需要后续受控刷新。此机制不承诺对恶意改写元数据、任意 shell 的全部跨文件依赖或目录原子快照提供隔离。冻结结果及有界发布批次构造已实现；成功发布后的观察周期刷新已有独立 Windows PoC，失败轮次刷新与产品恢复仍待接入。

建议默认接受实时 lower：尚未私有化的文件可随主目录变化；它不提供启动时的全目录快照，也不保证一个长期运行的命令看到跨文件一致版本。

对准备修改的普通文件，保留不可变的编辑基线 B、会话结果 O 和来源当前内容 T。基线保存与首次私有化需要协调，不能只留下被随后写入覆盖的 upper。新建保存“此前不存在”的前提；删除与重命名也保存原路径、目标路径和原内容身份。仅对涉及的文件保存内容与计算所需摘要，不在会话创建时遍历、hash 或复制整库。

基线必须对应编辑实际依据的版本。现有 `FileEditor.prepare/verify` 已检查任务读取哈希与写前内容，可接入版本和读记录；不能等发布时才把新来源内容当成旧基线。读取后来源变化时，受控编辑应拒绝并要求重读，不能盲目重试旧补丁。

任意 shell 命令的读取、计算和稍后写入更难：单纯首次写入 copy-up 不能证明命令此前读过的内容仍有效。首版需明确区分“写入已隔离”和“读依赖一致性已保证”；对已知读版本/来源代次变化要求重新检查或重跑相关验证，不宣称完整 serializable 事务。要获得更强的重复读取语义，需要首读固定内容或文件系统快照；全量扫描时前者可能缓存整库，不能同时承诺零遍历、零拷贝和启动时完整快照。

### 原生自动捕获与冻结验证

`pnpm overlay:verify-capture` 通过真实挂载读写普通非 Git 夹具，不预先声明编辑基线。首次读仅记录版本；首次写/替换/删除/rename 保存原文，二进制同样按字节保存；新建后删除保留 absence 到 absence 的原始记录。普通首次内容修改保存 B 和 O 两份内容，成本与修改文件大小相关，不能称为文件内部块级 CoW。首次创建和纯读取均没有私有内容对象，创建期 lower 打开/枚举计数为零（不含固定根身份句柄）。

实测覆盖：主目录同长度修改并恢复 mtime 后，覆盖、删除与临时替换仍被拒绝；属性操作已经记录 B、但尚未私有化内容时，后续来源变化也拒绝旧基线复用；已私有化的文件继续编辑不改原始 B。读取前后版本校验只覆盖单次原生读取，不将多次读取声明为原子快照。

`OverlayManager.withFrozen` 要求调用方先排空任务进程，然后发送原生 `freeze`：停止 dispatcher、撤销卷、仅按已捕获路径写入 `sealed_changes`。helper 继续持有控制目录独占租约，宿主只读导出；收到 frozen 前不读取，导出时失去 helper 不返回成功结果，结束后等待正常 stopped/exit。实测冻结后挂载不可访问、封存内容可读、第二个 helper 不能接管；干净退出后可恢复私有状态。旧普通模式不接受 freeze。生命周期复用 `overlay.local_freeze` tracing，仅记录 ID、状态与耗时。

首次捕获实验使用 v4，当前发布确认实验升至 v5；旧 v3 没有原文记录，v4 没有修改代次关联，均拒绝自动转换或猜测旧依赖。旧 D168 v2 格式保持不变。封存表中的目录、重解析及尚未私有化的 live 内容有独立类型，不自动当普通文件发布；复杂目录重命名、显式权限修改发布仍未支持。原始结果见 [捕获报告](local-overlay-capture-results.json)，v5 重跑见 verification。

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

### 发布确认与下一轮观察（Windows PoC）

发布与视图确认分开记录：来源 journal 已 complete 才允许在仍持独占冻结租约的 helper 中确认。确认按 batch ID、冻结标识、观察代次和明确路径形成持久收据，只释放这些普通文件的私有命名空间覆盖和基线；未选择的修改、产物及历史对象保留。确认失败返回 refresh-pending，不能将来源 complete 改写成未发布或重做来源写入。下一轮须干净重挂载，以清除旧句柄和缓存。

不能直接清空所有读记录：未发布的旧修改可能依赖上一轮读取。实验格式新增观察代次及路径修改与代次的关联；确认后开启新代次，旧修改保留旧依赖，新修改使用当前代次。后续编辑已有私有文件也关联新代次。导出检查选中修改涉及的代次和当前代次，不把旧依赖伪装成新读取。首次实现保留历史对象/观察记录，不扫描来源或自动垃圾回收；异常退出仍拒绝自动恢复，幂等确认只在可验证的干净状态下使用。

`pnpm overlay:verify-refresh` 已在真实双挂载验证：私有输出 `12/21` 合并后来源和两个刷新视图均为 `30`；下一轮修改后来源 `120`。未选产物保留，发布时旧依赖过期仍拒绝。确认后模拟收据丢失，来源日志保持 complete、refresh 保持 pending；同一冻结租约和后续干净重挂载重复确认均幂等，不删除其间新产生的私有编辑。新建/删除确认释放对应覆盖，外部重建的文件可见。原生只复核相关代次的观察，不随每次确认重新扫描历史读集；历史记录/对象暂保留，不声称磁盘已回收。

收据绑定批次 ID、冻结标识、原代次和规范化选择；选择不同、代次过期，或尚未执行的旧确认来自另一冻结快照时拒绝。已经提交的完全相同收据才允许跨干净重挂载幂等返回。自审回归先复现了“确认前中断、重挂载后又编辑、重放旧确认会删掉新编辑”，随后用每次冻结的新标识修复；不只依赖观察代次，因为未确认时它尚未增加。

源发布前检查确认请求的大小/格式，来源 complete 后单独记录确认终态。trace 增加 `overlay.local_acknowledge` 与 `local_overlay.refresh`，只含 ID/耗时/状态，不含路径或正文；确认无可信回执记为 unknown。失败/取消轮次如何开始新观察周期、刷新 pending 的产品恢复入口、对象回收及大读集开销仍待实现；本实验没有改变用户会话。结果见 [刷新报告](local-overlay-refresh-results.json)。

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

第一步先验证独立于 Git 的发布协议：在普通目录上用受控文本工具构建 B/O/T，覆盖两会话不重叠编辑、同文件非重叠编辑、同段冲突、同名新建、删除对修改，以及陈旧读取拒绝。此步仍不解除所有命令的工作区串行约束。

第二步给 WinFsp 实时后端增加不可变基线和变更集导出，接入 shell 私有写层；验证 rename/临时文件替换编辑器、二进制写入、ACL、外部来源变化、正常恢复和发布途中崩溃。记录任意命令读依赖仍不完备的边界。

第三步才接入会话入口、发布时机、来源级协调、Sandbox、取消/续聊与冲突 UI。测试发布完成后其它会话的旧读记录失效、合并后测试重跑、未知结果不重放。平台实现和性能按系统分别验收。

完成这些验证前，保留普通 Worktree 和现有 Local 串行路径。新方向优先验证“不会丢失另一会话的修改”，而不是继续优化 Git 首次 status。

## 第一阶段 PoC：受控编辑与发布

实现位于 `scripts/local-overlay/`，没有接入产品会话或创建虚拟文件系统。`EditSession` 只读取调用方指定的普通文件，保存读取版本，首次编辑前复核来源，私有修改保存在会话变更集中。会话建立不递归遍历来源，也不调用 Git；当前只读少量夹具，尚未测量巨型目录创建成本或真实 overlay 磁盘占用。文件基线和版本计算的成本发生在实际读取/复核文件时。

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

| 候选 | 已核实的实现与差距 | 本次选择 |
| --- | --- | --- |
| Riftri | 上游管理 Git linked worktree、不可变基线和原生 CoW；项目当前只抽取其 storage API，Windows 自研 WinFsp 已不依赖它的克隆代码 | 新 Local overlay 链路不依赖 Riftri；旧模式暂不删除，避免破坏历史目录 |
| WinFsp + 现有原生后端 | WinFsp 是文件系统框架，不是现成 unionfs。现有 `Store` 已实现普通目录 lower、私有对象、whiteout、ACL 和稳定 UNC；普通 create/restore 不需要 Git 参数 | Windows 优先复用；不经 `WorktreeService` 的 Riftri/Git 注册路径。原生基线、修改记录和冻结导出仍需补充 |
| unionfs-fuse | 有普通目录 CoW union，README 明确 Linux/macOS 路径；未核实官方 Windows 原生 ACL 实现。其 copy-up/whiteout 不能代替编辑时原文和冲突发布 | POSIX 后端首批候选，需要验证实时来源、缓存、rename、恢复及 Sandbox；尚未安装实测 |
| Linux OverlayFS | 官方明确禁止挂载期间修改底层文件系统；我们的发布会修改其它会话的 lower | 不直接用于实时主目录。若未来采用稳定快照/统一停挂发布，才重新评估 |
| fuse-overlayfs | 为 Linux rootless 容器提供 upper/lower/workdir，依赖 libfuse；未核实支持我们要求的外部 live lower 变化 | 保留 Linux 候选，不根据名称假定解决实时来源一致性，也不作为三平台实现 |
| HUBFS 内部 unionfs | `Config.Fslist` 可组合一般 FUSE 文件系统，不强依赖 Git 类型；但产品 CLI 面向 Git/GitHub，内部仍需单独封装。使用 cgofuse；代码许可为 AGPLv3；缓存负查找，未证明动态 lower 新建的完整失效语义 | 可参考接口，不能直接替换原生 Windows ACL 后端；不能把可抽取库描述为现成命令 |
| Turso AgentFS | 固定提交 `0a014ebd4918615baff589ed17486e557e7c6a23`：Windows `run` 明确不支持，`mount_stub.rs` 只允许 Unix 挂载；SQLite SDK/Windows CLI 发布不等于 Windows 文件系统挂载 | 当前不满足 Windows 接入 |
| ContextFS | 固定提交 `5daff08f620cfcd04384e16f5fe34829a874bba9`：有 WinFsp 原生挂载，但 `GetSecurity/SetSecurity` 为空，按名称查询返回固定描述符并向 Everyone 授完全访问；启动调用后台 Bootstrap，逐文件读取并写入 CAS | 不直接采用；与 capability ACL 和不全量导入要求冲突，换用它仍需改写关键部分 |
| AgentHarborFS | 官方文档描述 lazy live overlay、Linux FUSE/macOS FSKit/Windows WinFsp，语义最接近；文档链接的公开 `agent-harbor/agent-harbor` 仓库本次网页和 API 均返回 404 | 待核实源码、许可、独立使用接口及 ACL，不能仅据文档认定是可集成依赖 |
| OmniVFS | 固定提交 `cfa9a1526253088f345507fea18b79349ec8ffc9`：README 提及 Windows FUSE，但 CLI `handle_mount` 仅 `cfg(unix)` 执行真实挂载，非 Unix 只打印不支持提示 | 不视为已提供 Windows 后端 |

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
