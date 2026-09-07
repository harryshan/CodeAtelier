# 初版验证记录

日期：2026-09-07。以下区分实际验证和计划覆盖，不将构建成功等同于跨平台运行成功。

## 本机实际验证

- Windows，Node.js 24.19.0，pnpm 11.22.0。
- 类型检查、ESLint、生产前后端构建通过。最新本机回归为 79 项通过、1 项 POSIX 文件模式测试在 Windows 跳过；6 项 Chromium UI 验收通过。
- 核心测试覆盖文件读取前置条件、外部并发修改、精确替换、外部访问拒绝、junction 越界、取消审批、命令超时、输出限制及非零退出码、SQLite 重启恢复、单任务锁、工具回传、本机请求校验、密钥不写设置与日志脱敏。
- Responses 协议回归覆盖 item.done 收集、缺少完成事件、failed/incomplete/error。
- Chromium 浏览器验收通过：会话创建、真实文件写入、diff、刷新后历史、审批刷新/拒绝/取消、设置保存不返回密钥。
- 已人工查看欢迎页截图，布局无明显遮挡或溢出。

## 真实自建服务

服务：http://jp.harryshan.com:4141/v1/responses。

1. 5.6-luna 简称返回 400、不支持此端点。
2. /v1/models 公布 codex/gpt-5.6-luna；后续使用该标识。
3. 官方 SDK 流式请求、function_call、function_call_output 回传和最终文本 CODEATELIER_OK 均验证通过。
4. 观察到 completed.output 可为空，完整调用项出现在 output_item.done；适配器已覆盖该行为。
5. 真实 agent 在独立示例中将 add(a,b) 的 a-b 修复为 a+b，添加负数相加测试，运行 node --test，退出码为 0，任务状态 completed。未对用户项目执行试验性修改。

## GitHub CI

- 初版提交 cfac6fe 的 Windows、Linux、macOS 核心检查及 Linux Chromium UI 验收全部通过。
- [已完成的跨平台运行](https://github.com/harryshan/CodeAtelier/actions/runs/34068860495)。后续新增回归以对应提交的 CI 结果为准。

## 当前限制

- CI 已验证托管 Windows/Linux/macOS 环境中的核心逻辑与构建，以及 Linux Chromium UI；真实模型端到端任务目前只在本机 Windows 验证。
- Firefox、真实 Safari、更多 CPU 架构尚未实测。
- 应用层审批不是系统沙箱；获准命令可产生当前用户权限下的副作用。
- 单任务；上下文按字符预算；输出受限；不含删除工具、自动 Git 写操作、无人值守崩溃执行恢复、自动 worktree 或完整 IDE。
- UI 密钥只驻留内存；需重启持久化时可使用不受版本控制的本地环境配置。

## 恢复机制增量验证（2026-09-07）

- 新增 8 项故障注入/恢复测试：重试预算及 HTTP 分类、退避取消、真实 HTTP SSE 缺失完成事件、请求与空闲超时、文件编辑后的人工恢复、SQLite 重启后已知/未知结果修补、等待审批时关闭与取消、工具完成后模型自动重试不重复编辑。
- Chromium 验收增加取消后刷新并恢复、部分回复与成功回复隔离、SSE 401 后重连且不提交任务。
- pnpm check 和 pnpm test:e2e 在本机 Windows 通过。本次错误注入使用本机模拟服务，未对用户自建服务制造故障；跨平台结果以本次提交 CI 为准。

## 功能测试补齐（2026-09-07）

- 新增 54 项单元/集成回归测试，以及 1 项浏览器历史续聊/隔离验收。功能对应关系见 testing.md。
- 先由新增测试复现搜索返回 101 条、反向行号范围成功返回空值、结构化 token/password 未脱敏，再修复并验证。
- Windows 本机 pnpm check 通过（79 通过、1 项 POSIX 模式跳过），pnpm test:e2e 为 6 项通过。POSIX CI 跳过 Windows ADS 用例，执行 POSIX 文件模式用例；本次跨平台结果以对应提交 CI 为准。
