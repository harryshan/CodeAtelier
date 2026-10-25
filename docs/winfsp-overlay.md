# Windows NTFS / WinFsp overlay 后端设计

状态：2026-10-25 用户已授权实现；本文是接入约束与验收设计，**尚未实现或开放该后端**。来源层的时间语义待用户确认，不能把本设计当作 D167 快照语义已经改变。

## 已确认范围与待确认项

在 Riftri 工作区模式下增加 Windows 原生 WinFsp overlay 后端，使 NTFS 不再依赖块级 reflink。使用 WinFsp 原生文件系统 API，覆盖 CodeAtelier 的 Git、文件工具、Sandbox ACL、并发、取消、历史续聊与服务重启。普通 Git worktree 和现有 Linux/macOS 原生 CoW 后端保持原行为。不创建 Windows 分区，不使用 WSL 承载 Windows 产品挂载。

以下两种来源层不能混称为相同功能，选择后再确定创建、持久化和恢复协议：

| 来源层 | 行为 | 与现有约定的关系 |
| --- | --- | --- |
| 原目录实时 lower | 尚未复制到 upper 的内容继续从原目录读取，原目录修改或删除可能改变会话所见内容 | 满足直接使用原目录，但必须显式修改 D167 固定创建时状态及来源删除后仍可恢复的约定 |
| VSS 快照 lower | 读取创建时的卷影快照，再向 upper 写入修改 | 可以提供稳定基线，但增加提升权限、卷影生命周期、磁盘配额及快照丢失处理；不是仅安装 WinFsp 即可获得 |

WinFsp 自身不提供原目录的时间快照；只在第一次写入时 copy-up 无法保存之前已经被其他进程覆盖或删除的 lower 内容。逐文件 stat、USN 记录和变化通知也不能还原旧字节。不能默默用全量复制或硬链接替代用户要求。

## 存储与权限原则

- lower 只读。所有内容写入、删除标记、重命名、属性与安全描述符修改都保存于私有存储。宿主 helper 绝不对 lower 执行 SetSecurityInfo 或可写打开。
- upper、删除标记、目录合并元数据与挂载清单由宿主管理；Runtime 只获得合并视图的路径。用户不能通过工作区路径直接篡改后端控制元数据。
- copy-up 必须先完整准备临时对象、持久化，再发布；失败不能暴露截断对象。删除与重命名跨多个元数据写入时需要可恢复事务，不凭目录当前外观猜测是否完成。
- Git metadata/index/refs 必须保持会话私有，不能指回来源写入。实时 lower 方案还需要明确如何固定 Git 元数据：不能因原项目切换分支、gc 或更新 index 而悄悄改变会话历史；不能将复制整个 `.git` 的成本隐去。
- 原生 API 的 GetSecurityByName/GetSecurity/SetSecurity 负责 Windows 安全描述符语义。不能把完整 ACL 简化为 POSIX mode，也不能靠 helper 的宿主权限替代调用者的访问检查。
- 需要验证 owner/group、允许与拒绝 ACE、继承/保护标记、restricted token 双重访问检查及权限变更后的持久性。SACL/审计操作必须遵循调用者权限，不能宣称普通宿主进程可以任意读写 SACL。
- 根 ACL 的继承变更应作用于合并视图中的相应子项，同时保留显式拒绝和受保护 DACL；不能因 Sandbox 授权根而复制所有文件内容，更不能回写来源 ACL。
- 重解析点、路径大小写、ADS、硬链接、文件锁、删除待决和映射文件逐项验收；不支持项必须明确返回失败，不允许静默穿透到来源或工作区外。

## 与现有系统的接入点

| 系统 | 当前接入点 | Windows overlay 必须补充 |
| --- | --- | --- |
| 创建与幂等 | `src/worktrees/service.ts` 的 preparing/ready/failed 清单、UUID 排他锁 | 挂载准备、可信 ready 收据、已存在挂载身份核验；未知创建不重新初始化 upper |
| 后端选择 | `src/worktrees/riftri.ts` 的 v2 一次性 helper | Windows 长驻挂载 helper 协议；缺 driver/helper 时继续明确拒绝，不回退原目录 |
| 工作区身份 | `src/worktrees/git.ts` 的 realpath/lstat/dev/ino/birthtime | 现有入口拒绝链接；不能全局放开 junction。仅允许经管理器认证的挂载身份，或采用不触发入口重解析的受控挂载路径 |
| Sandbox 授权 | `src/sandbox/access-manifest.ts` 与 native ObjectGrant | 路径及句柄身份一致；ACL 只改变虚拟对象。不同账户必须看到同一个受控挂载，不能依赖宿主会话的私有盘符 |
| 持久 capability | 根身份摘要及卷/文件 ID | 重挂载保持受控稳定身份；不得随机换卷号导致重复 SID/ACE，不得将不同 upper 冒充同一根 |
| 调度、项目记忆 | 实际 workspace 串行，来源 projectWorkspace 分组 | 每 overlay 有独立实际路径；挂载身份核验在 admission、执行、Sandbox 启动前完成 |
| 文件工具、AGENTS、Skills | 实际 workspace 中读取/写入 | 合并目录枚举与文件版本检查工作正常；脏文件可见，编辑不影响 lower |
| MCP、只读 subagent | 沿用实际 workspace 与既有 Broker 边界 | 路径可见性一致；不扩大只读 subagent 或 MCP 权限 |
| Git CLI | 普通命令执行，无专用 Git 工具 | status/diff/add/commit、锁文件与原子 rename、refs/index 独立；Sandbox 实际安装态验证 |
| 取消、关闭、恢复 | Engine 排空任务后 WorktreeService.close | 先结束 Runtime/命令，再卸载。helper 意外退出使路径不可用，不能落入空普通目录继续写入 |
| 历史续聊与重启 | 持久清单定位原 workspace | 校验 lower/upper/control 身份后重新挂载，不重新取基线；缺失或未知状态明确阻止执行 |
| tracing 与日志 | worktree.create / riftri.snapshot | 增加挂载、就绪、异常退出、卸载、恢复开始/终态和耗时；只记 ID、后端、受控错误，不记源码/安全描述符 |

WinFsp 的目录挂载与原生 Sandbox `FILE_FLAG_OPEN_REPARSE_POINT` 校验存在实际兼容问题，不能通过删掉校验来解决。实现前需用受控夹具验证挂载路径的 `realpath/lstat`、GetFileInformationByHandle 和跨账户打开结果，再选择具体路径形式。

## 验收顺序

1. 原生核心：合并枚举、copy-up、删除标记、文件/目录重命名、覆盖、大小写、并发句柄、文件锁、flush 和故障恢复；下层字节与 ACL 不变。
2. NTFS + 真实 WinFsp：宿主 Node 文件 API、Git、编辑器式临时文件替换、映射文件与目录通知；测试多实例隔离和来源变化语义。
3. 权限：真实 Windows 安全描述符、继承与拒绝、受限 token、独立 capability；验证没有通过 lower 打开的写入通道。
4. 产品联动：默认 Riftri 创建、显式 Worktree 不变、会话续聊、同目录排队、不同 overlay 并行、记忆/Skills/子任务/MCP 路径、取消及服务关闭。
5. 崩溃和重启：写入/rename/copy-up 各阶段中断、helper 被终止、失去挂载、重复服务启动和重挂载身份；未知状态不盲目重放。
6. 安装态 Sandbox：专用账户 Runtime 实际读写、Git、ACL 赋权/撤销、服务重启；宿主成功不能代替该项。

单元或原生核心测试通过不能标为挂载或安装态验证通过。达到上述条件前不将后端加入默认选择，不修改现有失败关闭行为。

## 依赖、许可与当前环境

2026-10-25 检查到本机有 MSVC x64 工具链；默认安装目录、WinFsp 注册表项及相关服务均未发现 WinFsp 安装。尚未安装驱动、SDK，未改动 Sandbox 安装或正在运行的 CodeAtelier 服务。

官方最新稳定发布查询返回 `v2.1`，安装包 `winfsp-2.1.25156.msi` 的 GitHub 资产 SHA-256 为 `073a70e00f77423e34bed98b86e600def93393ba5822204fac57a29324db9f7a`。这是候选固定依赖，尚未下载或验签；实际安装前还要核对 Authenticode 发布者及安装选项。

Riftri v0.6.5 是 MIT；WinFsp 是 GPLv3 加 FLOSS 例外，另有商业许可。不能把 Riftri 的许可结论扩展到 WinFsp。当前可继续私有开发与验证；未来分发须单独决定符合条件的开源分发或商业授权，不擅自为 CodeAtelier 选择许可证，也不假定拆成 helper 就自动解除分发义务。

参考：

- [WinFsp Native API](https://winfsp.dev/doc/WinFsp-API-winfsp.h/)
- [WinFsp Native API 与 FUSE](https://github.com/winfsp/winfsp/wiki/Native-API-vs-FUSE)
- [WinFsp 许可证](https://github.com/winfsp/winfsp/blob/master/License.txt)
- [WinFsp v2.1 发布](https://github.com/winfsp/winfsp/releases/tag/v2.1)
- [现有工作区行为](worktrees.md)
- [Windows root capability](windows-root-capabilities.md)
