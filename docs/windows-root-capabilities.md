# Windows 持久授权根 capability（D163）

## 身份与存储

Windows Broker 为工作区和显式可写授权根各保存一个随机 SID，不按任务或服务启动轮换。位置由应用 `--data-dir`（或平台默认数据目录）决定：

```text
<data-dir>/sandbox-root-capabilities/<objectIdentityDigest>.json
```

每条 v1 记录包含真实路径、卷/文件标识、对象身份摘要与 SID。身份摘要沿用 AccessManifest 的规范路径、设备、文件 ID、创建时间；同一路径被删除重建不是同一根。路径移动也会改变当前键，不自动迁移旧身份。不同根不共用 SID；同一根在不同会话或不同工作区的额外授权中复用。

SID 来自 Node 系统随机数，不以路径哈希当作授权身份。Broker 先创建私有完整文件并 flush，再用独占硬链接发布，竞争者读取已发布胜者，不覆盖现有身份。记录损坏、版本/身份不符、私有 ACL 核验失败时拒绝 Sandbox 启动，不以新 SID 替换；启动前宿主 fallback 仍遵守既有显式提示与审批规则。不支持硬链接的数据目录会失败，不降级为部分可见写入。

记录只由宿主维护，不向 Runtime 暴露存储路径。Windows 文件 ACL 仅允许宿主用户与 SYSTEM，目录使用可信宿主数据目录；拒绝本次可写授权根覆盖该数据目录或 registry 子目录。记录不作为新的授权来源：只给当前 AccessManifest 的可写根加载 SID，只读根不取得它。实例 HOME/TEMP 不入库，避免每次任务留下永久记录。

## 执行与清理

Windows 可继承 ACL 的写入会向现有子目录传播。持久 root capability 不代表共享账户 ACE 也永久保留；大型工作区在启动授权和最后租约撤销时仍可能等待数十秒或数分钟。仓库内的依赖、构建缓存和测试产物也参与此成本，Git ignore 不会排除 ACL 传播。

共享 ACL 撤销和 journal 对账各允许 600,000 ms；Broker 的 Windows 整代/启动恢复总期限为 660,000 ms，为进程排空和安装自检预留时间。原生自检与账户进程排空各保持 20,000 ms，POSIX 启动恢复保持 30,000 ms。达到期限仍保留 unknown/journal 并禁止宿主重放，不以延长期限替代成功撤权证明。服务关闭/重载先等待 Engine 清理，再进入 HTTP close hooks，避免 Fastify 插件关闭计时器提前报错；此变化不加快 ACL 传播。

- `execution SID`：每次执行新建，绑定 IPC、默认对象 DACL 和执行身份。
- 临时 capability：每实例新建，继续用于临时目录、station/desktop 与原有身份核验。
- 持久 root capability：每个长期可写根独立；原生 v4 帧逐根传递，Supervisor 核对对象身份后安装 ACE，bootstrap 只把本次根的 SID 加入受限 token，Runtime 客户端核验也检查这些 SID。
- 正常结束/取消/启动失败：仍终止 Job、撤销临时 capability 和最后引用的共享账户 ACE，**不删除持久根 capability ACE 或注册记录**。启动失败的“回滚完成”只涵盖本次临时授权/账户租约和进程，不回滚已注册长期身份。
- 服务恢复：先按原有 generation/journal 排空与对账，再加载同一数据目录中的 SID。ACL revoke 帧和持久 grant journal 继续保持 v2，旧记录仍可读取；它们只处理账户授权，不是持久根 SID 注册表。

不再授权某根后，新 token 不包含该根 SID，但已有任务须先结束；ACE/记录保留以支持将来重新授权。不提供自动扫描删除或一键撤权工具。若要彻底移除，须在停服后核对记录中的原对象身份、备份 ACL 并进行受控撤权，再处理注册记录。**删除 JSON 不是撤销 ACE**。

长期 capability 延长了相同 SID 的授权生命周期；带 ACE 的文件移出根后仍可能保留授权，因此不宣称纯路径 allowlist。同账户 peer、Everyone restricting SID 和既有公共 ACL 的风险不变，不提供任务间 OS 隔离。

## 升级、备份与限制

原生命令帧从 v3 升至 v4，拒绝旧 v2/v3 执行帧。Runtime IPC 与安装 state 版本不变，但 Supervisor、bootstrap 与 Broker 必须一致。先停止服务，备份应用数据目录，再构建：

```powershell
pnpm sandbox:native:build
if ($LASTEXITCODE -ne 0) { throw "native build failed" }
pnpm sandbox:runtime:build
if ($LASTEXITCODE -ne 0) { throw "runtime build failed" }
```

由原安装用户在管理员终端按 [维护指南](windows-sandbox-guide.md#维护故障处理与卸载) 显式 Repair/Verify，再启动更新后的服务。本变更不自动操作系统安装或重启。

- 更换数据目录时必须同时迁移 `sandbox-root-capabilities` 并保持宿主私有权限。删除记录、丢失数据或切换到空目录会失去复用依据；对于无法区分首次使用的缺失记录会生成新 SID，不能以此修复旧 ACL。
- 常规 Repair 更换安装 generation 不更换注册 SID。Uninstall 不读取/清理应用数据目录中的注册记录，也不证明长期根 ACE 已撤销。
- 崩溃可能留下 `.pending` 或私有写入器的临时文件；已发布记录仍可使用，不会因多一个暂存硬链接生成新身份。停服后可核对并处理这些暂存物，不自动清扫未知文件。
- 既有旧 SID、不可维护的子文件 ACL、关闭继承或显式拒绝不会自动修复。初次部署仍可能需要独立的、经过备份和身份核对的 ACL 修复。
- 本次只改变 Windows；不改变 POSIX Sandbox 行为，不推导 macOS 验收。

## 可观测性与验证

`NativeWindowsSandboxRuntime` 以 `sandbox.root_capabilities.resolve` span 记录开始、结束、失败/取消及关联执行 ID；DEBUG 事件只记录任务/实例、根数量和耗时，不记录路径、SID 或文件正文。既有 provision、ACL、Job 和恢复 span 保留。

单元覆盖不同根、相同根重载、真实并发进程首次发布与重启读取、对象替换、损坏记录拒绝、链接目录和数据目录重叠拒绝、取消；原生测试验证 v4 帧、逐根 token SID、两个不同 execution token 原地追加同一文件和其它根 SID 被拒绝。原生 ACL 测试仅使用独占临时目录和宿主派生 token，不等同已安装专用账户验收；部署后仍需验证真实旧项目、重启及异常退出。
