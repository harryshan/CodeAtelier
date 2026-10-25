# Windows NTFS / WinFsp overlay 后端设计

状态：2026-10-25 用户已确认实时 lower，随后要求按类似 Git worktree、无提交 checkout、无 repo 复制重新设计（D168）。**尚未实现 WinFsp 后端**；已验证下述 Git 元数据方案，不代表挂载或 Sandbox 通过。原私有仓库方向的未完成源码草稿已撤回，现有产品代码不变。

## 已确认范围与待确认项

在 Riftri 工作区模式下增加 Windows 原生 WinFsp overlay 后端，使 NTFS 不再依赖块级 reflink。使用 WinFsp 原生文件系统 API，覆盖 CodeAtelier 的 Git、文件工具、Sandbox ACL、并发、取消、历史续聊与服务重启。普通 Git worktree 和现有 Linux/macOS 原生 CoW 后端保持原行为。不创建 Windows 分区，不使用 WSL 承载 Windows 产品挂载。

用户已选择原目录实时 lower；VSS 作为未采用的替代方案记录：

| 来源层 | 行为 | 与现有约定的关系 |
| --- | --- | --- |
| 原目录实时 lower | 尚未复制到 upper 的内容继续从原目录读取，原目录修改或删除可能改变会话所见内容 | 满足直接使用原目录，但必须显式修改 D167 固定创建时状态及来源删除后仍可恢复的约定 |
| VSS 快照 lower | 读取创建时的卷影快照，再向 upper 写入修改 | 可以提供稳定基线，但增加提升权限、卷影生命周期、磁盘配额及快照丢失处理；不是仅安装 WinFsp 即可获得 |

WinFsp 自身不提供原目录的时间快照；只在第一次写入时 copy-up 无法保存之前已经被其他进程覆盖或删除的 lower 内容。逐文件 stat、USN 记录和变化通知也不能还原旧字节。不能默默用全量复制或硬链接替代用户要求。

## 重新分层：标准 linked worktree + 工作文件 overlay

不以 Riftri 的“复制完整 Git 仓库/创建 immutable base”流程作为 Windows 后端的起点。Git 负责标准 linked worktree 管理，WinFsp 只负责工作文件的合并视图：

1. 用 `git worktree add --detach --no-checkout --lock --reason <受控原因> <任务路径>` 登记工作区；已有提交的仓库默认读取当前 HEAD，作为 Git 历史关系，不据此展开工作文件，也不提供选择 base 的入口。
2. 为任务复制来源当前 index，而不是从 HEAD tree 重建 index，保留 staged 与 unstaged 的区别。index 属于元数据，大小随索引条目数增长；巨型仓库可能仍有较大 index，但不复制 pack 或项目文件。
3. WinFsp lower 直接读取原工作目录的当前文件；upper 保存任务写入和删除标记。源 `.git` 在合并视图中被遮蔽，由任务自己的 gitfile 指向标准 worktree admin directory。
4. objects、pack、普通 refs 和公共配置继续按 Git worktree 规则共享；HEAD、index 和工作文件视图独立。初始 detached HEAD 避免 task commit 自动移动主目录当前分支，但显式更新共享分支、fetch、config 等仍有标准 worktree 的共享影响。
5. 新对象直接写公共 Git 对象库，Git 自己负责登记/reflog/GC 关系；不建立另一套只读 alternates 或“私有 refs + 外部 objects”的不完整仓库。托管挂载下线时保持 worktree lock，避免被普通 prune 当作失踪目录清除；lock 不等于阻止 Git 命令或自动保护所有引用。

“不以 commit 为工作文件 base”不等于“不存在 Git HEAD”。无提交仓库可研究 `--orphan` 注册路径；官方 CLI 不允许它与 `--no-checkout` 同时使用，但其空工作区创建也不物化历史文件。没有 Git 的普通目录只使用 overlay。

工作文件写入只在 upper；Git 命令则会写入共享 `.git`，与标准 worktree 一致。因此不能同时声称“像 worktree 共享仓库”和“包括公共 Git metadata 在内，来源所有字节绝不改变”。Sandbox 应复用现有显式 Worktree 对 common Git 根的精确授权，不向 Runtime 授予 lower 工作文件写权限或后端控制目录权限。

### 巨型仓库成本与剩余边界

- 创建目标是不 checkout、不复制 `.git/objects`、不扫描并 hash 全部工作文件；创建必要成本主要是 Git 管理记录、index 复制与挂载。不能提前保证固定毫秒数或完全 O(1)。
- 内容 copy-up 通常以整个文件为单位，不是 NTFS 块级 reflink；修改大文件仍可能产生整文件空间成本。git status、构建和测试自身的遍历/读取成本仍存在。
- split-index 不能盲拷一个 index：必须同时处理它引用的 sharedindex，或在私有副本中正确展开。sparse-index/sparse-checkout、fsmonitor、untracked cache、大小写与虚拟 inode/stat 缓存也需独立验证，不能让来源缓存掩盖 overlay 的变化。
- 创建时须协调来源 HEAD/index 的一致性；不能为解决一致性而创建临时 commit、写回原工作文件或要求清理脏文件。冲突 index、合并/rebase 状态、submodule 与嵌套仓库需要明确支持或拒绝规则。
- lower 的修改和删除仍可影响任务所见的未覆盖文件，原仓库及来源目录需要长期保留。此限制来自已确认的实时视图，不由 Git 元数据独立性消除。

### Git-only 验证

2026-10-25，Git `2.55.0.windows.2`，最终独占夹具 `.local/overlay-git-study-LthdTX`：

- `--no-checkout` 创建后目标只含 gitfile，没有 checkout 工作文件；对象目录与来源相同。
- 复制独立 index 后暂存条目一致；用少量手工夹具文件模拟工作视图时，dirty/staged/untracked/ignored 的 status 与来源一致。
- task add/commit 后来源 HEAD、index 哈希和工作文件不变；新 commit 位于共享对象库，task 创建的普通分支也在来源可见。
- 单独复制 split-index 未通过；补充复制 `rev-parse --shared-index-path` 指向的一个 sharedindex 后，在任务侧 `update-index --no-split-index` 展开，暂存条目一致。无首次提交仓库的 `--orphan` 路径可登记空工作区并接入 staged index。
- 本实验没有 WinFsp 挂载；手工夹具文件不作为 CoW/overlay 或性能证据。脚本与结果留在忽略目录 `.local/overlay-git-study.mjs` 和夹具 `result.json`。

## 存储与权限原则

- 工作文件 lower 只读。文件系统 helper 的内容写入、删除标记、重命名、属性与安全描述符修改都保存于私有存储，绝不对 lower 执行 SetSecurityInfo 或可写打开。Git common directory 由标准 Git CLI 另行共享管理，不经工作文件 lower 转发写入。
- upper、删除标记、目录合并元数据与挂载清单由宿主管理；Runtime 只获得合并视图的路径。用户不能通过工作区路径直接篡改后端控制元数据。
- copy-up 必须先完整准备临时对象、持久化，再发布；失败不能暴露截断对象。删除与重命名跨多个元数据写入时需要可恢复事务，不凭目录当前外观猜测是否完成。
- HEAD/index 按 linked worktree 独立，objects/普通 refs 按标准规则共享；不复制整个 `.git`，也不将主目录 `.git` 作为普通工作文件透传。
- 原生 API 的 GetSecurityByName/GetSecurity/SetSecurity 负责 Windows 安全描述符语义。不能把完整 ACL 简化为 POSIX mode，也不能靠 helper 的宿主权限替代调用者的访问检查。
- 需要验证 owner/group、允许与拒绝 ACE、继承/保护标记、restricted token 双重访问检查及权限变更后的持久性。SACL/审计操作必须遵循调用者权限，不能宣称普通宿主进程可以任意读写 SACL。
- 根 ACL 的继承变更应作用于合并视图中的相应子项，同时保留显式拒绝和受保护 DACL；不能因 Sandbox 授权根而复制所有文件内容，更不能回写来源 ACL。
- 重解析点、路径大小写、ADS、硬链接、文件锁、删除待决和映射文件逐项验收；不支持项必须明确返回失败，不允许静默穿透到来源或工作区外。

## 与现有系统的接入点

| 系统 | 当前接入点 | Windows overlay 必须补充 |
| --- | --- | --- |
| 创建与幂等 | `src/worktrees/service.ts` 的 preparing/ready/failed 清单、UUID 排他锁 | 挂载准备、可信 ready 收据、已存在挂载身份核验；未知创建不重新初始化 upper |
| 后端选择 | `src/worktrees/riftri.ts` 的 v2 一次性 helper | Windows 长驻挂载 helper 协议；缺 driver/helper 时继续明确拒绝，不回退原目录 |
| 工作区身份 | `src/worktrees/git.ts` 的 realpath/lstat/dev/ino/birthtime | 现有入口拒绝链接；不能全局放开 junction。仅允许经管理器认证的挂载身份，或采用不触发入口重解析的受控挂载路径 |
| Sandbox 授权 | `src/sandbox/access-manifest.ts` 与 native ObjectGrant | 路径及句柄身份一致；工作文件 ACL 只改变虚拟对象，Git 另授经核验的 common 根。不同账户必须看到同一个受控挂载，不能依赖宿主会话的私有盘符 |
| 持久 capability | 根身份摘要及卷/文件 ID | 重挂载保持受控稳定身份；不得随机换卷号导致重复 SID/ACE，不得将不同 upper 冒充同一根 |
| 调度、项目记忆 | 实际 workspace 串行，来源 projectWorkspace 分组 | 每 overlay 有独立实际路径；挂载身份核验在 admission、执行、Sandbox 启动前完成 |
| 文件工具、AGENTS、Skills | 实际 workspace 中读取/写入 | 合并目录枚举与文件版本检查工作正常；脏文件可见，编辑不影响 lower |
| MCP、只读 subagent | 沿用实际 workspace 与既有 Broker 边界 | 路径可见性一致；不扩大只读 subagent 或 MCP 权限 |
| Git CLI | 普通命令执行，无专用 Git 工具 | status/diff/add/commit、锁文件与原子 rename、HEAD/index 独立及 objects/refs 共享；Sandbox 实际安装态验证 |
| 取消、关闭、恢复 | Engine 排空任务后 WorktreeService.close | 先结束 Runtime/命令，再卸载。helper 意外退出使路径不可用，不能落入空普通目录继续写入 |
| 历史续聊与重启 | 持久清单定位原 workspace | 校验 lower/upper/control 身份后重新挂载，不重新取基线；缺失或未知状态明确阻止执行 |
| tracing 与日志 | worktree.create / riftri.snapshot | 增加挂载、就绪、异常退出、卸载、恢复开始/终态和耗时；只记 ID、后端、受控错误，不记源码/安全描述符 |

WinFsp 的目录挂载与原生 Sandbox `FILE_FLAG_OPEN_REPARSE_POINT` 校验存在实际兼容问题，不能通过删掉校验来解决。实现前需用受控夹具验证挂载路径的 `realpath/lstat`、GetFileInformationByHandle 和跨账户打开结果，再选择具体路径形式。

## 验收顺序

1. 原生核心：合并枚举、copy-up、删除标记、文件/目录重命名、覆盖、大小写、并发句柄、文件锁、flush 和故障恢复；下层字节与 ACL 不变。
2. NTFS + 真实 WinFsp：宿主 Node 文件 API、Git、编辑器式临时文件替换、映射文件与目录通知；测试多实例隔离和来源变化语义。
3. 权限：真实 Windows 安全描述符、继承与拒绝、受限 token、独立 capability；验证没有通过 lower 打开的写入通道。
4. 产品联动：默认 Riftri 创建、显式 Worktree 不变、会话续聊、同目录排队、不同 overlay 并行、记忆/Skills/子任务/MCP 路径、取消及服务关闭。
5. 崩溃和重启：写入/rename/copy-up 各阶段中断、helper 被终止、失去挂载、重复服务启动和重挂载身份；未知状态不盲目重放。
6. 安装态 Sandbox：专用账户 Runtime 实际读写、Git、ACL 赋权/撤销、服务重启；宿主成功不能代替该项。

单元或原生核心测试通过不能标为挂载或安装态验证通过。达到上述条件前不将后端加入默认选择，不修改现有失败关闭行为。

## 依赖、许可与当前环境

2026-10-25 检查到本机有 MSVC x64 工具链；默认安装目录、WinFsp 注册表项及相关服务均未发现 WinFsp 安装。尚未安装驱动、SDK，未改动 Sandbox 安装或正在运行的 CodeAtelier 服务。

官方最新稳定发布查询返回 `v2.1`，安装包 `winfsp-2.1.25156.msi` 的 GitHub 资产 SHA-256 为 `073a70e00f77423e34bed98b86e600def93393ba5822204fac57a29324db9f7a`。已下载、核对该哈希，Authenticode 为 Valid、发布者 NAVIMATICS LLC；仅通过 MSI administrative extraction 解包 SDK 至 `.local/winfsp-sdk/extracted`，没有安装或启动驱动。

Riftri v0.6.5 是 MIT；WinFsp 是 GPLv3 加 FLOSS 例外，另有商业许可。不能把 Riftri 的许可结论扩展到 WinFsp。当前可继续私有开发与验证；未来分发须单独决定符合条件的开源分发或商业授权，不擅自为 CodeAtelier 选择许可证，也不假定拆成 helper 就自动解除分发义务。

参考：

- [WinFsp Native API](https://winfsp.dev/doc/WinFsp-API-winfsp.h/)
- [WinFsp Native API 与 FUSE](https://github.com/winfsp/winfsp/wiki/Native-API-vs-FUSE)
- [WinFsp 许可证](https://github.com/winfsp/winfsp/blob/master/License.txt)
- [WinFsp v2.1 发布](https://github.com/winfsp/winfsp/releases/tag/v2.1)
- [Git worktree](https://git-scm.com/docs/git-worktree)
- [Git repository layout](https://git-scm.com/docs/gitrepository-layout)
- [现有工作区行为](worktrees.md)
- [Windows root capability](windows-root-capabilities.md)
