# Windows 网络与 Broker IPC 最小验证

状态：IPC 结论仍是当前目标的局部依据；`ALE_APP_ID` 粒度结论则用于否定按映像/实例放行。D099 已选择单一专用账户 SID 作为稳定的 WFP 隔离身份，任务级授权留在认证代理，不再要求自研 callout driver。本实验现增加临时专用账户的动态 `ALE_USER_ID` fence；它用于验证身份与规则组合，不代表产品持久安装已经完成。

该实验把两个安全问题分开验证：

1. `--ipc` 验证 Broker 能否通过任务专属 Named Pipe 取得真实客户端 PID，并联合核对进程创建时间、restricted token、execution SID、映像和 Job。夹具随后让同用户、同映像、知道相同 nonce 但不属于目标 Job 的进程连接，Broker 必须拒绝。
2. `--wfp` 验证 WFP 内建 `FWPM_CONDITION_ALE_APP_ID` filter 的实际粒度。动态 filter 阻止探针映像连接本机回环 listener；目标实例和同映像兄弟实例都应被阻止，而复制到新路径的同一程序仍可连接。
3. `wfp-user` 编排器创建随机临时低权限账户，以 `FWPM_CONDITION_ALE_USER_ID` 安装动态 V4 规则：该账户只允许连接 controller 的一个回环端口，连接第二个回环端口必须被阻止；宿主用户连接第二个端口必须不受影响。账户密码只留在 PowerShell 内存，账户、目录和动态 WFP session 在 `finally` 中清理。

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

预期最终输出 `WFP_USER_DEMO PASS`，其中 `hostUnaffected=yes`、`allowedLoopbackPort=yes`、`otherLoopbackPortBlocked=yes` 和 `dynamicCleanup=yes`。该模式使用 `FWP_ACTRL_MATCH_FILTER` 构造 self-relative user security descriptor，遵循 Microsoft 的 user filter 示例。

## 结论边界

- IPC 通过只能证明 Broker 可以认证一次已连接的客户端，并据此决定是否执行 typed capability。它不能阻止 Runtime 直接创建网络 socket，也不能替代 WFP。
- WFP 通过会证明 `ALE_APP_ID` 是映像路径级而不是 execution instance 级：同路径的所有实例同时命中，复制/其它子进程映像不命中。这是内建 user-mode filter 不足以绑定任意 Runtime 进程树的反例，不是目标网络 Sandbox 已实现。
- `wfp-user` 通过只证明动态 V4 `ALE_AUTH_CONNECT` 下，账户身份条件和“一个端口 permit + 其它连接 block”的组合可行，且宿主用户不命中。它不覆盖 IPv6、UDP、DNS、非回环地址、bind/listen、raw socket、restricted token 后代、持久 provider/sublayer、规则篡改、BFE/机器重启或卸载残留。
- 产品采用 Windows 可原生匹配的专用账户 SID：WFP 对该 SID 永久拒绝直接出站，只允许固定 Broker relay/proxy 端口；代理再用账户 SID、PID、创建时间、Job、execution instance、nonce 和 lease 判定本次连接可用的 host/ref。这样不需要在 ALE 层识别每个任务实例，也不需要自研 callout driver。仍须在提升环境实测完整 V4/V6、协议、持久规则生命周期、服务重启和绕过路径，验证失败前不得声明“无命令网络”。
- IPC 探针沿用 restricted-token 文件 demo 已发现的 logon/Everyone 启动兼容组合。该组合尚未完成最小化，探针也不验证 malformed frame、重放、配额、Broker 重启和 PID reuse。

对应平台依据：[ALE 的应用/用户身份粒度](https://learn.microsoft.com/en-us/windows/win32/fwp/application-layer-enforcement--ale-)；[允许和阻止应用与用户示例](https://learn.microsoft.com/en-us/windows/win32/fwp/permitting-and-blocking-applications-and-users)；[各过滤层可用条件](https://learn.microsoft.com/en-us/windows/win32/fwp/filtering-conditions-available-at-each-filtering-layer)；[callout 可见的进程 metadata](https://learn.microsoft.com/en-us/windows/win32/api/fwpsu/ns-fwpsu-fwps_incoming_metadata_values0)。
