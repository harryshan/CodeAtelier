# 文档导航

日常使用从 [项目 README](../README.md) 开始。本文按阅读目的组织文档；现行说明描述当前代码，历史档案保留当时的行为与证据。

## 使用与维护

| 文档                                                 | 内容                                         |
| ---------------------------------------------------- | -------------------------------------------- |
| [开发、配置与排错](development.md)                   | 环境变量、数据目录、工具权限、日志与服务操作 |
| [Windows Sandbox 使用指南](windows-sandbox-guide.md) | 预览能力的安装、启用、状态判断、维护与卸载   |
| [任务恢复](recovery.md)                              | 失败、取消、重启中断和未知执行结果           |
| [模型容量与 token](model-tokens.md)                  | 输入预算、服务 usage 与界面统计              |
| [任务 Replay Case](replay-cases.md)                  | 本地捕获、手动导出与隔离复现                 |

- [Skill 系统](skills.md)：预设目录、SKILL.md 格式、模型加载接口、优先级与权限边界。
- [MCP 本机客户端](mcp.md)：stdio/远程 HTTP 配置、工具和资源调用、审批、凭据与失败边界。

## 开发与当前设计

| 文档                              | 内容                                     |
| --------------------------------- | ---------------------------------------- |
| [AGENTS.md](../AGENTS.md)         | 仓库工作约定与开发授权边界               |
| [需求与范围](requirements.md)     | 已确认需求、产品边界与验收标准           |
| [架构](architecture.md)           | 模块职责、数据流和任务生命周期           |
| [技术选型](technical-proposal.md) | 已采用技术的理由；权限细则链接至开发说明 |
| [代码风格](code-style.md)         | 可读性、文件导读与审核要求               |
| [测试约定](testing.md)            | 测试入口、分层及当前功能覆盖             |
| [自举验证](bootstrap.md)          | 通过本项目验证开发闭环的操作约定         |
| [SWE-bench](swebench.md)          | 仅由用户手动触发的开发评测               |

## 专题与未完成边界

- [上下文管理](context-management.md)：已实现的会话压缩、历史回读与保留规则。
- [项目记忆](memory-system.md)：核心检索和模型维护已实现；管理 UI、来源失效验证和手工恢复/清空仍待实现。
- [多 agent 协作设计草案](multi-agent-design.md)：任务级开关、subagent 线程、只读权限、协调通信与 Sandbox/tracing 的待实现设计；不改变当前单 agent 范围。
- [Windows Sandbox 架构](windows-integrity-sandbox.md)：预览实现、权限边界和 W0--W6 验收要求；固定账户提升环境验收尚未完整完成。

## 历史与证据

以下记录用于追溯，不应将其中早期的“当前”或“待实现”直接作为现行行为：

- [决策记录](decisions.md)：已确认决定及替代关系。
- [验证记录](verification.md)：各次测试、平台证据及其限制。
- [旧 WSL2 Sandbox 档案](sandbox.md)：历史实现和阶段证据。
- Windows 组件实验：[专用账户](../experiments/windows-sandbox-user-demo/README.md)、[restricted token](../experiments/windows-restricted-token-demo/README.md)、[网络与 IPC](../experiments/windows-network-ipc-demo/README.md)、[Git 配置](../experiments/windows-git-config-demo/README.md)。

  它们证明局部机制，不替代产品验收。
