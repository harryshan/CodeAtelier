# 基于 Git 提交的虚拟 worktree PoC

后续方向更新：D170 已将用户的 Overlay 需求重新定界为 Local 会话文件隔离与冲突整合，独立于 Git。本文保留 D169 实验的实现与实测，不再作为该需求的后续方案；见 [Local overlay 重新设计](local-overlay-design.md)。

状态：2026-10-25 用户授权的实验，真实 Git/Sandbox、十万文件对照与首次扫描优化已完成。不改变现有 Riftri、Worktree 或 Local 的默认行为，不迁移会话，不重启用户服务。优化显著减少首次扫描耗时，但仍需完整读取内容，尚不适合作为性能已经验收的产品替代。

## 要验证的需求

目标是减少巨型仓库并行任务的工作文件副本和创建延迟。包含主目录未提交修改不是需求。使用固定 commit 的 tree/blob 作为不可变 lower，WinFsp 提供普通文件系统视图，已有 SQLite 命名空间、ACL 和私有对象保存修改。

Git 管理部分使用 `worktree add --detach --no-checkout`，再以 `read-tree <commit>` 初始化独立 index；不复制主目录 index，不执行 checkout，不访问主目录工作文件。HEAD/index 私有，objects/refs 按标准 worktree 共享。index 初始化仍处理全树元数据，不宣称整个创建流程为 O(1)。

## 实现与实验边界

- 复用原生 WinFsp callbacks、访问检查、upper、正常卸载及未知状态拒绝恢复；新增显式 Git lower 入口，仅由人工 PoC 使用。
- 固定本机 Git 可执行文件，通过常驻 `cat-file --batch-command` 按 OID 查询 tree、大小和 blob。不借读取命令隐式联网，不读取来源工作文件。首次访问目录时解释该层 tree；读取内容使用有界内存，不落盘读缓存。
- 初版只验证 SHA-1、Windows 可表达的普通文件/目录和受控无转换仓库。特殊 mode、大小写冲突、不支持的名字、`.gitattributes`、submodule 等访问时显式失败。不能把原始 blob 当成任意仓库经过 EOL/filter/LFS 转换的 checkout；未扫描的子树也不能预先保证兼容。
- 标准 Git status 不使用 assume-unchanged/skip-worktree 或伪造 clean。首次 status 的遍历、blob 读取、index 刷新与后续 status 分别计量。
- Git PoC 卷采用 no-atime：读取不自动更新访问时间；显式设置时间、内容/属性/ACL 修改仍持久化。生产实时 overlay 的自动访问时间行为不变。
- Sandbox 使用现有已安装专用账户 Runtime、虚拟卷 ACL 与共享 common Git 根授权；宿主 fallback 不算通过。不安装/Repair Sandbox，不创建分区。共享 Git metadata 仍不是任务间安全边界。
- 实验失败保留自己的数据和 Git 登记，正常退出停止自己的 helper；不清理用户仓库。

## 测量设计

用独立、可重复的 Git 对象夹具生成大文件树，来源目录不展开工作文件。与相同 commit 的普通 worktree 比较：登记、index 初始化、挂载、总就绪耗时；就绪时、首次/重复 status 后的逻辑字节、分配字节、文件数量；tree/blob 读取计数及内容字节。包括共享 Git 数据之外的私有 admin/index、upper、SQLite/WAL。

“首次 status”指新 worktree 上首次命令，不等于操作系统冷缓存。夹具生成、Git 对象缓存、杀毒、磁盘和测试顺序均影响时间；不通过清空系统缓存或关闭杀毒干预用户机器。原生计数由真实 lower API 入口记录；Git 元数据访问与工作文件访问分开。

Git/隔离验证覆盖两个视图、固定提交、dirty 来源不泄漏、读写/删除/rename、diff/add/commit/reset/branch、主 HEAD/index 不变、正常卸载恢复；Sandbox 验证真实 Runtime 读写和 Git、完成释放及取消。

## 运行与结果

需要已安装 WinFsp Runtime、MSVC x64 SDK 和 Git。Sandbox 开关要求本机已有正常安装态，不由此脚本安装或 Repair。

```powershell
pnpm worktree:build-winfsp -Sdk .local/winfsp-sdk/extracted/DYNAMIC -VerifyReparse
pnpm worktree:verify-virtual --count=100000 --sandbox
# 相同文件数，全部内容唯一：
pnpm worktree:verify-virtual --count=100000 --unique-blobs=100000
# 只复查功能，不生成大树/普通 checkout：
pnpm worktree:verify-virtual --verify-only --sandbox
```

2026-10-25，Windows 10.0.26200、i9-12900K、Node 26.10.0、Git 2.55.0.windows.2、WinFsp 2.1.25156。[原始计量 JSON](virtual-worktree-poc-results.json) 来自独占 `.local/virtual-worktree-poc-XqC9Wi/report.json`，`.local/virtual-worktree-100k.log` 保存阶段输出。JSON 保存平台、功能验证、阶段耗时、原生计数、物理文件分配量与测量限制，不含用户项目内容。下面是一次测量，MB 使用十进制，不是冷 OS cache；虚拟先测，普通 worktree 后测。

夹具为 **100,000 个 4 KiB 文件、100 个目录、1,000 个复用 blob**；来源只有 `.git`，从未展开工作文件。它代表文件数量带来的元数据成本，不代表十万个唯一内容、Chromium、构建、LFS 或 submodule 的性能。

| 项目                                               |      Git 虚拟 worktree |        普通 Git worktree |
| -------------------------------------------------- | ---------------------: | -----------------------: |
| 创建至 Git 绑定完成                                |                0.552 s |                 20.552 s |
| 就绪时私有分配字节                                 |   9,040,296（9.04 MB） | 418,406,840（418.41 MB） |
| 就绪时私有物理文件数                               |                     11 |                  100,007 |
| 首次 `status --porcelain=v1 --untracked-files=all` |              106.217 s |                  0.120 s |
| 第二次同命令                                       |                2.086 s |                  0.071 s |
| 首次 status 后私有分配字节                         | 41,447,848（41.45 MB） | 418,406,840（418.41 MB） |

虚拟创建阶段：no-checkout 登记 52.5 ms、read-tree 初始化 index 98.9 ms、挂载 47.5 ms、gitfile/repair 绑定 60.8 ms；总计另含 Git 查询、程序定位、协议及 trace 落盘等成本。index 是全树元数据，不能用挂载只需 47.5 ms 代表总创建，更不能宣称完全不随文件数量增长。

原生计数在挂载 ready 和完成绑定后均为 tree/info/blob **0**。第一次 status 后为 tree **101**、blob info **1,000**、blob 内容 **100,000 次 / 409,600,000 字节**。第二次 status 没有增加 blob 读取。lower 工作文件打开/枚举始终 **0**；私有 objects 目录始终只有 `.git` 对应的一个对象，普通文件未因读取/status 落盘。首次扫描增加的是 SQLite 命名空间/安全描述符等元数据和 index，不是 checkout 内容副本。

分配字节由每个物理文件的 Windows `FILE_STANDARD_INFO.AllocationSize` 求和，包含控制目录 SQLite/WAL/SHM、upper 和独立 Git admin/index；不计共享 Git 对象、源码夹具、trace/测量日志、NTFS MFT/目录索引/卷日志等开销。不是对整个卷 free-space 的精确差分。

## 首次扫描优化

用户同日要求优化首次扫描。先在一万文件/1000 blob 样本上计量原实现：首次 status 10.561 s，其中 SQLite 写语句执行累计 6.294 s，Git tree/blob 内容请求累计 0.737 s。主要问题是读取结束时自动更新 atime，触发每文件一次持久化写入；不能把这部分误判为对象解压。

实现三个局部优化：

1. 仅 Git PoC 使用 no-atime，避免读取引发数据库写入。保留 SQLite `synchronous=FULL`、修改时 flush/事务及错误后的失效逻辑。
2. 增加 `entries(parent,node)` 索引，避免每次打开文件按 inode 反查名字时扫描同目录全部条目。已有 PoC 数据库重挂载时按需建立该索引，不扫描来源工作文件。
3. 每种固定 SQL 复用一个空闲已编译 statement；归还时 reset/清空绑定，嵌套查询独立借用，错误时 finalize，连接关闭前统一释放。缓存的是语句，不是路径查询结果，不跳过 ACL 或脏状态检查。

新增累计微秒计量区分 SQL prepare/read/write/exec 和成功的 tree/blob 内容请求；size-only 查询、回调其余逻辑、Git 客户端、调度与内核 I/O 不包含在 objectMicros 中。这些计量不构成完整 CPU profile，不记录路径/OID/内容，也不能直接与命令总耗时相加当成完整解释。读取/写入计数是 SQL step 次数（含遍历游标），不等于文件数。保留首轮原始报告，优化与唯一内容对照另存 [扫描优化计量](virtual-worktree-scan-results.json)。

功能回归在第一次扫描前进行同长度修改、删除和新建 untracked，检查 Git status/diff 真正检测到变化；完成 clean 扫描后再做同长度修改并 add，重挂载后 staged diff 保留。另检查普通读取不改 atime、显式 atime 经重挂载保留、不设置 assume-unchanged/skip-worktree。原有选定提交、双视图、Git、ACL/Sandbox 和失败拒绝访问回归继续执行。

最终对照仍为十万文件/1000 blob，同机、相同命令、虚拟先测，沿用首次命令而非冷 OS cache 的边界：

| 项目                   | 首轮虚拟实现 | 优化后虚拟实现 | 本轮普通 worktree |
| ---------------------- | -----------: | -------------: | ----------------: |
| 创建至 Git 绑定完成    |      0.552 s |        0.508 s |          21.785 s |
| 首次 status            |    106.217 s |   **30.993 s** |           0.153 s |
| 第二次 status          |      2.086 s |    **0.838 s** |           0.083 s |
| 创建后私有分配         |      9.04 MB |        8.97 MB |         418.41 MB |
| 首次 status 后私有分配 |     41.45 MB |       41.74 MB |         418.41 MB |

首次扫描缩短 **70.8%（约 3.43 倍速度）**；新增索引没有产生工作文件副本。最终夹具 `.local/virtual-worktree-poc-VL9Dsm` / `.local/virtual-scan-final-100k.log`；另一轮优化后同规模扫描 31.755 s，说明不能把单次毫秒级差异当稳定收益。最终首次扫描仍读取 100,000 个 blob、409.6 MB；第二次没有新增内容读取。来源工作文件打开/枚举始终为零；挂载/绑定完成时 tree/info/blob 均为零。

全部唯一内容的十万文件夹具 `.local/virtual-worktree-poc-tcgsD2` / `.local/virtual-scan-unique-100k.log`：创建 0.520 s，首次 status **35.414 s**，第二次 0.911 s；创建/扫描后私有分配 8.97/41.75 MB。首次 info 与 blob 各 100,000 次，读取 409.6 MB；未测优化前唯一内容版本，因此不为该样本计算加速比。数据仍是受控 4 KiB 合成内容，不是实际大型项目验收。

## 结论与未完成项

成立的部分是：**不需要复制/遍历来源工作文件，可以保留固定提交语义，并显著降低创建延迟与私有磁盘占用。** 优化仍没有物化普通工作文件；首次扫描增加的是 SQLite 和 index 元数据。

首次 status 仍为 O(文件数 + 内容量)。`read-tree` 产生的 index 尚无可复用 stat 缓存，Git 为确认 clean 读取全体文件；单锁回调、按需元数据和常驻 cat-file 往返仍有成本。未实现可信的 stat/index 预热，不能把创建快解释为首次完整使用同样快。

当前夹具的创建加首次 status 为 **31.50 s vs 普通 worktree 21.94 s**，仍较慢；优势是按需使用时无需预先展开文件，以及扫描后约 90% 的私有文件分配节省。适用性应按任务是否立即运行完整 Git 扫描来判断，不能只比较挂载时间。

下一阶段候选是验证可信的虚拟 stat/index 初始化、批量元数据/对象读取、内存与共享只读缓存及 FSMonitor；必须继续正确检测用户修改，不使用 assume-unchanged/skip-worktree 伪造 clean。这些优化尚未实现或验收。当前 PoC 只在受控无转换仓库执行；缺少一般仓库的 EOL/filter/LFS、submodule、Git symlink、特殊文件名/完整 Windows API、分支大范围切换、崩溃故障矩阵、Linux/macOS 与实际巨型项目验收。

缓存仅内容有界（最近一个 blob，上限 128 MiB；单层 tree 上限 32 MiB），tree/大小缓存和 SQLite 元数据随已访问文件增加，尚未测峰值内存。长期产品还需显式保活 base commit：当前夹具分支保持其可达，但 PoC 未建立独立 GC pin，不能保证用户改写所有相关引用后执行 GC 仍可读取原始 lower。

Sandbox 实验采用 workspace 注册适配器，核对固定挂载/私有 gitfile/backlink，并将 common Git 根交给现有 Engine。真实 Runtime 读取提交文件、写入/commit、完成和取消均通过，`agent-runtime/windows-sandbox-user/sandboxApplied=true`，没有 fallback、结束后零租约。产品模式选择、工作区清单、重启后的自动恢复入口尚未接入此新模式；单独挂载的正常卸载恢复已验证。
