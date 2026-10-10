# MXC Linux / WSL 手动验证

状态：2026-10-10 已完成本机 WSL2 的独立 SDK 验证；**不是 CodeAtelier Linux Sandbox 产品集成或全平台安全验收**。Windows 后端、主项目依赖和运行配置未改动。

## 环境与结果

| 项目                   | 实际值                                                              |
| ---------------------- | ------------------------------------------------------------------- |
| 发行版 / 身份          | Ubuntu 26.04 LTS，非 root UID 1000                                  |
| 内核 / 架构            | `6.18.33.2-microsoft-standard-WSL2` / x86_64                        |
| Node / pnpm            | `24.19.0` / `12.8.1`                                                |
| MXC                    | npm `@microsoft/mxc-sdk@1.0.0`，未修改 SDK                          |
| 原生依赖               | Bubblewrap `0.11.1`；非特权 user namespace 探测成功                 |
| 安装方式               | 独立 Linux 用户目录；pnpm 禁用安装脚本，不安装系统包、不修改 sysctl |
| Linux ext4             | 最终 **13/13 通过**；此前 12 项版本另有三次通过                     |
| G 盘挂载（9p / DrvFS） | 最终 **12/13 通过**；原地 UNIX socket 宿主正对照失败，保留非零退出  |

已安装 `bin/x64/libmxc_ffi.so` 的 SHA-256：

```text
77acb08fbb6e2fbe8d3366ef1fb836f5276f16d682aa481ac1f2fc710f8db4df
```

`pnpm-lock.yaml` 固定本次实际依赖图，包括 Koffi 3.3.2、node-pty 1.1.0、semver 7.8.5。它是 pnpm 12 生成的多文档锁文件，不手工改写；已验证 `--frozen-lockfile --offline --ignore-scripts` 可复用现有 store。node-pty 安装脚本没有执行，**没有验证 PTY**。

### 覆盖矩阵

| 用例                            | ext4         | DrvFS            | 证据边界                                                                                                                |
| ------------------------------- | ------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| SDK discovery                   | 通过         | 通过             | 可用后端包含 Bubblewrap；网络代理缺 slirp4netns，不启用                                                                 |
| 文件 / 环境 / symlink           | 通过         | 通过             | 显式只读根拒写、未授权根拒绝、symlink 不越界、宿主假密钥环境不继承、工作区/HOME/temp 可写                               |
| 无沙箱负对照                    | 通过         | 通过             | 同一只读写断言在普通宿主进程下失败，避免假阳性                                                                          |
| Node Worker / 子进程            | 通过         | 通过             | 原生 Node Worker 和 Node 子进程，不代表所有构建工具可用                                                                 |
| 双向 stdio                      | 通过         | 通过             | 进程存活时两轮交互，独立 stderr，关闭 stdin 后正常退出                                                                  |
| 网络 namespace                  | 通过         | 通过             | 宿主 IPv4/IPv6 回环 listener 正对照成功、沙箱不可达；公网 IPv4 TCP 正对照成功而沙箱 ENETUNREACH；沙箱自身 loopback 可用 |
| 四工作区并行                    | 通过         | 通过             | 各自写入成功、其它三个预先存在的 workspace marker 不可读写；不承诺所有进程/对象互相隔离                                 |
| kill / timeout                  | 通过         | 通过             | 实际 parent + detached 后代先存活；结束后 /proc 无被标记活进程、心跳停止                                                |
| 控制进程 SIGKILL                | 通过         | 通过             | SDK 宿主被强制退出后，工作负载及 detached 后代停止；不是完整 Broker 恢复验收                                            |
| 硬链接边界特征                  | 已确认       | 已确认           | 授权目录内的既有硬链接可读取同 inode 内容，并非“文件来源隔离”                                                           |
| 可写目录内 UNIX socket 边界特征 | 已确认可连接 | **宿主 ENOTSUP** | DrvFS 连宿主 listener 都无法建立，尚未进入 MXC；不冒称 MXC 拒绝连接                                                     |
| 独立 Linux 临时目录 UNIX socket | 通过         | 通过             | 即使工作区在 DrvFS，单独授权 ext4 临时目录后仍可通信                                                                    |

报告的 `characterize-*` 通过表示边界行为被证实，**不表示禁止硬链接或 UNIX socket 访问的安全要求通过**。网络测试不覆盖 UDP、DNS/DoH、外部 IPv6、代理或开放网络模式。公网正对照不可达时报告 `externalVerified=false`，不得将它解释为已证明公网阻断。

## 关键发现

1. **先取得 stdin 再调用 `wait()`。** MXC 1.0.0 的 `MxcProcess.wait()` 会结束尚未被调用方取得的输入流。初版夹具先 wait 后取 stdin，造成两轮交互失败；按已安装 SDK 的所有权契约修正后通过。没有修改 SDK，也没有删除交互断言。
2. **`deniedPaths` 目录是遮蔽，不是所有写操作都报错。** 初版夹具要求其中创建文件也必须抛错，实际目录被空 tmpfs 遮蔽，影子写入可成功。最终同时断言原内容不可读、影子写入可读回，且宿主原始见证文件仍逐字节不变。目录内容不泄漏不等于路径完全不可写。
3. **断网不封锁授权路径内的 UNIX socket。** ext4 上实测可以连接宿主自建 socket，因此不能把 Docker/ssh-agent 等敏感 socket 所在目录广泛授权。
4. **硬链接不携带来源约束。** 将假私有文件的既有硬链接放入授权目录后，读取成功；策略只能按实际可见目录对象提供能力。
5. **WSL 的 DrvFS 不是 ext4。** 本机 G 盘挂载的 UNIX socket 在宿主 `listen()` 阶段报 ENOTSUP；保留失败用例。后续集成应优先用 Linux 原生目录存放 Runtime、依赖、HOME、temp 和 IPC；工作区可另行挂载。独立 ext4 temp 的对照已经通过。
6. **discovery 是 advisory。** 最早一次 smoke 中 `getPlatformSupport()` 报 bwrap 版本探测 5 秒超时，但随后显式 Bubblewrap spawn 成功。后续多次新进程矩阵未复现；原因未确定，不声称已修复，也不删除这次观察。产品 preflight 仍需真实最小启动与结构化失败处理，不能静默退回宿主。

首次 /tmp 准备目录在后续 WSL 调用时消失，具体原因未定位；正式验证改在 home 下独立 ext4 目录，不依赖 /tmp 跨调用持久性。

## 文件与复现

- `package.json`：独立实验依赖与手动入口，不加入根 workspace 或默认测试。
- `pnpm-lock.yaml`：实际解析的固定依赖图。
- `prepare.py`：非 root Linux x86_64 下载器；校验 Node 官方 SHA-256 与 pnpm 官方包 SHA-512，安全解包并复制实验文件。不会安装依赖或执行下载包。
- `probe.mjs`：宿主夹具，固定策略、正负对照、进程观察、有界输出与报告。
- `workload.mjs`：沙箱内的固定动作，不接受模型命令，不读取真实用户凭据。
- `controller.mjs`：可强制终止的 SDK 宿主，验证非正常退出而非仅正常 dispose。

需要 Python 3.12+、非 root Linux x86_64、已有可用的 bwrap 与 user namespace。以下在 WSL Linux 终端手动执行，仓库挂载路径按实际位置调整。准备阶段需要访问 Node 官方下载站与 npm registry；不要在 root 项目目录安装这套独立依赖。

```sh
ROOT="$HOME/codeatelier-mxc-probe-unique"
python3 /mnt/g/codeagent/experiments/mxc-linux-probe/prepare.py "$ROOT"

# 清空继承环境，隔离包管理器 HOME/cache/store，不执行依赖安装脚本。
env -i HOME="$ROOT/home" \
  XDG_CACHE_HOME="$ROOT/cache" XDG_DATA_HOME="$ROOT/data" \
  PATH="$ROOT/node-v24.19.0-linux-x64/bin:/usr/bin:/bin" \
  npm_config_userconfig=/dev/null \
  "$ROOT/node-v24.19.0-linux-x64/bin/node" \
  "$ROOT/pnpm/package/bin/pnpm.mjs" --dir "$ROOT/app" \
  install --frozen-lockfile --ignore-scripts --store-dir "$ROOT/store" \
  --registry=https://registry.npmjs.org

# 默认夹具在 app/runs 下，app 应放在 Linux 文件系统。
env -i HOME="$ROOT/home" \
  PATH="$ROOT/node-v24.19.0-linux-x64/bin:/usr/bin:/bin" \
  "$ROOT/node-v24.19.0-linux-x64/bin/node" "$ROOT/app/probe.mjs"

# 可选：对照 Windows 挂载目录；本机已知 UNIX socket 正对照会失败。
env -i HOME="$ROOT/home" \
  PATH="$ROOT/node-v24.19.0-linux-x64/bin:/usr/bin:/bin" \
  MXC_PROBE_BASE=/mnt/g/codeagent/.local/mxc-linux-probe-results/drvfs \
  "$ROOT/node-v24.19.0-linux-x64/bin/node" "$ROOT/app/probe.mjs"
```

准备目录必须不存在；中途失败先检查结果，不覆盖复用未知目录。`probe.mjs` 每次创建新的随机夹具目录；返回 0 代表全部用例通过，非 0 要检查报告，**不要为了取得绿色结果删除 DrvFS 失败项**。

脚本仅测试自己的虚构数据、回环 listener 和少量带随机标记的进程；公网只建立 `1.1.1.1:443` TCP 连接，不发送应用数据。每次输出纯文本进度并写 `report.json`，结束后保留文件证据；不会自动删除未知工作目录。15/20 秒等期限仅属于有界实验夹具，不改变产品长工具无总时限的约定。

## 本次记录与剩余工作

原始日志和报告保存在忽略目录 `.local/mxc-linux-probe-results/`，包括 `probe-first.log`、`run-BypxtW.json`、`probe-corrected.log`、`ext4-repeat-{1,2}.{log,json}`、`drvfs.{log,json}`、`final-{ext4,drvfs}.{log,json}`。最终再次只读检查没有 workload/controller 夹具进程残留。

独立脚本的 Node 语法检查、ESLint、Python compile 通过。根 `pnpm check` 的类型/lint/格式通过，但默认并发普通测试 6 项失败（663 通过、1 跳过）；随后显式 `pnpm test --maxWorkers=4` 全部 94 个文件、669 项通过、1 跳过，`pnpm build:test` 通过。没有调整默认并发、超时或断言；不能将限并发复核写成原样 check 全绿。详见 [项目验证记录](../../docs/verification.md)。

本实验没有接入真实 AgentRuntimeService、Broker IPC、模型、会话恢复、UI、Git/MCP 宿主归因或产品 tracing；不运行 Evaluation。独立夹具报告含逐项耗时/失败及版本摘要，是产品 tracing 的明确实验性例外；后续运行时集成必须另行接入 `src/tracing`。

尚未验证：原生 Linux 其它发行版/架构、Node 26、macOS、完整 pnpm/语言构建工具链、PTY、CPU/内存/进程数/磁盘限额、恶意竞态/挂载别名、内核攻击、完整恢复及长期压力。结论仅支持继续开发独立 Linux 后端原型，不自动改变现有平台支持或 Sandbox 能力声明。
