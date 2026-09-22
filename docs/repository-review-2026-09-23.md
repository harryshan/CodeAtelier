# 仓库审查与高优先级修复（2026-09-23）

基线：`93ba87f`，开始时工作区无未提交改动。目标是修复高优先级缺陷，保持功能范围、工具契约、审批规则和 Sandbox 目标架构。

## 已复现并修复

| 优先级 | 缺陷及影响 | 修复与回归证据 |
| --- | --- | --- |
| P1 | `src/tools/file-editor.ts` 最后一次存在性检查之后仍用 rename 发布新文件，会覆盖此时由外部程序或并行工具创建的目标 | `multi-file-edit.test.ts` 在发布前创建竞争文件，旧实现将 external contents 覆盖为 agent contents。改为硬链接原子发布，不支持硬链接时独占复制；回归核对外部内容、失败状态、临时文件清理以及兼容复制路径 |
| P1 | `src/sessions/store.ts` 在 try 外依次 BEGIN；后续分片被其他连接或压缩 Worker 占用时，前面的事务悬空，后续写入可能无法独立提交 | `store.test.ts` 用真实第二连接锁住后续分片，旧实现留下首个分片 isTransaction=true。取锁纳入异常处理，只回滚本次已取得且仍活动的事务；某次回滚失败也继续清理其他分片。回归确认释放锁后下一笔事务可提交 |
| P1 | `src/tools/process.ts` 的输出持久化回调抛错及 stdin 提前关闭均产生未捕获异常，可能结束整个服务；Sandbox 的 PID/输出/启动回调有同类遗漏 | 真实子进程回归复现 uncaught exception 和错误的成功结果。先注册监听，捕获回调/管道错误，停止并等待 close 后返回错误。Supervisor 路径等待清理证明，缺失时优先返回 cleanup_unknown；内存管道回归覆盖 Runner 的 PID/输出/stdin 故障、有无清理证明和 Agent Runtime 两阶段 PID 通知故障 |

没有增加新工具、改变审批规则或自动重放命令。已有文件仍使用原快照检查和 rename；独占复制不保证复制中间内容完整可见，失败沿用 unknown 状态。SQLite 修复不引入跨分片分布式事务承诺。

## 范围与验证

按风险检查模块及交接路径：HTTP 访问校验、SSE 与关闭；Engine、共享模型循环、工具 DAG、审批与恢复；文件读写、路径、Git 和命令；SQLite 分片及 Worker、上下文压缩、项目记忆；Responses、日志与 tracing；Web 会话连接和 Markdown；Sandbox Broker、IPC、Supervisor 适配、relay，以及原生清理和安装脚本相关代码。对照 requirements、architecture、development、testing 等文档。Evaluation 仅作静态检查，未执行。

这是以关键路径和回归为主的仓库级审查，不表示逐行证明整个仓库无缺陷，也不将已接受的 Sandbox 残余风险改列为缺陷。

- Windows / Node 24：最终 `pnpm check` 成功，59 个测试文件通过，421 项通过、1 项平台跳过；类型、lint、格式及服务/Web/Runtime bundle 构建通过。
- Chromium：`pnpm test:e2e` 成功，23/23 用例通过，测试进程正常退出。
- 最初在外层沙箱内执行 check 遇到 shutdown 超时及 SQLite EBUSY；同一 shutdown 测试在外层沙箱之外 3/3 通过，最终完整 check 也通过。没有放宽断言或修改正常进程终止语义。
- 修复沿用工具执行、任务错误和 Sandbox 生命周期 tracing，没有新增正文、凭据或原始输出属性。
- 未运行真实模型、Evaluation、macOS/Linux 验收，未安装或修改专用账户、ACL、WFP。内存管道测试不替代 Windows 固定账户提升环境的原生端到端验收。
