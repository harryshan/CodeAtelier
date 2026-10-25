# Riftri 与 Git worktree 工作区

## 选择模式（D167）

新对话默认使用 **Riftri**：从主目录创建时的文件状态建立独立原生 CoW 副本，保留未提交修改、暂存区、未跟踪与忽略文件。不能指定分支或 commit，不另建完整 base。这里的 overlay 是独立 CoW 文件视图，不是 OverlayFS 挂载，也不实时跟随主目录后续编辑。

需要从特定提交开始时，显式选择 **Git worktree**：沿用普通 Git 的指定基线、detached HEAD 与共享对象/refs；不复制脏文件、未跟踪或忽略文件。两种模式并列，不互相自动降级。

在项目侧栏点击 `＋` 默认创建 Riftri，`⑂` 打开 Worktree 表单；首次连接项目也可点“改用 Git worktree”。Riftri 缺少 helper、跨卷或卷不支持时拒绝创建，提示显式选择 Worktree。Windows 服务不会隐式调用 WSL，也不会用完整字节复制替代 CoW。

每个新对话获得一个独立实际目录，同一对话后续任务和恢复继续使用该目录，不在每轮重新取主目录。已有 Local 历史保留原路径和续聊语义，不自动迁移已有改动。模式在创建时固定。没有自动清理、回写、合并、handoff 或可写 subagent。

## Riftri 当前状态副本

使用固定 Riftri v0.6.5 `riftri-storage` 的单文件原生 API 和 v2 宿主 helper，不调用上游 immutable-base CLI。遍历主目录的所有条目，为普通文件建立私有 inode 并共享底层数据块；不运行 Git checkout、clean/smudge 或计算 Git blob hash。普通 rwx 文件权限保留，不复制 setuid/setgid；不改变来源权限。目录使用创建者的默认权限，文件扩展属性/ACL 不保证完整保留，macOS 带 ACL 文件保守拒绝。

`.git` 也独立克隆，保留 HEAD、分支、refs、index 和 objects；`git add/commit/switch` 不修改原仓库的 index/refs。副本不是 Git linked worktree，不出现在原仓库的 worktree list。来源 `.git/worktrees` 是其他工作区的登记信息，不复制。无 Git 的普通目录也可使用 Riftri。

首批明确拒绝 linked checkout/gitfile、外置 Git metadata、`core.worktree` 重定向、alternates、嵌套 Git 仓库、Git 活跃锁、特殊文件以及指向来源树外的符号链接。相对内部链接保留，指向树内的绝对链接改指副本；不递归跟随链接。初始化 submodule 的 gitfile 也属于当前不支持的情况。这些限制避免副本的 Git/链接操作写回原目录；它仍不是新的 OS 安全边界。

逐文件 CoW 并非全目录原子快照。创建期间主目录应保持静止；每个条目复制前后检查文件身份、大小、时间，观察到变化就停止并保留失败现场。不能保证检测到所有跨文件并发编辑，也不允许把它当成数据库一致性快照。完整目录仍需要 O(文件数) 枚举、元数据和新条目创建；没有巨型仓库性能承诺。ignored 依赖和构建产物也在范围内，可能增加大量元数据和后续 CoW 空间。

## Git worktree

表单选择起始分支或填写 commit；默认 HEAD，创建时解析为固定提交并建立 detached HEAD。原目录当前分支和工作文件不变。可以让 agent 执行 `git switch -c codex/my-change` 保存工作分支，再按普通权限流程提交或合并。

新建操作可能运行仓库配置的 Git checkout filters，限于信任的本地仓库；固定管理命令禁止交互与管理 hooks，不主动 fetch/pull。模型 Git CLI 仍遵守 D155/D162 通用命令权限。旧 D166 创建的 Riftri-backed linked worktree 保持旧模式和共享 Git 语义，不转换成新的 Riftri 快照。

## 存储、重试与恢复

- `sessions.workspace` 始终保存实际执行目录；不改变历史 v11 格式。`<data>/worktrees/<UUID>.json` 记录 mode、来源、创建状态、目录身份和后端；旧清单缺少 mode 时按 Worktree 读取，绝不根据 backend 猜测新模式。
- 两种目录都保存在数据目录同级 `<数据目录名>-worktrees/<UUID>`，避免被 Sandbox 的 Broker 私有目录屏蔽规则覆盖。Riftri 来源与私有数据、托管目录必须不重叠；数据目录应设在项目之外。
- `POST /api/sessions` 默认 Riftri；UI 发送 `riftri: { id: UUID }` 固定请求。显式 Worktree 发送 `worktree: { id: UUID, baseRef: "HEAD" }`；禁止同时选择或为 Riftri 提交基线。只发 workspace 的 API 调用也默认 Riftri，但调用方应提供 UUID 才能安全重试响应丢失。
- 同一 ID 固定来源、模式和基线。preparing 在写入前保存；失败、取消、未知结果均保留现场，不重放、不删除、不改用另一模式。成功目录在对话保存失败时仍可按同一 ID 绑定。
- admission、真正执行和 Sandbox 启动前重新验证清单与实际目录身份。Worktree 额外验证 gitfile/common directory；Riftri 验证自己内部的 Git 目录。缺失或替换时拒绝执行，不回退原项目。已有 Riftri 续聊无需 helper，也不依赖原仓库仍然存在。
- 创建查询超时 2 分钟，原生 snapshot/Git checkout 超时 10 分钟，关闭服务取消进程树并排空创建队列。关闭浏览器不等于后端创建已取消。

没有 UI/自动删除。先停止相关任务并保存成果：普通 Worktree 用 `git worktree remove <实际目录>`，Riftri 是独立目录，确认内容已保存后自行删除该目录，不能用原仓库的 worktree remove。历史和清单保留。备份时保存历史、清单和实际目录；Worktree 还依赖原仓库公共 Git 目录。首版只支持原绝对路径恢复，不自动迁移路径。

## 系统联动与观测

侧栏、项目记忆按来源项目共享；调度、文件工具、AGENTS/Skills、命令 cwd、MCP、只读 subagent 和恢复都使用实际目录。不同实际目录沿用 1～4 并发，同目录串行。Riftri 包含创建时未提交的 AGENTS/Skills 文件，Worktree 读取所选提交版本。

Sandbox 对 Riftri 只使用实际目录，**不追加来源 `.git` 写根**；普通 Worktree 继续追加经过身份核验的 Git common directory。沿用各平台既有权限限制，不扩大任务间 OS 隔离保证。宿主任务仍按已有命令审批执行。

创建日志/trace 保存 operation/workspace ID、mode/backend、克隆文件计数、成功/失败/取消和耗时；Riftri 使用 `riftri.snapshot` span，Worktree 使用 `worktree.checkout`。trace 位于 `<data>/worktrees/traces/`，不记录文件正文、路径或用户 ref。任务中的目录验证继续使用任务 trace。

## 构建与平台

在宿主预装 Cargo/Rust ≥ 1.88 与 tar 后显式执行：

```sh
pnpm worktree:build-native
pnpm build
```

构建脚本下载并校验固定源码，用 Cargo.lock 构建 v2 helper 到 `dist/native/<platform>-<arch>/codeatelier-riftri`，保留该目录及许可证。默认 build/check 不构建 Rust，不安装全局 Riftri，不修改设置或自动重启服务。旧 v1 helper 拒绝作为新快照后端，需重新构建；已有目录恢复不受影响。

Linux 使用 FICLONE（同一支持 reflink 的 XFS/Btrfs 文件系统）；macOS 有 APFS clonefile 适配，但未实机验收。Windows 尚未开放原生 CoW/ACL 支持，默认 Riftri 会明确失败，可显式使用 Git worktree。WSL 验证的是 Linux 产品代码和实验 XFS，不能扩展为 NTFS/DrvFS、普通 ext4 或 Windows Sandbox 验收。

测试覆盖见 [testing.md](testing.md)，实测记录见 [verification.md](verification.md)。`scripts/verify-riftri.ts <实验父目录> <helper绝对路径>` 手动运行，不创建或挂载文件系统，不属于 Evaluation。
