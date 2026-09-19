# Windows 网络与 Broker IPC 最小验证

该实验把两个安全问题分开验证：

1. `--ipc` 验证 Broker 能否通过任务专属 Named Pipe 取得真实客户端 PID，并联合核对进程创建时间、restricted token、execution SID、映像和 Job。夹具随后让同用户、同映像、知道相同 nonce 但不属于目标 Job 的进程连接，Broker 必须拒绝。
2. `--wfp` 验证 WFP 内建 `FWPM_CONDITION_ALE_APP_ID` filter 的实际粒度。动态 filter 阻止探针映像连接本机回环 listener；目标实例和同映像兄弟实例都应被阻止，而复制到新路径的同一程序仍可连接。

运行 IPC 探针：

```powershell
pwsh -File experiments/windows-network-ipc-demo/run-demo.ps1 -Mode ipc
```

运行 WFP 探针需要向 Base Filtering Engine 添加 filter 的管理权限，必须从提升的 PowerShell 单独执行：

```powershell
pwsh -File experiments/windows-network-ipc-demo/run-demo.ps1 -Mode wfp
```

WFP 探针不访问互联网，只连接临时回环端口。filter 属于 dynamic WFP session，进程正常退出、异常退出或 engine handle 关闭时都由 BFE 自动删除；程序不创建持久 provider、sublayer 或 firewall rule。

## 结论边界

- IPC 通过只能证明 Broker 可以认证一次已连接的客户端，并据此决定是否执行 typed capability。它不能阻止 Runtime 直接创建网络 socket，也不能替代 WFP。
- WFP 通过会证明 `ALE_APP_ID` 是映像路径级而不是 execution instance 级：同路径的所有实例同时命中，复制/其它子进程映像不命中。这是内建 user-mode filter 不足以绑定任意 Runtime 进程树的反例，不是目标网络 Sandbox 已实现。
- 产品仍需一个能在 ALE 层把 PID 元数据重新证明为本次 process handle、创建时间、execution SID 与 Job 后代的机制。最直接的候选是自有 WFP callout driver；若不接受驱动成本，则必须更换为 Windows 能原生匹配的隔离身份，或取消“无命令网络”的安全声明。
- IPC 探针沿用 restricted-token 文件 demo 已发现的 logon/Everyone 启动兼容组合。该组合尚未完成最小化，探针也不验证 malformed frame、重放、配额、Broker 重启和 PID reuse。

对应平台依据：[ALE 的应用/用户身份粒度](https://learn.microsoft.com/en-us/windows/win32/fwp/application-layer-enforcement--ale-)；[各过滤层可用条件](https://learn.microsoft.com/en-us/windows/win32/fwp/filtering-conditions-available-at-each-filtering-layer)；[callout 可见的进程 metadata](https://learn.microsoft.com/en-us/windows/win32/api/fwpsu/ns-fwpsu-fwps_incoming_metadata_values0)。
