# 基础 Git worktree

## 范围与授权（D165）

2026-10-25 用户要求先实现基础 worktree，并参考 [Codex worktree 工作流](https://learn.chatgpt.com/docs/environments/git-worktrees)。本阶段支持显式创建独立对话、选择已提交基线、默认 detached HEAD、持久绑定与重启后继续使用。Local 对话仍直接修改原目录。不会自动把现有对话迁移到 worktree。

暂不包含自动清理、handoff、未提交/忽略文件复制、初始化脚本、合并按钮或可写 subagent。D166 增加直接复用来源目录的可选 Riftri 原生 CoW，普通 Git worktree 作为 fallback。创建分支、提交、合并与清理继续使用普通 Git CLI 及现有权限流程。不会在新建对话时修改原仓库工作文件或当前分支。

在项目侧栏标题右侧点击 `⑂`（新建 Worktree 对话），选择起始分支或填写 commit，点击“创建 Worktree”。原有 `＋` 仍创建 Local 对话。创建不会发送模型请求；进入新对话后再提交任务。表单失败后的“重试同一请求”保留请求 UUID 和参数。清单不是实时 Git 分支状态，悬浮标签显示的是创建时基线。

新建后可让 agent 执行例如 `git switch -c codex/my-change` 保存工作分支，再按普通任务修改、验证和提交。这里的分支名是示例值，命令权限仍按实际执行环境判断。

## 存储和恢复

- 历史 sessions.workspace 始终保存实际执行目录；不改变 v11 历史格式。宿主数据目录的 `worktrees/<id>.json` 单独保存来源项目、创建基线、Git 公共目录、目录身份与创建状态。列表和 SSE 快照根据清单补充来源信息。
- checkout 放在数据目录的同级 `<数据目录名>-worktrees/<id>`，与 Broker 私有数据分离，避免 POSIX Sandbox 的 deniedPaths 把 checkout 一起屏蔽。数据目录应位于项目之外；禁止 checkout 根位于来源仓库内。
- 创建请求携带 UUID，重复请求返回已绑定对话；同一 ID 不允许改变来源/基线。Git 操作启动前持久化 preparing，成功后保存 ready。失败/中断保留现场，绝不自动重新执行未知 Git 写入或删除残留。Git 已成功且清单 ready、但对话绑定响应丢失时，可按实际 workspace 找回原对话。
- 每次提交任务和真正开始执行前检查清单、真实目录身份、gitfile 与公共 Git 目录。目录消失/被替换/清单损坏时拒绝执行；历史仍可读取，不回退原项目。正在运行时人为移动/删除工作目录不受支持。
- 首版不提供自动或 UI 删除。用户须先停止所有使用该目录的任务，保存改动与 detached HEAD 提交，再通过 `git worktree remove <实际目录>` 清理；不要使用 force。清单和历史保留。备份须同时保留历史、清单、原仓库与 checkout；首版只支持在原绝对路径恢复，不提供数据目录或 checkout 的路径迁移，不能只复制 history.sqlite。

## Riftri 原生 CoW（D166）

原版 Riftri CLI 会物化 immutable base；本接入不调用该生命周期，而使用固定 v0.6.5 `riftri-storage` 加一个窄单文件 API 的宿主 helper。来源是原 checkout，新目录直接获得 native clone，没有另一个完整基础副本、硬链接工作文件或 OverlayFS 挂载。源目录仍可正常编辑，不会被改为只读。

创建时先确定 commit，再建立标准 detached Git metadata/index。只克隆该 commit 中的普通文件，并从新副本完整读取内容计算 Git blob 哈希；不匹配的脏文件、缺失文件、受 attributes/换行/过滤器影响的文件由 Git 补齐。符号链接和 submodule 沿用 Git 行为。未跟踪/ignored 文件不枚举、不复制；来源 index 不复制。即使选择旧 commit，也只复用实际匹配的文件。空间优化仍需要遍历和校验内容，不承诺 O(1) 或更快启动。

没有 helper、卷不支持 CoW、源和目标跨卷或 sparse checkout 时使用普通 Git。原生操作开始后，单个文件克隆不可用可由 Git 补齐；helper/Git 失败、超时、取消或收据不确定则保留 failed 清单，不重新创建。旧清单没有 backend 字段时按 Git 读取；已有 checkout 续聊无需 helper，也不会自动切换后端。API 清单补充 backend/fallbackReason/clonedFiles，页面悬浮标签显示实际存储后端，日志和 trace 保留计数及受控原因。

可选 helper 构建需要宿主 Cargo/Rust ≥ 1.88 和 tar。在仓库根执行：

```sh
pnpm worktree:build-native
pnpm build
```

构建脚本下载并校验固定源码，使用 `native/riftri/Cargo.lock`，输出 `dist/native/<platform>-<arch>/codeatelier-riftri` 及上游许可证。部署时保留该目录；不安装全局 Riftri，不修改设置或自动重启服务。默认 build/check 不下载或编译 Rust，缺少 helper 正常 fallback。已经创建的普通 worktree 不会被转换为 CoW。

Linux 使用 Riftri FICLONE（例如同一 XFS/reflink 或 Btrfs 卷），macOS 有 clonefile/APFS 适配但未实机验收；Windows 当前使用普通 Git，尚未开放 ReFS/ACL 优化。Windows 服务不会隐式调用 WSL。WSL 验证运行的是 Linux 产品代码，源仓库和数据目录都在实验 XFS 卷，不能把 NTFS/DrvFS 或普通 ext4 宣称为 CoW。

## 系统联动

- 项目侧栏按来源分组；会话显示实际路径、初始基线和 Worktree 标记。选择分支只影响创建时的提交，不跟随后续分支移动。新工作区不含原目录的未提交改动、依赖、密钥或忽略文件。
- 调度、工具路径、AGENTS/Skills、命令 cwd、MCP 工作目录、子任务与恢复全部使用实际 checkout；不同 checkout 沿用 1～4 并发，同目录串行。项目记忆通过来源路径共享；不会把文件工具重定向到来源目录。
- Sandbox 启动前由 Broker 核验清单，再把该仓库真实 Git common directory 纳入可写根，使 index/objects/refs 操作可工作；不额外授权整个来源 checkout。Windows 复用根 capability/ACL，POSIX 复用 MXC writeRoots。Git 对象与 refs 是共享的，worktree 不是安全隔离边界；仓库级 Git 管理和同一分支写入仍须协调。平台安装态验收不能由宿主测试代替。
- 新建按钮是用户对固定宿主 Git 管理操作的明确授权；不是模型新工具，不扩大 run_command/run_with_permissions 的权限。查询超时 2 分钟，checkout 超时 10 分钟并复用进程树取消；使用参数数组、禁止交互及管理 hooks。正常 Git checkout 过滤器仍可能运行并使用宿主权限/网络，限于用户信任的本地仓库；不主动执行 fetch/pull。模型 Git CLI 仍沿用 D155/D162。
- 生命周期日志记录 worktree/operation ID、状态与耗时；`src/tracing` 保存创建/恢复绑定的成功、失败及关闭取消，位于数据目录 `worktrees/traces/`，不保存源码、路径、Git 输出或用户 ref。任务启动的验证复用任务 trace。失败清单可供人工诊断，不自动恢复执行。

## 验证边界

使用临时真实 Git 仓库覆盖独立修改、初始基线、请求去重、重启绑定、失效路径拒绝、共享记忆和 Sandbox 根传递；HTTP/UI 覆盖创建与历史读取。`scripts/verify-riftri.ts <实验父目录> <helper绝对路径>` 手动验证 Linux 原生路径，目录保留供 extent 检查，不负责挂载/格式化。实际结果见 verification.md；平台 Sandbox 安装态、macOS/ReFS 与巨型仓库性能须单独验证。
