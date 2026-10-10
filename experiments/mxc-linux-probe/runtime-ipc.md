# native Linux：真实 Agent Runtime / Broker IPC 验证

2026-10-10，用户明确目标为 native Linux、无需关心 DrvFS。本次在既有 WSL2 Ubuntu 26.04 x64 / ext4 / 非 root UID 1000 环境运行 Linux Node 24.19.0、MXC 1.0.0、bwrap 0.11.1，不进行挂载盘对照。WSL 是验证环境，不将此证据表述为裸机或其它发行版已验收。

## 已实现的共同接口

```text
Windows Supervisor → 已认证 Named Pipe ─┐
                                       ├─ RuntimeIpcTransport
Linux MXC launcher → 私有 stdin/stdout ─┘  { input: Readable, output: Writable }
                                              ↓
                                 runAgentRuntimeTransport
                                 首帧 → 握手 → AgentRuntimeService
                                              ↕
                                 RuntimeIpcBrokerSession
                                              ↓
                                 RuntimeBrokerGateway / session handlers
```

- `src/sandbox/runtime-ipc-peer.ts` 导出统一流类型，peer、connect、Broker session 与 launcher 使用同一契约。
- `src/sandbox/agent-runtime-streams.ts` 统一启动与流结束生命周期；Windows entry 保留 pipe 名校验和连接，不改受保护 Supervisor、安装态身份验证或产品入口参数。
- Linux 手动入口在 `tests/fixtures/agent-runtime-stream-child.ts`，打包为固定 bundle 后由 MXC 启动。首帧通过私有管道交付随机 nonce 与任务/instance ID；没有环境变量身份旁路。stdout 只承载协议，stderr 仅输出固定阶段。
- 沿用 startup v1 / Runtime IPC v12、帧限制、schema、requestId、取消与 Broker capability 校验。并未实现产品 Linux launcher、安装流程、账户/generation 账本或开启配置；macOS 也未验证。

选择私有 stdio 是因为它直接来自本次 launcher 的 MXC handle，不需要额外开放端口、文件系统 socket 或建立另一套连接认证。**统一接口不是身份认证**：未来平台 launcher 仍需固定可信 Runtime 目标、绑定进程/通道与任务、保护 Broker 材料并证明进程树清理。不会把 Windows PID/Job/token 检查假装成 Linux/macOS 已具备的同一机制。

## 实测矩阵

首轮、收尾及增加显式 delta 断言后的三轮均 **8/8 通过**。

| 用例                         | 可观察断言                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 真实工具与模型/session/trace | Runtime 内 `read_file` 启动实际 Worker 读取 150 KB 夹具，`edit_files` 创建文件，`run_command` 执行 Node；第二轮模型获得文件标记和 stdout/stderr；Broker 收到完成及停止确认 |
| 四 Runtime 私有通道          | 四个隔离工作区同时完成各自两轮模型和三工具；标记与文件正确，没有正常路由串线                                                                                               |
| 错误 nonce                   | 模型调用为零、握手拒绝、Runtime 非零退出而非等待试验超时                                                                                                                   |
| 非法启动长度                 | 模型调用为零、首帧被拒绝、Runtime 非零退出                                                                                                                                 |
| 模型等待时取消               | request_cancel 传到 Broker provider，模型 AbortSignal 生效，Runtime 回报 cancelled/stopping，不重试模型                                                                    |
| 命令执行时取消               | 普通/ detached 心跳先存在，取得 cancelled/stopping 后关闭 Runtime，MXC 退出后两者均停止更新                                                                                |
| 命令执行时 IPC 断连          | pending 请求失败，没有 completed 回报，不进入下一模型轮次；退出后心跳停止，结果记 unknown                                                                                  |
| 命令执行时 Runtime kill      | pending 请求失败、结果 unknown、不重放工具；MXC 退出后心跳停止                                                                                                             |

正常命令另验证：宿主假秘密环境变量没有继承，未授权的假私有文件不可读，命令使用与 Broker 不同的 network namespace。没有发送真实 API 请求、Git push、MCP 或获批宿主命令。流式模型 delta 经 `model_delta → Runtime → session delta` 另有显式断言。

收尾复核正常链路约 326 ms，四 Runtime 合计约 410 ms，每个正常 Runtime 两轮模型、30 条会话事件、退出码 0 且未触发实验超时；取消/断连/kill 检查约 1 秒。这里只记录本机单轮样本，不是性能保证。独立 `/proc` 检查确认没有本实验的 Runtime/workload 进程残留。

### 证据边界

- 真实执行的是生产 `AgentRuntimeService`、Worker、ToolRunner、RuntimeIpcBrokerSession、RuntimeBrokerGateway；模型是固定 fixture，session handler 使用内存账本。**没有验证完整 Engine/SandboxBroker 工厂、SQLite Store 持久化或重启恢复**。
- 清理断言在 MXC Runtime 退出后检查；不据此承诺任意脱离进程组的命令后代会在 Runtime 继续存活时被工具级取消清除。
- 四通道证明正常消息归属，不证明恶意同用户 peer、所有文件别名或句柄攻击隔离。破坏 stdout 的任意恶意 Runtime 不属于可信计算基的一部分，协议 schema/能力闸门仍必需。
- 断连后的进程树停止不证明最后一次编辑没有发生；已有文件保留，没有回滚或重放。unknown 不能被出口码覆盖为 completed。
- 15/20 秒仅为手动夹具的安全期限；生产工具仍无固定总期限。不是 PTY 或交互式终端验证。
- 原生 Linux 其它发行版/架构、macOS、内核/资源攻击、完整网络模式和产品恢复仍待专项验证。

## 复现

先按 [SDK 准备说明](README.md#文件与复现) 创建 Linux 原生目录并禁用脚本安装固定 SDK。下面假设仓库依赖已安装，`ROOT` 指向该独立 Linux 实验根。不要复制宿主 `.env`、数据目录或整个 node_modules 到 Sandbox。

在仓库根用已有 Node/pnpm 工具链构建（Windows 或 Linux 均可）：

```sh
node experiments/mxc-linux-probe/build-runtime.mjs
```

在 Linux shell 中复制固定 JavaScript bundle 并运行，`REPO` 根据实际位置设置。WSL 可只从仓库挂载位置复制，工作负载、HOME、tmp 和依赖都必须在 Linux 原生目录：

```sh
REPO=/path/to/CodeAtelier
ROOT="$HOME/codeatelier-mxc-probe-unique"
APP="$ROOT/app"
mkdir -p "$APP/runtime-bundle"
cp "$REPO"/.local/mxc-runtime-bundle/*.mjs "$APP/runtime-bundle/"
cp "$REPO/experiments/mxc-linux-probe/runtime-workload.mjs" "$APP/runtime-bundle/"
cp "$REPO/experiments/mxc-linux-probe/runtime-probe.mjs" "$APP/"
env -i HOME="$ROOT/home" \
  PATH="$ROOT/node-v24.19.0-linux-x64/bin:/usr/bin:/bin" \
  MXC_FAKE_BROKER_SECRET=fixture-broker-only \
  "$ROOT/node-v24.19.0-linux-x64/bin/node" "$APP/runtime-probe.mjs"
```

`MXC_FAKE_BROKER_SECRET` 是用于断言的假字符串，不是真实凭据。不要用用户秘密替换它。脚本只产生新随机工作区，不删除历史实验目录，不需要网络、root 或 sysctl 变更。

## 文件、日志与 tracing

- `build-runtime.mjs`：固定 Runtime、三个 Worker 与 Broker fixture 的纯 JS bundle；不注册默认脚本、产品后端或变更根依赖。
- `runtime-probe.mjs`：MXC launcher 与八项手动矩阵。
- `runtime-workload.mjs`：由真实 `run_command` 执行的固定文件/namespace/心跳夹具。
- `tests/fixtures/runtime-stream-broker.ts`：共用真实 Broker adapter + 确定性模型/内存 session。
- `tests/runtime-streams.test.ts`：默认普通测试中的无 MXC 跨进程回归，不运行 Linux 实验或 Evaluation。

每次报告位于 `$APP/runtime-runs/run-*/report.json`；每个实例有 `stderr.log` 与 `trace.json`。TraceRecorder 接收真实 Runtime context/tool/Worker 固定事件，Broker gateway 记录模型生命周期；结束时归档 completed/cancelled/unknown，保留 task ID 和耗时，不新增正文/凭据属性。临时 MXC spawn/释放只计入实验用例包络；产品 launcher 专项 tracing 尚未接入，例外与后续要求见 D145。

本次报告副本、构建摘要和输出位于忽略目录 `.local/mxc-linux-probe-results/runtime-{first,final,delta}.{log,json}`、`runtime-bundle-hashes.json`。普通检查结果单独记录在 [项目验证记录](../../docs/verification.md)。不提交产物、trace 或真实会话。
