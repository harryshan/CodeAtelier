# Local 与 Git worktree

新对话默认 **Local**：直接在选择的目录读写，不复制工作文件或创建 Git 登记，普通非 Git 目录也可使用。同一真实目录的任务串行排队；不同目录沿用 1～4 个并发任务配置。创建多个对话会得到独立历史，不自动隔离它们的工作文件。

## 显式 Git worktree

侧栏 `⑂` 或首次连接时的“改用 Git worktree”打开表单，可选择本地/远端分支或输入 commit，默认 `HEAD`。后台解析固定提交并执行标准 detached worktree checkout，不包含主目录未提交修改；不主动 fetch/pull。创建可能运行仓库配置的 checkout filters，只对信任的本地仓库使用。

清单位于 `<data>/worktrees/<UUID>.json`，工作目录位于数据目录的同级 `<data-name>-worktrees/<UUID>`，避开 Broker 私有数据。固定 UUID 绑定来源和基线，响应丢失可重试同一请求；未知或失败创建保留现场，不自动 checkout、重建或删除。

API：普通 Local 提交 `POST /api/sessions` 的 `{ "workspace": "<项目绝对路径>" }`；显式 Worktree 另加 `"worktree": { "id": "<UUID>", "baseRef": "HEAD" }`。普通 Local 每次请求建立独立对话；Worktree 的固定请求 UUID 提供幂等创建。已移除的 `riftri` 参数拒绝，不静默解释为 Local。隔离 Local 参数仍受独立总开关控制，不能与 Worktree 同选。

## Git、Sandbox 与其它系统

标准 linked worktree 独立工作文件、HEAD 和 index，Git objects、普通 refs 和公共配置共享。Git CLI 沿用普通命令权限，不提供独立 Git 工具或自动合并/推送。

任务 admission、执行和 Sandbox 启动前核对实际目录、gitfile、admin/common 目录及反向关联。Sandbox 额外投影经身份核验的 Git common 根；普通 Local 沿用原工作目录授权。文件工具、AGENTS/Skills、MCP、subagent、命令 cwd 与恢复都使用实际目录，侧栏和项目记忆按来源目录共享。

没有任务结束自动回写或删除。正常关闭只取消创建并排空任务；显式清理普通 Worktree 前须停止任务并保存成果，再使用 `git worktree remove <实际目录>`。日志/trace 保留创建、checkout、失败/取消和耗时，不采集源码或用户 ref。

## 已移除的模式

2026-10-27 D171 移除 Riftri CoW helper、旧 linked-Git overlay 和 Git tree/blob 虚拟 worktree PoC。历史、私有文件和 Git 登记不自动删除。旧 Riftri 清单/UNC 只用于来源展示及拒绝执行；清单损坏也不能转普通 Local。早期已物化为普通 linked Git worktree 的记录仍按 Git 身份核验，不再需要原 helper。

当前保留的文件系统方案是独立于 Git 的 [自研 WinFsp 隔离 Local](winfsp-overlay.md)，代码总开关默认关闭。它不替代 Git worktree，不共享 Git metadata；Linux 暂不推进，macOS 不实现。
