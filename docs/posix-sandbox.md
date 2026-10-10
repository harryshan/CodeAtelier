# Linux / macOS Sandbox

状态：已接入产品工厂，默认关闭。Linux 已在 WSL2 的 Linux 原生 ext4 目录验证真实 Engine/SQLite/MXC 链路；**macOS 仅完成实现及离线策略检查，按用户要求尚未实机验证**。目标是 native Linux，不依赖 WSL，不以 DrvFS 为目标。不能把 WSL 证据等同所有发行版、架构或裸机验收。

## 启用

使用非 root 用户及 Node.js 24 或 26。Linux 需要本机 Bubblewrap 和可用的非特权 user namespace；当前验证环境是 Ubuntu 26.04、bwrap 0.11.1、Node 24.19.0。应用不自动安装系统包、调整 sysctl 或提升权限。macOS 启动器要求 macOS 15+，选择 MXC Seatbelt 后端；仍应视为未验收功能。

根项目固定可选依赖 `@microsoft/mxc-sdk@1.0.0`。它只在启用 POSIX Sandbox 的任务启动时加载；未安装该可选依赖或后端不可用时任务失败，不静默取消隔离要求。

```sh
pnpm install --frozen-lockfile
pnpm build
CODEATELIER_SANDBOX_ENABLED=true pnpm start
```

也可在本地 `.env` 设置 `CODEATELIER_SANDBOX_ENABLED=true` 后重启服务。开发模式首次运行及 Runtime/Worker 源码变化后，先执行 `pnpm sandbox:posix:build`，再运行 `pnpm dev`。普通 `pnpm build` 和 `pnpm build:test` 都构建固定 POSIX bundle，但不会启动 MXC 或运行手动探针。构建产物为 `dist/runtime/posix`，不依赖 Windows 安装器。

关闭开关才明确选择宿主执行。Linux/macOS 启用后自检、SDK、bundle 或启动失败均停止该次任务；**没有 Windows 的启动前宿主 fallback**。检查任务实际状态，不能把“已请求 Sandbox”当成“已生效”。

## 文件、环境与网络

- 每个任务具有独立私有 HOME/tmp、只读 Runtime/三个 Worker 代码快照。固定 manifest 的四个文件和摘要在复制前核对；构建目录是可信应用安装内容，摘要不是第三方签名。
- 工作区直接可写，包括 `.git`、`.env`；不提供回滚。Node 安装前缀和显式只读根可读，MXC 自身还提供系统运行基线，不能宣称工作区外完全不可见。
- 不继承宿主环境，PATH 只包含固定 Node 路径和系统命令目录。模型、Store、审批、项目记忆等留在 Broker。
- 使用真实路径检查，拒绝授权根与 Broker 数据或实例私有根交叉，以及可写根覆盖固定 Node。Broker 数据不应位于工作区、额外授权根或 Node 安装前缀中。不要把整个 HOME、`/tmp` 或 `/` 授权给 Runtime。
- 默认请求双向断网和宿主 loopback 禁止，不提供 Runtime 直接联网的 allow-host 配置。Git/MCP 和审批通过的 `run_with_permissions` 仍在 Broker 宿主执行，使用宿主文件、网络和凭据，**不受 Sandbox 限制**。
- 可写目录里的既有硬链接、文件系统 UNIX socket、可变符号链接及同宿主用户进程仍需按平台理解；断网不等于阻止 AF_UNIX。Linux `deniedPaths` 的空 tmpfs 遮蔽不代表影子目录不可写。macOS 不具有 Linux namespace 的相同语义，不能继承其隔离结论。
- 固定 bundle、依赖及 Node 安装目录必须可信且不由被测项目维护。此版本不承诺抵御恶意同 UID 宿主程序、完整任务间隔离、磁盘/CPU 配额或全部平台安全矩阵。

POSIX 可选额外根从宿主启动环境的 JSON 数组读取，必须为已存在的绝对路径；非法值拒绝，不从模型参数或工作区配置取得。这些设置只影响 POSIX 后端。以下是路径示例，先替换为实际存在、非敏感的目录：

```sh
export CODEATELIER_SANDBOX_READ_ROOTS='["/opt/example-toolchain"]'
export CODEATELIER_SANDBOX_WRITE_ROOTS='["/home/example/build-cache"]'
CODEATELIER_SANDBOX_ENABLED=true pnpm start
```

普通文件工具仍有自己的路径校验；额外 OS 根不自动扩大文件工具契约。需要越界操作时使用既有 Broker 审批，不绕过失败命令重新执行。

## IPC、取消与恢复

`RuntimeIpcTransport` 统一 Readable/Writable 字节流；POSIX 使用启动器持有的私有 stdio，Windows 仍用经 Supervisor 验证的 Named Pipe。启动 nonce/identity 只通过首帧交付，不进入命令、环境或工作区。统一接口不统一 OS 身份证明；MXC 报告的宿主 PID 标为 `runtime-launcher`，不伪称已验证的 namespace 内 Runtime PID。

任务没有总运行期限；启动等待、IPC 握手和退出清理仍有各自期限。SDK spawn 不可直接取消，超时后保留标记并接管迟到 handle，不重放 spawn。正常结束/用户取消必须确认协议终态及清理；服务关闭在清理成功后保存 interrupted，用户取消保存 cancelled，清理未知优先 unknown/failed。

启动前在 Broker 数据目录 `mxc/active` 写入并 flush 持久标记，结束确认后删除。启动失败可能已产生原生副作用、EOF/结果未知、清理失败时保留标记，隔离本启动器并排空其活动实例。新服务遇到旧标记时拒绝新 Sandbox 任务；不按旧 PID 猜测杀进程，也不自动删除标记或重放命令。

人工恢复前停止服务，核对标记对应的实例、工作区副作用及进程树确已停止，再备份并移走相关标记与其私有临时目录，最后重启。**不能仅删除 JSON 来绕过未知状态**；没有自动化的 POSIX 恢复/清理命令。普通的、已确认清理完成的关闭不需要人工清标记，会话沿用既有恢复入口。

日志及 trace 提供 `sandbox.mxc.preflight/launch/cleanup`、关联 task/instance、耗时与终态；Broker 另保存实际执行模式。新增 span 不记录源码、nonce、环境、stderr 或工具正文。SDK 原始诊断可能带命令，故不会直接写入新增生命周期属性。

## 验证与复现

默认离线回归 `tests/mxc-runtime.test.ts` 验证策略、文件摘要、私有首帧、启动残留、取消、超时迟到句柄、清理失败与不 fallback；`tests/agent-runtime-engine.test.ts` 验证关闭 interrupted 和 unknown 优先级。假 SDK 测试不是 macOS 实机证据。

手动 Linux 产品探针使用真实工厂、Engine、SQLite/Store Worker、MXC 与固定 Runtime，只有模型是确定性夹具。请在 Linux 原生文件系统的独立源码副本执行；不加载 `.env`，不使用真实模型或用户数据库，不属于 Evaluation：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm sandbox:posix:build
mkdir -p .local/mxc-product
MXC_PRODUCT_REPORT="$PWD/.local/mxc-product/report.json" \
  timeout --kill-after=10s 120s node --import tsx \
  experiments/mxc-linux-probe/product-probe.mjs
```

120 秒仅是手动探针保护，不是产品工具期限。探针逐阶段输出 START/PASS/FAIL，阶段开始、结束及清理前落盘报告，随机夹具与 SQLite 留在报告同目录。异常终止后先检查进程、报告和 `mxc/active`，不得自动重跑同一任务。涵盖等待循环回归、四工作区并发读写/命令及环境/网络边界、普通和 detached 心跳取消、关闭/重开 Store 后人工恢复、持久化上下文续聊。实际结果及未覆盖范围见 [验证记录](verification.md)。
