# Windows 专用 Sandbox 用户最小验证

状态：这是 D099 单一专用低权限账户设计的第一阶段手动 feasibility probe，不是产品 supervisor，也不进入默认测试。

它在真实 Windows 本地账户和 DACL 上验证以下窄组合：

- 创建一个随机、可丢弃的本地低权限账户，并加入内建 `Users` 组；
- 用同一账户启动两个独立登录会话，核对用户 SID 相同而 logon SID 不同；
- 两个工作区都向账户授予普通 `Modify`，但分别只向 capability A/B 授权；
- 固定 bootstrap 从专用账户 token 创建 `WRITE_RESTRICTED` primary token，随后才启动待测 Runtime；
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

`CONTEXT launcher-parent` 必须显示专用账户 SID、每次不同的 logon SID 和未限制的固定 bootstrap；`restricted-probe` 与 `nested-probe` 必须显示 restricted token。最终 `DEMO PASS` 只表示上述文件访问矩阵成立。

构建结果不受管理员权限影响。运行阶段不能在普通 Codex 命令 Sandbox 中冒充成功：脚本首先检查管理员 token，真实创建账户还会触发 Windows 自身权限检查。即便经 Codex 宿主批准运行，若进程仍处于外层 Job，Job 相关输出仍只能说明嵌套环境下可运行，不能算作独立 supervisor/Job 的完整证据。

## 尚未证明

该探针按顺序启动两个实例，只证明不同 logon SID 与写 capability 的访问矩阵，不证明 1～4 个实例真正并发、同工作区排队或共享 ACE 引用计数。它也不覆盖：

- 同账户实例间 process/thread/token handle、debug、窗口消息、命名对象和 desktop 隔离；
- 复杂继承、deny/弱 DACL、reparse point、hard link、UNC、其它卷、路径替换及原对象撤销；
- 持久账户安装、secret 保存、本地登录策略、profile/environment 最小化、升级/卸载和 orphaned generation；
- Broker IPC、模型/session capability、WFP、直接 socket、relay/CONNECT、凭据或 Git push；
- Node、PowerShell、Git、编译器和真实仓库配置兼容矩阵；
- 取消、资源上限、服务重启对账及产品 tracing。

此外，bootstrap 当前沿用旧探针为启动兼容加入的 logon SID 和 Everyone restricting SID/default DACL。通过本实验不能证明这些宽泛 SID 对所有工具都安全；W2 仍必须用弱 ACL、私有对象和同 SID 攻击夹具证明 root capability 没有被绕过，否则实现应失败关闭。
