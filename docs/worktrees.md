# 基础 Git worktree

## 范围与授权（D165）

2026-10-25 用户要求先实现基础 worktree，并参考 [Codex worktree 工作流](https://learn.chatgpt.com/docs/environments/git-worktrees)。本阶段支持显式创建独立对话、选择已提交基线、默认 detached HEAD、持久绑定与重启后继续使用。Local 对话仍直接修改原目录。不会自动把现有对话迁移到 worktree。

暂不包含自动清理、handoff、未提交/忽略文件复制、初始化脚本、合并按钮、CoW/Riftri 或可写 subagent。创建分支、提交、合并与清理继续使用普通 Git CLI 及现有权限流程。不会在新建对话时修改原仓库工作文件或当前分支。

在项目侧栏标题右侧点击 `⑂`（新建 Worktree 对话），选择起始分支或填写 commit，点击“创建 Worktree”。原有 `＋` 仍创建 Local 对话。创建不会发送模型请求；进入新对话后再提交任务。表单失败后的“重试同一请求”保留请求 UUID 和参数。清单不是实时 Git 分支状态，悬浮标签显示的是创建时基线。

新建后可让 agent 执行例如 `git switch -c codex/my-change` 保存工作分支，再按普通任务修改、验证和提交。这里的分支名是示例值，命令权限仍按实际执行环境判断。

## 存储和恢复

D172 分支拆分后，Riftri/overlay 实验在 `overlay-development` 继续保留；main 只运行下面的标准 Git worktree。旧实验模式清单、Windows `\\CodeAtelier\` 保留路径及本数据目录的 `local-overlays` 私有路径显示不可用并拒绝任务，不挂载或删除数据。需要处理旧实验会话时使用实验分支；main 不负责其挂载、发布或 ACL 虚拟根恢复。

- 历史 sessions.workspace 始终保存实际执行目录；不改变 v11 历史格式。宿主数据目录的 `worktrees/<id>.json` 单独保存来源项目、创建基线、Git 公共目录、目录身份与创建状态。列表和 SSE 快照根据清单补充来源信息。
- checkout 放在数据目录的同级 `<数据目录名>-worktrees/<id>`，与 Broker 私有数据分离，避免 POSIX Sandbox 的 deniedPaths 把 checkout 一起屏蔽。数据目录应位于项目之外；禁止 checkout 根位于来源仓库内。
- 创建请求携带 UUID，重复请求返回已绑定对话；同一 ID 不允许改变来源/基线。Git 操作启动前持久化 preparing，成功后保存 ready。失败/中断保留现场，绝不自动重新执行未知 Git 写入或删除残留。Git 已成功且清单 ready、但对话绑定响应丢失时，可按实际 workspace 找回原对话。
- 每次提交任务和真正开始执行前检查清单、真实目录身份、gitfile 与公共 Git 目录。目录消失/被替换/清单损坏时拒绝执行；历史仍可读取，不回退原项目。正在运行时人为移动/删除工作目录不受支持。
- 首版不提供自动或 UI 删除。用户须先停止所有使用该目录的任务，保存改动与 detached HEAD 提交，再通过 `git worktree remove <实际目录>` 清理；不要使用 force。清单和历史保留。备份须同时保留历史、清单、原仓库与 checkout；首版只支持在原绝对路径恢复，不提供数据目录或 checkout 的路径迁移，不能只复制 history.sqlite。

## 系统联动

- 项目侧栏按来源分组；会话显示实际路径、初始基线和 Worktree 标记。选择分支只影响创建时的提交，不跟随后续分支移动。新工作区不含原目录的未提交改动、依赖、密钥或忽略文件。
- 调度、工具路径、AGENTS/Skills、命令 cwd、MCP 工作目录、子任务与恢复全部使用实际 checkout；D173 允许不同 checkout 及同目录的多个会话不限主任务数并行；worktree 用于分离工作文件，不再是同项目并行的必要条件。项目记忆通过来源路径共享；不会把文件工具重定向到来源目录。
- Sandbox 启动前由 Broker 核验清单，再把该仓库真实 Git common directory 纳入可写根，使 index/objects/refs 操作可工作；不额外授权整个来源 checkout。Windows 复用根 capability/ACL，POSIX 复用 MXC writeRoots。Git 对象与 refs 是共享的，worktree 不是安全隔离边界；仓库级 Git 管理和同一分支写入仍须协调。平台安装态验收不能由宿主测试代替。
- 新建按钮是用户对固定宿主 Git 管理操作的明确授权；不是模型新工具，不扩大 run_command/run_with_permissions 的权限。查询超时 2 分钟，checkout 超时 10 分钟并复用进程树取消；使用参数数组、禁止交互及管理 hooks。正常 Git checkout 过滤器仍可能运行并使用宿主权限/网络，限于用户信任的本地仓库；不主动执行 fetch/pull。模型 Git CLI 仍沿用 D155/D162。
- 生命周期日志记录 worktree/operation ID、状态与耗时；`src/tracing` 保存创建/恢复绑定的成功、失败及关闭取消，位于数据目录 `worktrees/traces/`，不保存源码、路径、Git 输出或用户 ref。任务启动的验证复用任务 trace。失败清单可供人工诊断，不自动恢复执行。

## 验证边界

使用临时真实 Git 仓库覆盖独立修改、初始基线、请求去重、重启绑定、失效路径拒绝、共享记忆和 Sandbox 根传递；HTTP/UI 覆盖创建与历史读取。平台安装态与巨型仓库性能须单独验证，本阶段不宣称 CoW 或空间优化。
