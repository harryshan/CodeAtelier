# Windows 专用 Sandbox 用户最小验证

状态：这是 D099 单一专用低权限账户设计的第一阶段手动 feasibility probe，不是产品 supervisor，也不进入默认测试。

它在真实 Windows 本地账户和 DACL 上验证以下窄组合：

- 创建一个随机、可丢弃的本地低权限账户，并加入内建 `Users` 组；
- 用同一账户并发启动两个 execution instance，核对用户 SID 相同并记录 Windows 是否复用 logon SID；
- 每个实例使用独立 execution SID，每个工作区另使用独立 root capability SID；
- 两个工作区都向账户授予普通 `Modify`，但分别只向自己的 root capability 授权；
- 固定 bootstrap 从专用账户 token 创建 `WRITE_RESTRICTED` primary token，随后才启动待测 Runtime；
- bootstrap 从创建时即为 Runtime process/thread 和命名 Job 安装“共享账户 SID + 本实例 execution SID”的显式 DACL；
- 两个 Runtime 通过工作区文件屏障保持同时存活，并观察 peer 的 terminate/inject/duplicate-handle/改 DACL、thread terminate/suspend/set-context 和 Job terminate/assign open 结果；不同对话不要求对象隔离，因此允许或拒绝都如实记录但不实际执行攻击；
- instance A/B 可读取对方活动工作区，能由直接进程和后代写自己的根，但不能写对方根；
- capability ACE 由提升的编排端预置，专用账户 bootstrap 不修改 ACL。

构建不需要提升：

```powershell
pwsh -File experiments/windows-sandbox-user-demo/run-demo.ps1 -Mode build
```

真实账户与 ACL 验证必须从“以管理员身份运行”的 PowerShell 执行：

```powershell
pwsh -File experiments/windows-sandbox-user-demo/run-demo.ps1 -Mode run
```

脚本只在已忽略的 `.local/windows-sandbox-user-demo/` 下创建随机运行目录，账户名使用 `CAProbe` 加随机后缀。密码随机生成，只保存在脚本进程内存和 `SecureString` 中，不写入 argv、环境、文件或输出。`finally` 会验证清理目标仍位于该构建根，再删除运行目录和本次精确账户；即使探针失败也执行清理。若机器策略拒绝创建账户、登录或修改 ACL，脚本安全失败并报告步骤。

## 输出与外层 Codex Sandbox

`CONTEXT launcher-parent` 必须显示专用账户 SID、实际 logon SID 和未限制的固定 bootstrap；`INFO` 必须显示各自不同的 execution/root capability SID，`concurrent-restricted-probe` 与 `nested-probe` 必须显示 restricted token。双方还必须各自输出 peer process/thread/Job dangerous open 的 allowed/denied 观察值及 `concurrent-file-write-isolation peerObjectIsolation=not-required`。最终 `DEMO PASS` 会如实报告 `logonSidReused=true|false`；logon SID 是否复用不再决定通过，因为文件写入能力由 execution/root capability 承担。

构建结果不受管理员权限影响。运行阶段不能在普通 Codex 命令 Sandbox 中冒充成功：脚本首先检查管理员 token，真实创建账户还会触发 Windows 自身权限检查。即便经 Codex 宿主批准运行，若进程仍处于外层 Job，Job 相关输出仍只能说明嵌套环境下可运行，不能算作独立 supervisor/Job 的完整证据。

## 尚未证明

该探针当前扩展为两个实例真正并发。管理员实测中，peer 的 `OpenProcess(PROCESS_TERMINATE)`（access `1`）成功，旧探针以 45 失败；这证明 `WRITE_RESTRICTED` 的 root capability 可以约束文件写，却不能把共享账户的全部 process 权限变成实例私有。用户已确认不同对话无需互相隔离，因此修订探针把这类 dangerous open 改为只观察、不执行且不参与通过判定；真正的并发通过条件是双方同时存活时仍能各自直接/后代写自己的根、不能写对方根。它也不覆盖：

- peer 可取得的 handle/token/debug/窗口消息/普通命名对象/desktop 权限范围，以及 Broker/supervisor 控制面能否抵抗 Sandbox Runtime；
- 复杂继承、deny/弱 DACL、reparse point、hard link、UNC、其它卷、路径替换及原对象撤销；
- 持久账户安装、secret 保存、本地登录策略、profile/environment 最小化、升级/卸载和 orphaned generation；
- Broker IPC、模型/session capability、WFP、直接 socket、relay/CONNECT、凭据或 Git push；
- Node、PowerShell、Git、编译器和真实仓库配置兼容矩阵；
- 取消、资源上限、服务重启对账及产品 tracing。

2026-09-20 的首次管理员运行证明两次显式凭据启动复用了同一个 logon SID `S-1-5-5-0-488199`，因此推翻了“每实例 logon SID 唯一”的假设。该次运行在最终身份断言前已经通过双方跨根读取、各自根直接/后代写入、跨根写拒绝，并成功清理账户和目录。修订后的探针改用独立 execution SID；token restricting SID 为 execution、root capability、logon 和 Everyone，但 default DACL 已收紧为共享账户 SID 加本实例 execution SID，不再给共享 logon/Everyone 新对象通用权限。第二次管理员运行最终报告 `distinctExecutionSids=yes logonSidReused=true crossRead=yes ownWrite=yes crossWriteDenied=yes nestedProcess=yes`，且复测后没有残留临时账户或运行目录。

按 D100 新契约的第三次管理员运行让两个 Runtime 真正同时存活。双方均观察到 `OpenProcess(PROCESS_TERMINATE)` allowed，而 process 注入/duplicate/DACL、thread dangerous access 和 Job dangerous access denied；随后双方都通过跨根读取、自己的 direct/nested 写入和对方根 direct/nested 写拒绝。最终报告 `concurrent=yes peerObjectIsolation=not-required crossRead=yes ownWrite=yes crossWriteDenied=yes nestedProcess=yes`，只读复核确认 `CAProbe*` 账户和 `run-*` 目录均为 0。

logon 和 Everyone 仍暂时作为未修改 Win32 启动的兼容 restricting SID。通过本实验不能证明它们对所有文件 ACL 都安全；W2 仍必须用弱/null DACL、公共写 ACE、复杂继承和重解析点夹具证明 execution/root capability 文件写边界没有被绕过，否则实现应失败关闭。同账户 process/thread/Job/desktop/命名对象不属于任务间安全边界，但 Broker/supervisor 控制面和 WFP fence 仍必须拒绝任何 Sandbox Runtime 绕过。
