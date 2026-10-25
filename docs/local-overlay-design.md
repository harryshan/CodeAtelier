# Local 会话文件隔离与发布：重新定界

状态：2026-10-25 用户重新澄清目标（D170），随后授权继续验证并接入文件系统。Overlay 与 Git worktree 完全并列，服务于同一 Local 工作区多个对话的文件修改隔离与冲突整合，不负责 Git 工作区管理。受控文件发布 PoC 与 WinFsp 双挂载最小衔接已验证，证据见本文后两节；原生自动变更集、产品发布时机、Git CLI 限制和恢复操作尚未实施，不改变现有服务或历史会话。

## 需求与模式

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

建议默认接受实时 lower：尚未私有化的文件可随主目录变化；它不提供启动时的全目录快照，也不保证一个长期运行的命令看到跨文件一致版本。

对准备修改的普通文件，保留不可变的编辑基线 B、会话结果 O 和来源当前内容 T。基线保存与首次私有化需要协调，不能只留下被随后写入覆盖的 upper。新建保存“此前不存在”的前提；删除与重命名也保存原路径、目标路径和原内容身份。仅对涉及的文件保存内容与计算所需摘要，不在会话创建时遍历、hash 或复制整库。

基线必须对应编辑实际依据的版本。现有 `FileEditor.prepare/verify` 已检查任务读取哈希与写前内容，可接入版本和读记录；不能等发布时才把新来源内容当成旧基线。读取后来源变化时，受控编辑应拒绝并要求重读，不能盲目重试旧补丁。

任意 shell 命令的读取、计算和稍后写入更难：单纯首次写入 copy-up 不能证明命令此前读过的内容仍有效。首版需明确区分“写入已隔离”和“读依赖一致性已保证”；对已知读版本/来源代次变化要求重新检查或重跑相关验证，不宣称完整 serializable 事务。要获得更强的重复读取语义，需要首读固定内容或文件系统快照；全量扫描时前者可能缓存整库，不能同时承诺零遍历、零拷贝和启动时完整快照。

## 文件发布建议

1. 会话准备有明确文件范围的变更集。区分应发布文件与临时文件/缓存/构建产物；规则独立于 Git，不能默认把全部 upper 发布。
2. 按来源真实目录身份进入发布队列。同一来源的所有 CodeAtelier 发布和直接写入路径需要共同协调，不能只按不同挂载路径认为互不影响。
3. 对变更集全部路径先复核：路径未被链接替换、目标存在状态、文件类型、权限，以及 B/O/T 内容版本。发现冲突先保留整个候选集，不先发布其中一半。
4. T 与 B 相同：可发布 O。O 与 T 相同：视为已满足，不重复写。双方都变化的普通文本可尝试有界三方合并；无文本冲突不等于语义正确，需要验证合并后的候选内容。
5. 同段文本冲突、二进制双改、删除对修改、同名新建、复杂目录 rename 和权限冲突保守拒绝自动整合。返回有界冲突信息，由会话在最新基线上处理；自动修复次数和人工接管入口需要明确，不无限重试。
6. 将最新候选放回隔离视图运行必要验证，验证后发布前再次检查来源代次/内容。排队期间来源又变化则使候选失效，不将旧测试结果当成最新结果。
7. 写入使用预备文件、逐文件替换、发布日志与原版本备份；成功后记录来源代次和新基线，清理只属于此次成功发布的私有增量，并作废对应读取缓存。

建议的体验是每轮成功完成后发布一个明确的变更集，而非每个写工具立即同步；失败、取消或冲突保留私有改动。是否自动发布或由用户点击应用尚待确认，不以本文建议作为运行授权。

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

私有 JSON journal 保存批次基线、发布前原文、候选和逐文件 intent/written 状态，不依赖数据库或 Git metadata。写入成功但确认丢失时保留锁；`inspect` 只核对现场是否匹配 before/after 或已经 diverged，不自动补写、回滚或解除锁。一个封存批次只能尝试一次；明确失败后的重新尝试需要重新读取并创建新批次。成功后续轮 rebase、缓存失效和日志清理尚未实现。

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
