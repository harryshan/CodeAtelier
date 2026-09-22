# Windows Restricted-Token 最小验证

状态：D099 已将产品文件身份改为单一专用低权限账户和显式 ACL。本实验不再验证目标文件边界；它只保留为 restricted token、Job 与后代继承的局部可行性证据。输出必须继续区分 Codex 外层 Sandbox/Job 的影响。

该实验用真实 Windows API 验证目标设计最核心、也最容易先证伪的组合：

- `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED)`，限制 SID 同时包含每实例 execution SID、写根 capability、当前 logon SID 和 Everyone SID；
- 一个临时可写根的独立 capability SID 与继承 ACE；
- 含上述 SID 的 token default DACL，以及唯一重新启用的 `SeChangeNotifyPrivilege`；
- 当前用户可读但未授权写入的兄弟目录；
- suspended 创建、Job Object 绑定后恢复执行；
- restricted 子进程再创建后代，确认限制随 token 继承。

运行：

```powershell
pwsh -File experiments/windows-restricted-token-demo/run-demo.ps1
```

脚本使用本机 MSVC，构建产物和运行时目录位于已忽略的 `.local/windows-restricted-token-demo/`。每次运行创建两个同属当前用户的临时目录：探针必须读取外部目录中的现有文件及 `C:\Windows\win.ini`，修改安装根 ACE 前已经存在的文件，并由直接进程和后代在获准目录创建文件；它们在外部目录的创建都必须返回 `ERROR_ACCESS_DENIED`。

临时目录最终整体删除，不给真实工作区或用户目录安装 ACE。

输出中的 `CONTEXT launcher-parent` 描述调用环境，`restricted-probe` 和 `nested-probe` 描述目标进程。比较普通 Codex 工具运行与批准的宿主权限运行时，重点核对 `restricted`、`appContainer`、`integrity` 和 `inJob`，避免把 Codex 自身 Sandbox/Job 的额外限制算成该设计的能力。

批准运行只保证解除本轮文件/token Sandbox；如果输出仍是 `inJob=yes`，说明进程仍受 Codex 宿主的外层 Job 影响，不能据此验证完全独立的 Job 行为。

## 不能证明的内容

这是可丢弃的 feasibility demo，不是产品 supervisor。通过只说明这台 Windows 上的正常 DACL 临时目录满足“当前用户读取兼容、capability 根可写、普通兄弟目录不可写”，并证明一个普通后代继承限制。它没有验证：

- null/弱 DACL、deny ACE、继承关闭、已有复杂子树、reparse point、hard link、UNC、其它卷或原对象恢复；
- COM、RPC、窗口消息、计划任务、服务、现存宿主进程代写或全部 Job 逃逸；
- 私有 desktop、process mitigation、Broker IPC、租约、取消、资源上限与重启对账；
- WFP 默认拒绝、Push Runner、relay、CONNECT host 边界或凭据；
- Git/Node/PowerShell/编译器的真实兼容矩阵。

探针为兼容启动使用 execution、root capability、logon、Everyone 四个 restricting SID；管理员专用账户实测证明不同显式凭据启动可能复用 logon SID，因此 default DACL 已收紧为共享账户 SID 与本实例 execution SID，不再向 logon/Everyone 授予新对象通用权限。

它仍没有逐项证明 logon/Everyone restricting SID 对所有工具都不可省略，也没有证明 default DACL 对全部 Win32 对象的继承语义；产品控制管道和 supervisor 对象仍须使用显式私有 DACL 与客户端身份验证。

因此它不能把 W1 或 W2 标记为完成，也不能支持专用账户安装、并发 instance lease、显式读写 ACL 或网络边界的产品声明。D100 已明确同 SID 对话之间不要求进程对象隔离；并发入口只观察相关 open 结果，用于记录残余干扰风险。
