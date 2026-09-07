# 初版验证记录

日期：2026-09-07。以下区分实际验证和计划覆盖，不将构建成功等同于跨平台运行成功。

## 本机实际验证

- Windows，Node.js 24.19.0，pnpm 11.22.0。
- 类型检查、ESLint、生产前后端构建通过。
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

## 当前限制

- macOS/Linux 运行验证由新增 CI 执行，以实际 CI 结果为准；浏览器本机目前仅验证 Chromium。
- Firefox、真实 Safari、更多 CPU 架构尚未实测。
- 应用层审批不是系统沙箱；获准命令可产生当前用户权限下的副作用。
- 单任务；上下文按字符预算；输出受限；不含删除工具、自动 Git 写操作、崩溃执行恢复、自动 worktree 或完整 IDE。
- UI 密钥只驻留内存；需重启持久化时可使用不受版本控制的本地环境配置。
