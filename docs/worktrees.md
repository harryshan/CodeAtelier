# Riftri 与 Git worktree 工作区

2026-10-25 用户按 D170 重新澄清 Overlay 的目标为 Local 对话文件隔离与冲突整合，独立于 Git worktree，见 [重新设计](local-overlay-design.md)。该设计尚未实施；下文描述当前既有行为，不代表新方向已切换上线。

此前提交基线虚拟化的实现与计量保留在 [WinFsp PoC（D169）](virtual-worktree-poc.md)，不作为 D170 的后续方向。它不进入以下生产入口；当前默认模式与既有会话仍按本页执行。

## 选择模式（D167 / D168）

新对话默认使用 **Riftri**，包含主目录的未提交修改、暂存区、未跟踪与忽略文件；不能指定分支或 commit，不另建完整 base。Linux/macOS 使用创建时原生 CoW 副本；Windows 使用 WinFsp 实时 overlay，尚未写入私有层的文件继续读取主目录。两者的时间语义和 Git 共享边界不同，不能统称固定快照。

需要从特定提交开始时，显式选择 **Git worktree**：沿用普通 Git 的指定基线、detached HEAD 与共享对象/refs；不复制脏文件、未跟踪或忽略文件。两种模式并列，不互相自动降级。

在项目侧栏点击 `＋` 默认创建 Riftri，`⑂` 打开 Worktree 表单；首次连接项目也可点“改用 Git worktree”。缺少 helper/WinFsp Runtime，或 POSIX 跨卷/无原生 CoW 时拒绝创建，提示显式选择 Worktree。Windows 服务不会隐式调用 WSL，也不会用完整复制替代 overlay。

每个新对话获得一个独立实际目录，同一对话后续任务和恢复继续使用该目录，不在每轮重新取主目录。已有 Local 历史保留原路径和续聊语义，不自动迁移已有改动。模式在创建时固定。没有自动清理、回写、合并、handoff 或可写 subagent。

## Linux/macOS：Riftri 当前状态副本

使用固定 Riftri v0.6.5 `riftri-storage` 的单文件原生 API 和 v2 宿主 helper，不调用上游 immutable-base CLI。遍历主目录的所有条目，为普通文件建立私有 inode 并共享底层数据块；不运行 Git checkout、clean/smudge 或计算 Git blob hash。普通 rwx 文件权限保留，不复制 setuid/setgid；不改变来源权限。目录使用创建者的默认权限，文件扩展属性/ACL 不保证完整保留，macOS 带 ACL 文件保守拒绝。

`.git` 也独立克隆，保留 HEAD、分支、refs、index 和 objects；`git add/commit/switch` 不修改原仓库的 index/refs。副本不是 Git linked worktree，不出现在原仓库的 worktree list。来源 `.git/worktrees` 是其他工作区的登记信息，不复制。无 Git 的普通目录也可使用 Riftri。

首批明确拒绝 linked checkout/gitfile、外置 Git metadata、`core.worktree` 重定向、alternates、嵌套 Git 仓库、Git 活跃锁、特殊文件以及指向来源树外的符号链接。相对内部链接保留，指向树内的绝对链接改指副本；不递归跟随链接。初始化 submodule 的 gitfile 也属于当前不支持的情况。这些限制避免副本的 Git/链接操作写回原目录；它仍不是新的 OS 安全边界。

逐文件 CoW 并非全目录原子快照。创建期间主目录应保持静止；每个条目复制前后检查文件身份、大小、时间，观察到变化就停止并保留失败现场。不能保证检测到所有跨文件并发编辑，也不允许把它当成数据库一致性快照。完整目录仍需要 O(文件数) 枚举、元数据和新条目创建；没有巨型仓库性能承诺。ignored 依赖和构建产物也在范围内，可能增加大量元数据和后续 CoW 空间。

## Windows：WinFsp 实时 overlay

由 `native/winfsp-overlay` 使用 WinFsp 原生 API 实现，后端标识为 `riftri-winfsp`；Windows 不调用 Riftri 上游 CLI/storage，不把此实现称为上游现成功能。来源目录直接作为只读 lower；首次写入普通文件时复制该文件到私有对象层，后续内容、重命名、删除标记和 ACL 都保存在私有层。创建不扫描或 hash 全部项目文件，不复制 `.git/objects`，不依赖 NTFS 块级 reflink。按访问导入的元数据和被修改的大文件仍占空间，尚无巨型 repo 性能承诺。

Git 使用 `worktree add --detach --no-checkout --lock` 登记，任务 gitfile 覆盖 lower 的 `.git`。复制来源 index，必要时复制其引用的 sharedindex 并在任务侧展开；清除任务侧 fsmonitor/untracked 缓存。HEAD/index 独立，objects、普通 refs、公共 config 共享。task commit 不移动来源 HEAD 或改写来源工作文件，但显式 branch/fetch/config 等仍有普通 worktree 的共享影响。无提交仓库使用专属 orphan 分支；无 Git 目录只建立 overlay。

实际目录是本机 `\\CodeAtelier\<数据目录摘要>-<UUID>\`，由 WinFsp 本机 MUP provider 提供，不建立 SMB 服务、盘符或 junction 入口。未覆盖的 lower 文件和目录可随来源变化；来源必须持续保留。已写入的子项保留在私有目录映射中。内部 junction 转为指向挂载内的目录 symlink，因此 Git 对未忽略 junction 的类型/显示可能不同；不能将它误报成完全相同的 NTFS junction。

当前拒绝来源 linked checkout/外置 Git metadata、submodule（`.gitmodules`）、进行中的 merge/rebase/cherry-pick、core.worktree、sparse-checkout 和启用的 fsmonitor。嵌套 `.git`、外部链接和不支持的重解析点在访问时失败，不跟随到 lower 或外部路径写入。保存 owner/group，支持 DACL 拒绝 ACE、继承和保护标记；**不宣称完整 NTFS/ACL 等价**：SACL/审计/完整性标签写入、ADS、EFS、创建硬链接等未支持，lower 的外部变化不发送文件通知。来源硬链接在虚拟视图中按路径独立 copy-up。仅支持 Windows x64；依赖盘符工作目录的程序（如 cmd.exe）需要另外评估 UNC 兼容性，本机真实验证范围见 [WinFsp 后端](winfsp-overlay.md)。

## Git worktree

表单选择起始分支或填写 commit；默认 HEAD，创建时解析为固定提交并建立 detached HEAD。原目录当前分支和工作文件不变。可以让 agent 执行 `git switch -c codex/my-change` 保存工作分支，再按普通权限流程提交或合并。

新建操作可能运行仓库配置的 Git checkout filters，限于信任的本地仓库；固定管理命令禁止交互与管理 hooks，不主动 fetch/pull。模型 Git CLI 仍遵守 D155/D162 通用命令权限。旧 D166 创建的 Riftri-backed linked worktree 保持旧模式和共享 Git 语义，不转换成新的 Riftri 快照。

## 存储、重试与恢复

- `sessions.workspace` 始终保存实际执行目录；不改变历史 v11 格式。`<data>/worktrees/<UUID>.json` 记录 mode、来源、创建状态、目录身份和后端；旧清单缺少 mode 时按 Worktree 读取，绝不根据 backend 猜测新模式。
- 普通 Worktree 和 POSIX CoW 目录保存在数据目录同级 `<数据目录名>-worktrees/<UUID>`。Windows 挂载路径如上，控制库/upper 对象在 `<data>/worktrees/<UUID>-overlay`，Git 登记中转目录为 `<UUID>-registration`，均不作为 Runtime 文件根。来源与私有数据、托管目录必须不重叠；数据目录应设在项目之外。
- `POST /api/sessions` 默认 Riftri；UI 发送 `riftri: { id: UUID }` 固定请求。显式 Worktree 发送 `worktree: { id: UUID, baseRef: "HEAD" }`；禁止同时选择或为 Riftri 提交基线。只发 workspace 的 API 调用也默认 Riftri，但调用方应提供 UUID 才能安全重试响应丢失。
- 同一 ID 固定来源、模式和基线。preparing 在写入前保存；失败、取消、未知结果均保留现场，不重放、不删除、不改用另一模式。成功目录在对话保存失败时仍可按同一 ID 绑定。
- admission、真正执行和 Sandbox 启动前重新验证身份。Worktree 和 Windows overlay 验证 gitfile/common directory；POSIX Riftri 验证内部 Git 目录。Windows 还验证 lower/control 身份，按需恢复相同挂载，稳定卷号/inode/birthtime 保持持久 capability 身份。缺失、替换或异常状态拒绝执行，不回退原项目。只有 POSIX 副本不依赖来源及 helper 继续存在。
- 创建查询超时 2 分钟，原生 snapshot/Git checkout 超时 10 分钟，关闭服务取消进程树并排空创建队列。关闭浏览器不等于后端创建已取消。
- Windows helper ready 最多等待 30 秒，关闭先排空任务和 Sandbox 再卸载；普通任务结束保留挂载。SQLite 格式 v2 保存 clean 标记，正常卸载后才能恢复；helper 被强杀、写入/事务未知或 Cleanup 失败不自动清除标记或重挂载。父服务退出导致 stdin EOF 时 helper 尝试正常卸载，失败仍保留现场。

没有 UI/自动删除。先停止相关任务并保存成果：普通 Worktree 用 `git worktree remove <实际目录>`；POSIX Riftri 是独立目录。Windows overlay 卸载后仍保留锁定的 Git 登记和私有层，不要在活动挂载上运行 worktree remove，也不要把 UNC 目录当成可直接删除的完整副本。备份需要历史、清单、私有层及来源目录/公共 Git metadata；未知状态先检查现场，不提供自动修复或迁移路径。

## 系统联动与观测

侧栏、项目记忆按来源项目共享；调度、文件工具、AGENTS/Skills、命令 cwd、MCP、只读 subagent 和恢复都使用实际目录。不同实际目录沿用 1～4 并发，同目录串行。POSIX Riftri 包含创建时未提交的 AGENTS/Skills 文件，Windows overlay 继续读取尚未覆盖的来源文件当前内容；Worktree 读取所选提交版本。

POSIX Riftri 不追加来源 `.git` 写根；Windows overlay 与普通 Worktree 一样追加经身份核验的 Git common directory。Windows 的工作文件 ACL 授权发生在虚拟卷，来源工作文件 ACL 不变，不放宽 Sandbox 对重解析入口的检查。UNC 的精确 Git safe.directory 信任只进入任务子进程或既有 Runtime 实例配置，不修改用户 global 配置。沿用既有权限限制，不扩大任务间 OS 隔离保证；宿主命令仍按现有审批执行。

创建日志/trace 保存 ID、mode/backend、克隆计数、终态与耗时；POSIX 使用 `riftri.snapshot`，Worktree 使用 `worktree.checkout`。Windows 增加 `overlay.mount/restore/unmount/unexpected_exit`，放在 `<data>/worktrees/overlay-traces/traces/`；原生 DEBUG 诊断只记状态码/源码行号，Cleanup 失败为 WARN。不记录文件正文、路径、ACL 或用户 ref。

## 构建与平台

在宿主预装 Cargo/Rust ≥ 1.88 与 tar 后显式执行：

```sh
pnpm worktree:build-native
pnpm build
```

构建脚本下载并校验固定源码，用 Cargo.lock 构建 v2 helper 到 `dist/native/<platform>-<arch>/codeatelier-riftri`，保留该目录及许可证。默认 build/check 不构建 Rust，不安装全局 Riftri，不修改设置或自动重启服务。旧 v1 helper 拒绝作为新快照后端，需重新构建；已有目录恢复不受影响。

Linux 使用 FICLONE（同一支持 reflink 的 XFS/Btrfs）；macOS APFS clonefile 未实机验收。WSL 验证只对应 Linux，不能扩展为 NTFS/DrvFS 或普通 ext4。

Windows 需安装官方 WinFsp Runtime，并准备 WinFsp 2.1 SDK、MSVC x64 工具链，显式构建：

```powershell
pnpm worktree:build-winfsp -Sdk 'C:\path\to\WinFsp-SDK'
pnpm worktree:verify-winfsp
# 已安装 CodeAtelier Sandbox 时，额外验证真实 Runtime；不安装或 Repair。
pnpm worktree:verify-winfsp --sandbox
pnpm build
```

SDK 目录须包含 `inc/winfsp`、`lib/winfsp-x64.lib`、`License.txt`。产物为 `dist/native/win32-x64/codeatelier-overlay.exe`；默认 build/check 不下载 SDK、不安装驱动，也不运行上述实机验证。WinFsp 许可与 Riftri 分开记录，见 [依赖边界](winfsp-overlay.md#依赖许可与当前环境)。

测试覆盖见 [testing.md](testing.md)，实测记录见 [verification.md](verification.md)。`scripts/verify-riftri.ts <实验父目录> <helper绝对路径>` 手动运行，不创建或挂载文件系统，不属于 Evaluation。
