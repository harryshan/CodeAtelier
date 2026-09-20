# Windows 网络与 Broker IPC 最小验证

状态：IPC 结论仍是当前目标的局部依据；`ALE_APP_ID` 粒度结论则用于否定按映像/实例放行。D099 已选择单一专用账户 SID 作为稳定的 WFP 隔离身份，任务级授权留在认证代理，不再要求自研 callout driver。本实验现增加临时专用账户的动态 `ALE_USER_ID` fence；它用于验证身份与规则组合，不代表产品持久安装已经完成。

该实验把两个安全问题分开验证：

1. `--ipc` 验证 Broker 能否通过任务专属 Named Pipe 取得真实客户端 PID，并联合核对进程创建时间、restricted token、execution SID、映像和 Job。夹具随后让同用户、同映像、知道相同 nonce 但不属于目标 Job 的进程连接，Broker 必须拒绝。
2. `--wfp` 验证 WFP 内建 `FWPM_CONDITION_ALE_APP_ID` filter 的实际粒度。动态 filter 阻止探针映像连接本机回环 listener；目标实例和同映像兄弟实例都应被阻止，而复制到新路径的同一程序仍可连接。
3. `wfp-user` 编排器创建随机临时低权限账户，以 `FWPM_CONDITION_ALE_USER_ID` 在 V4/V6 `ALE_AUTH_CONNECT` 层安装“loopback 地址 + relay 端口”allow 与其余 connect block，在 `ALE_AUTH_LISTEN` 阻止 listen，并在 `ALE_RESOURCE_ASSIGNMENT` 只阻止 raw endpoint。矩阵覆盖 TCP、带 controller ACK 的 UDP 回环交付、本机真实可达非回环 IPv4 listener、listen/raw，以及普通账户进程和 restricted Runtime 的网络后代；宿主用户的 connect/listen 必须不受影响。controller 正常关闭和被强制终止后，编排器都要求同一账户重新连接成功，以实证 dynamic session 规则已撤销。账户密码只留在 PowerShell 内存，账户和目录在 `finally` 中清理。
4. `wfp-persistent` 使用专用测试 provider/sublayer GUID，在一个 WFP 事务中安装 8 条 persistent filters。安装进程退出后，新进程枚举并严格检查 provider、sublayer、filter 数量、persistent flags 和关联 GUID，再运行 V4/V6 connect、listen/raw fence。卸载后自检必须失败、原被拒端口必须恢复连接；`finally` 始终再次按已知 GUID 清理机器策略、账户和目录。

运行 IPC 探针：

```powershell
pwsh -File experiments/windows-network-ipc-demo/run-demo.ps1 -Mode ipc
```

运行 WFP 探针需要向 Base Filtering Engine 添加 filter 的管理权限，必须从提升的 PowerShell 单独执行：

```powershell
pwsh -File experiments/windows-network-ipc-demo/run-demo.ps1 -Mode wfp
```

WFP 探针不访问互联网，只连接临时回环端口。filter 属于 dynamic WFP session，进程正常退出、异常退出或 engine handle 关闭时都由 BFE 自动删除；程序不创建持久 provider、sublayer 或 firewall rule。

构建并运行专用账户 WFP 探针：

```powershell
pwsh -File experiments/windows-network-ipc-demo/run-demo.ps1 -Mode build
# 以下命令必须在“以管理员身份运行”的 PowerShell 中执行
pwsh -File experiments/windows-network-ipc-demo/run-demo.ps1 -Mode wfp-user
```

预期最终输出 `WFP_USER_DEMO PASS`，其中 `hostUnaffected=yes`、`ipv4=yes`、`ipv6=yes`、`tcp=yes`、`udpDelivery=yes`、`nonLoopbackTcp=yes`、`listenBlocked=yes`、`rawDenied=yes`、`restrictedDescendant=yes`、`dynamicCleanupVerified=yes` 和 `crashCleanupVerified=yes`。该模式使用 `FWP_ACTRL_MATCH_FILTER` 构造 self-relative user security descriptor，遵循 Microsoft 的 user filter 示例。

持久生命周期探针也必须从提升的 PowerShell 单独运行：

```powershell
pwsh -File experiments/windows-network-ipc-demo/run-demo.ps1 -Mode wfp-persistent
```

预期最终输出 `WFP_PERSISTENT_DEMO PASS`，包含 `processExitPersistence=yes`、`enumerateSelfCheck=yes`、`tcpFence=yes`、`listenRawFence=yes` 和 `uninstallRecovery=yes`。该入口会短暂写入机器级持久 WFP policy；只应在可恢复的测试机上执行，运行前后都按固定测试 GUID 清理。

## 结论边界

- IPC 通过只能证明 Broker 可以认证一次已连接的客户端，并据此决定是否执行 typed capability。它不能阻止 Runtime 直接创建网络 socket，也不能替代 WFP。
- WFP 通过会证明 `ALE_APP_ID` 是映像路径级而不是 execution instance 级：同路径的所有实例同时命中，复制/其它子进程映像不命中。这是内建 user-mode filter 不足以绑定任意 Runtime 进程树的反例，不是目标网络 Sandbox 已实现。
- `wfp-user` 通过只证明动态 V4/V6 ALE 层下，上述账户身份和规则组合能覆盖被测 TCP connect、UDP 回环实际交付、TCP listen、raw endpoint bind 及 restricted Runtime 的直接网络后代，并证明 controller 正常关闭或被强制终止后同一账户恢复连接。UDP 的 `sendto()` 成功不视为放行：获准端口必须收到 controller ACK，拒绝端口必须无法收到；raw socket 创建成功也不视为放行，必须继续验证 bind。它不覆盖真实 DNS resolver/DoH、非回环 UDP 交付、UDP 入站、ICMP 数据交付、组播/广播、其它 socket API、更深或逃逸后代、持久 provider/sublayer、规则篡改、BFE/机器重启或卸载残留。
- `wfp-persistent` 通过后只覆盖安装进程退出后的持久性、对象枚举自检、核心 TCP/listen/raw 行为和正常卸载恢复；尚不覆盖 BFE/机器重启、规则篡改修复、重复安装、版本升级、安装事务故障注入、账户先删除、断电或卸载中断。
- 产品采用 Windows 可原生匹配的专用账户 SID：WFP 对该 SID 永久拒绝直接出站，只允许固定 Broker relay/proxy 端口；代理再用账户 SID、PID、创建时间、Job、execution instance、nonce 和 lease 判定本次连接可用的 host/ref。这样不需要在 ALE 层识别每个任务实例，也不需要自研 callout driver。仍须在提升环境实测完整 V4/V6、协议、持久规则生命周期、服务重启和绕过路径，验证失败前不得声明“无命令网络”。
- IPC 探针沿用 restricted-token 文件 demo 已发现的 logon/Everyone 启动兼容组合。该组合尚未完成最小化，探针也不验证 malformed frame、重放、配额、Broker 重启和 PID reuse。

对应平台依据：[ALE 的应用/用户身份粒度](https://learn.microsoft.com/en-us/windows/win32/fwp/application-layer-enforcement--ale-)；[允许和阻止应用与用户示例](https://learn.microsoft.com/en-us/windows/win32/fwp/permitting-and-blocking-applications-and-users)；[各过滤层可用条件](https://learn.microsoft.com/en-us/windows/win32/fwp/filtering-conditions-available-at-each-filtering-layer)；[callout 可见的进程 metadata](https://learn.microsoft.com/en-us/windows/win32/api/fwpsu/ns-fwpsu-fwps_incoming_metadata_values0)。
