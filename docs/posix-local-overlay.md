# POSIX Local overlay：原生文件系统优先

状态：2026-10-26 Linux 已完成原生文件层、Service/Engine、HTTP/SSE、真实 Sandbox 双任务和候选发布接入，显式 namespace 启动并启用 Sandbox 后开放入口。Linux 正常文件检查/参考继续已接入；事故恢复和预编译包自动分发尚未实现；macOS 仍为选型。Windows 的已验证实现保持不变。以下保留各阶段证据，当前使用方式以 [指南](local-overlay-usage.md) 为准。

## 可复用的结构

参考 Bubblewrap 的 `--overlay-src/--overlay`，Linux 优先由内核 OverlayFS 提供 lower/upper/workdir，并在任务的 mount/user namespace 中建立视图；私有写入由内核完成，不重新用 FUSE 实现同样的 copy-up。正常结束退出命名空间即可卸载，upper 留在宿主私有目录供检查和下一轮使用。[Bubblewrap 官方接口](https://raw.githubusercontent.com/containers/bubblewrap/main/bwrap.xml)

Docker 同样用只读 image layers 作为 lower、独立容器层作为 upper。可借鉴其共享 lower、独占 upper、按文件 copy-up 和 whiteout 处理；它没有为可变宿主项目提供 CodeAtelier 的三方源码发布协议。[Docker OverlayFS 说明](https://docs.docker.com/engine/storage/drivers/overlayfs-driver/)

任务调度、来源项目身份、选集、三方合并、候选命令、来源串行发布与 UI 已复用。Linux 单独实现批次导出、读依赖检查和正常私有刷新；异常检查仍依赖 WinFsp v6，因此 Linux 不展示或调用对应入口。

## 会影响正确性的限制

- Linux 内核明确不允许挂载期间修改 underlying lower/upper；外部修改的 overlay 行为未定义。因此，不能直接把正在被其它会话发布的项目当成普通 OverlayFS lower，并宣称与 Windows live lower 语义相同。需要固定 lower，或有完整的会话排空/换代协议。只读 bind 仅限制此视图的写入，不冻结原目录。[内核说明](https://www.kernel.org/doc/html/latest/filesystems/overlayfs.html)
- 稳定基线优先研究 Btrfs 子卷/ZFS dataset 原生快照；它们不等于任意 ext4 目录都能零遍历快照。不得为适配而自动改造用户卷、创建分区或复制整个项目。本机 WSL 当前目标为 ext4，尚未发现已有 Btrfs/ZFS 挂载。
- 原生 OverlayFS 本身不输出首次读版本、编辑原文和完整读依赖。仅枚举 upper 能找到修改，不能证明没有覆盖另一会话的更改。fanotify 非特权模式不能使用 permission events 或 mount/filesystem mark，不把普通通知当成同步的首读/首写拦截。[fanotify 权限说明](https://man7.org/linux/man-pages/man2/fanotify_init.2.html)
- macOS APFS 的目录 `clonefile` 按各条目分别克隆，Apple 建议目录使用 copyfile；节省数据块不等于零遍历。APFS snapshot 是文件系统/卷级只读快照，不是现成的任意目录可写 overlay。[clonefile](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/man/man2/clonefile.2)、[snapshot](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/man/man2/fs_snapshot_create.2)
- macOS 原生 FSKit 可实现用户态文件系统，但仍需编写并分发 FSModule 应用扩展；它不是一个现成 unionfs。macFUSE 的 FSKit 后端可作参考，不预先决定安装第三方驱动或切换到它。[Apple FSKit](https://developer.apple.com/documentation/fskit/)、[macFUSE 后端](https://github.com/macfuse/macfuse/wiki/FUSE-Backends)

## 手动原语验证

`experiments/native-local-overlay/probe.py` 已在 WSL/ext4 的全新独占目录，用已有 Bubblewrap 0.11.1/OverlayFS 检查挂载准备、持久 upper、双命名空间并行、来源只读和候选私有写入成本。代码不使用真实用户项目、不安装依赖、不创建分区、不进入默认检查或 Evaluation。运行方法见 [探针说明](../experiments/native-local-overlay/README.md)。

最终结果见 [原生探针报告](posix-native-overlay-results.json)。100,000 个附加空文件的三次挂载到 ready 为 173.05/172.18/180.13 ms，0 个附加文件为 194.22/217.54/182.97 ms；计入 Python/Bubblewrap 启动，未控制缓存，不作为普遍性能保证。所有挂载准备样本在已知夹具目录的 inotify 中均未观测到 OPEN/ACCESS，upper 没有文件且分配 4,096 字节。该计数不是内核所有元数据操作的完整审计，也不含文件系统其它元数据或进程内存。

双会话对同一小文件不同部分写入，命令时间段确实重叠；各 upper 独立，来源写入拒绝且原内容不变。正常结束后重挂载保留会话 A 修改。独立候选根据显式给定合并内容执行 Python 检查通过，未继承两会话私有产物。会话 A/B 的 upper 各 12,288 字节，候选为 8,192 字节。早期探针因目标 `/workspace` 不存在而被只读根拒绝，改为预建自己的挂载点后通过；未放宽来源写权限。WSL `/tmp` 证据未跨调用保留，最终使用独占 home 目录并复制报告到仓库忽略目录。

该探针不是产品 Sandbox 或发布验收：不自动捕获基线/依赖、不回写来源；其 `.git` 根只读遮罩只隐藏该根的原 metadata，不证明任意嵌套仓库策略。挂载中 lower 变化仅可作为诊断，不能作为受支持的 live lower 保证。

## 当前产品接入与分阶段证据

### 真实 CodeAtelier 后端编译成本

在 WSL2/Ubuntu 26.04/ext4、Node 24.19.0、TypeScript 5.9.2 上，将 `03b2440` 的真实源码和现有 pnpm 依赖准备为独占来源夹具；18,451 个普通文件、1,586 个链接，分配约 427.6 MiB。一次性从 Windows 盘准备夹具耗时 492 秒，**不是 overlay 创建流程**，产品直接使用已有来源目录。固定编译命令未运行包安装器、前端构建或 Evaluation。原始摘要见 [工程报告](posix-overlay-project-build-results.json)，复现命令见 [探针说明](../experiments/native-local-overlay/README.md#真实工程编译与占用)。

| 项目 | 本次观测 |
| --- | --- |
| 两个会话创建 | 150.6 / 116.7 ms；各自初始私有数据 20 KiB |
| helper ready | 所有样本只含根节点；0 枚举、0 文件打开、0 复制字节 |
| 直接完整后端编译 | 7.46 秒；793 个编译输入，444 个产物、2,919,440 字节 |
| 两个 Sandbox 并行编译 | 17.82 / 17.65 秒，实际执行区间重叠；所有产物摘要与直接编译一致 |
| 每视图编译后私有数据 | 约 22.75 MiB，其中首读缓存 838 个对象、约 18.90 MiB 分配量 |
| 正常收尾 | 3.65 / 3.92 秒；缓存对象归零，保留产物/状态约 4.10 MiB，读凭据各 1,128 项 |
| 独立候选 Sandbox | 编译 14.74 秒，含收尾共 19.15 秒；相同产物、1,127 项读凭据；正常清理 |

这是一次功能/成本实测，没有控制冷缓存或重复采样，不把双并行任务与单直接编译的比值当成纯文件系统开销。单候选的 TypeScript I/O Read 为 6.17 秒，直接编译为 0.28 秒；创建低成本已得到支持，但首次实际读取仍有明显成本。当前实现会复制首次读取的文件并逐对象 fsync；这是后续优化的测量目标，尚未通过分项实验归因，也没有为追求速度弱化持久化。

磁盘样本按私有数据的 `st_blocks * 512` 汇总，排除挂载点、内核 work 和视图外 Store/trace，不代表完整磁盘峰值或进程内存。此次候选播种相同 tsconfig，仅验证真实工程候选编译/读集，不新增源码发布证据；源码合并发布沿用既有双会话验收。未覆盖巨型 repo、任意包布局、包安装、macOS 或异常恢复。最终 Runtime 活动标记和宿主残留挂载均为零。早期探针误设产物数门槛、试图读取内核 mode-000 work 目录，均发生在主任务前；已分别改为关键产物检查和明确排除该目录，未改变产品权限。

### 已接入能力

正常文件检查：Service 取得原有 ready 视图锁，Linux backend 读取有界 round B、卸载后的 upper O 和当前来源 T；控制器 `classify` 仅返回明确路径的类型/stamp，识别字符设备及 `user.overlay.whiteout` 删除标记，拒绝复杂 ancestor opaque/redirect、metacopy、链接与超限文件。不打开正文、不挂载、不改变 mount 状态；只读请求拒绝/断线不污染后续写操作状态。Broker 读取普通内容、生成预览并复核分类/round/当前来源，最多 100 项、16 MiB 结果内容。检查复用已有 review trace，classify 单独记录无路径/正文的生命周期。

参考继续：检查版本绑定材料，创建新视图时只播种根 UUID 参考目录，旧视图/私有修改保留；Linux 正常收尾跳过该保留目录，拒绝把参考材料当成源码选择。新任务必须读取当前来源并重新编辑、验证和选择发布。`fileReviewSupported` 与 `incidentRecoverySupported` 独立投影：Linux 支持正常检查，不开放中断检查、来源事故或私有刷新恢复，相关请求在进入 Windows 实现前拒绝。真实公开 HTTP/Sandbox 已验证普通/空/删除检查、新参考任务成功发布和原私有保留，见 [报告](posix-overlay-review-results.json)。

内部相对依赖链接：helper 用 `O_PATH | O_NOFOLLOW` 获取链接自身的句柄，通过 `readlinkat` 固定文本；保持 `RESOLVE_NO_SYMLINKS`，不沿宿主符号链接打开目标。Linux 的这个组合允许获取最终链接对象而不跟随它，见 [openat2 官方手册](https://www.man7.org/linux/man-pages/man2/openat2.2.html)。只接受相对目标和不超出来源根的前导 `../`，拒绝中途回退，避免 `a/../b` 在 `a` 本身是链接时产生不同解析；每段链接仍在 overlay 中解析。链接身份与文本存为独立 `symlink` 读凭据，目标普通文件按实际解析路径捕获；候选、跨轮和 Publisher 都复核该凭据，链接改向拒绝旧发布。helper 创建仍只读根身份，不增加扫描或文件复制。旧文件/目录清单继续兼容，新链接清单要求配套新版 Broker；Windows 不生成该类依赖。

真实 WSL/ext4 的内部 `.pnpm/...` 包目录及 `.bin/tsc` 链接，经两个主 Runtime 和新候选运行实际 TypeScript，合并发布、重载续聊及关闭通过；每主任务 77 条读凭据，见 [报告](posix-overlay-symlink-results.json)。绝对/外部链接、任意链接编辑/发布、包安装器新增 upper 链接及完整 pnpm 项目仍不在该证据范围；普通文件源码发布边界不变。

公开入口接入：只有显式 Linux namespace 启动上下文通过平台工厂校验且启用 Sandbox 时，才允许创建/执行隔离 Local。普通 Linux 启动给出启动器要求，macOS 继续不开放；请求参数仍为原有来源目录与固定 UUID。正常历史、任务、选择发布与续聊沿用同一 HTTP 协议。Linux 正常文件检查使用独立 round/upper 实现；异常恢复尚未实现，历史投影明确不支持，UI 不展示异常入口；直接请求在服务边界拒绝，不触碰 Windows 私有数据库。正常 ready 会话可继续任务读取私有内容，异常现场继续保留。此增量不自动安装 helper 或改变默认创建模式。

Git 策略实测区分来源隐藏与私有新建：只读 lower 对管理目录 lookup 返回 ENOENT 时，OverlayFS 会允许在 upper 创建同名项。现改为 EACCES，根目录及已有 lower 目录的文件、目录、链接、重命名和 git init 均被拒绝；Sandbox 的 `.git` 信任探测将明确拒绝视为不授信任，根解析和其它 I/O 错误仍失败。纯 upper 新目录不再经过 lower，实测可建立独立私有 Git 仓库（[报告](posix-overlay-git-policy-results.json)）。用户已接受该原生限制，并明确不再围绕内部建仓库扩展工作。来源 metadata 不投影、来源不可写、Publisher 拒绝管理目录；收尾跳过并保留私有 metadata，不因它阻断普通源码发布。不声称全层级拦截或阻止任意 Git 程序。

完整 Engine/模型工具主流程先使用固定 provider、SQLite inline 和注入的真实 MXC 启动器通过（[报告](posix-overlay-engine-results.json)）。随后使用生产 Fastify/AsyncStore Workers/SandboxBroker，通过真实 HTTP/SSE 创建双会话并启动任务，双模型屏障保证 Runtime 从同一基线编辑，各自经 `local_publish`、排空和全新候选验证后合并来源；幂等创建、项目归属、私有产物保留、ready/epoch 1、空 Runtime 标记及正常服务关闭均通过（[HTTP 报告](posix-overlay-http-results.json)）。真实浏览器核对创建入口、隔离状态和发布提示；固定 provider 不代表外部模型验收。显式构建和 start:overlay 产品启动现已实现，预编译包自动分发及 Linux 恢复入口仍未实现。

正常缓存回收只处理本次打开且已保存目录身份的 `control-UUID`：收尾把必要 B/历史依赖写入独立 round 后，确认正常卸载，核对路径及目录身份再删除本轮 lower 内容缓存，最后清除 pending。未选 upper 和 round 中的原始 B 保留；来源和旧未知目录不参与扫描或删除。发布/挂载结果未知不触发该回收，清理自身失败也保留 pending。创建阶段的空缓存保留一次，不在启动时盲扫清理历史；长期保留的发布日志另遵循原协议。

Engine 通过平台工厂统一选择 backend 和候选验证器。显式 namespace 启动器把固定控制根、独立视图根与 socket 作为内部 IPC 环境传给服务；Linux 工厂要求控制根精确匹配当前数据目录的 `local-overlays`，视图根与私有数据根不重叠。缺少完整上下文或路径失配时拒绝初始化，不切回其它隔离实现。普通启动和 Windows 保持既有选择；Linux 公开创建门禁现由有效 namespace 上下文和 Sandbox 配置共同控制。

产品启动接线采用显式 Linux namespace 入口：`native/linux-local-overlay/launcher.py` 使用系统 unshare/setpriv 和 Python 标准库管理独占挂载进程，Node 服务及其重载子进程都撤销全部 capabilities。控制器只提供固定 open/seal/close 协议，通过私有 Unix socket 与同一 namespace 的 Broker 通信；挂载目录由启动时指定的私有根和 UUID 派生，不接受任意 mount 命令。来源不进入 Runtime 写根。未确认关闭的持久视图保持 active，后续启动拒绝自动重用；启动器退出清理不等于任务正常结束。此入口的依赖需预装，不自动安装或改动已有启动方式。它不是新配置环境变量体系：socket/namespace 值仅由父启动器注入作为内部 IPC 地址。Local backend/Engine 已接入此上下文，未配置时仍不开放创建。

Linux backend 接线保持 LocalOverlayService 原有任务锁与来源身份协议，使用独立 `linux-overlay-v1` 格式标记，不能把 Linux 控制目录当作 WinFsp v6 数据。workspace 身份绑定持久控制目录与控制器验证的 backing 目录身份，不依赖每次重挂载都会改变的虚拟根 inode。收尾先保存 pending，导出并持久化旧 B/依赖，再执行明确选集的 Publisher；只有完整发布日志确认后才请求控制器在普通卸载状态校验摘要并移除所选 upper 文件。完成状态保存和 pending 删除后才回 ready，未知结果保留。候选使用同一控制器新建独立视图和真实 Sandbox，不能继承原 upper；未确认进程排空不卸载或删候选。早期先以正式 Service 注入 backend 验证，当前已由 Engine 工厂选择。

该接线已通过实际 WSL Service/Store/双 MXC/Publisher 验证（[报告](posix-overlay-backend-results.json)）。原先把 view 放在数据目录内被现有 MXC 私有根重叠检查拒绝，因此启动器新增显式 `--views /absolute/private-views`：虚拟工作路径在数据目录之外，upper/基线/日志仍在私有控制根；不豁免 Sandbox 检查。控制器核对工作挂载点 backing 身份，候选正常关闭后另行移除空挂载点。已有普通源码合并、续轮读取和冲突保留通过；完整 Engine/HTTP/UI 的后续验收见上文。

只读 lower 原型已通过 WSL/ext4 手动实验，代码为 `native/linux-local-overlay/readonly-lower.cpp` 和 `stable-lower-probe.py`，结果见 [只读基线报告](posix-stable-lower-results.json)。现有 ext4 无原生目录快照时，用只读 FUSE 适配层为内核 OverlayFS 固定已观察的命名空间和内容；内核继续负责可写 upper 与 copy-up。只解包匹配现有 Runtime 的 FUSE 开发头文件，没有安装驱动或系统包。

创建只读取根身份；挂载完成时没有目录枚举或内容副本。首次路径查找缓存父目录成员，首次普通文件读取保存该文件内容，前后身份/版本不一致则返回 ESTALE。已读文件与目录列表在来源修改后保持稳定；单独修改来源文件即可让版本验证失败，已观察元数据但未读内容的文件修改后也被拒绝。私有写入通过内核 copy-up 成功，来源保持外部修改，最后先退出消费者再正常卸载 lower。

该原型不提供创建时全目录原子快照；未观察内容仍在实际访问时取基线。活跃缓存保存在内存，随后可一次性 seal 导出，但不能从清单重建挂载；普通文件上限 16 MiB、观察节点上限 10,000。内部相对链接支持见上文；不支持异常重挂载。诊断用 verify 命令只比较元数据，发布桥接另外重建内容/目录版本并交给 Publisher 复核。`.git/.hg/.svn` 在来源 lower 中隐藏且 lookup 拒绝访问，但纯 upper 新目录不保证经过 lower；不作为全层级管理目录封锁保证。

成本从创建移到实际访问：首次查询一个文件会枚举它的父目录，ext4 上首次读取要保存整个文件的基线副本，写入后还会有 upper 副本。全项目构建若读取大量文件，基线磁盘成本仍会增长；不承诺零读取开销或低总内存。报告仅是固定小文件、十万附加空文件的单机样本，不是大型构建基准。

后续 Runtime/发布桥接的分阶段实测见下文，当前产品接入结果见上文。优先使用来源已有且符合授权范围的原生快照，不自动转换 ext4 或扩大到整卷快照；普通 ext4 组合通过显式 namespace 启动开放入口。基础原语实验只输出无正文计数和状态；Runtime/Publisher 联调复用生产 tracing，不将清单路径或内容加入事件属性。

命名空间接入已通过真实实验：非特权 OverlayFS 位于独立 mount namespace，直接经 `/proc/<keeper>/root` 可读写，但 realpath 会返回宿主同名空挂载点；现有 Broker/MXC 的规范化不能直接使用此路径。应用专属 user/mount namespace 则可保持普通路径和 realpath 语义：挂载控制进程仅在该 namespace 保留 mount 能力，普通 UID 的 Broker 子进程撤销全部 capabilities，再运行现有 MXC Runtime。挂载不传播到宿主。直接带 namespace capabilities 启动 Bubblewrap 会被其拒绝，不能省略 Broker 的撤销步骤。

`sandbox-probe.py` 使用当前生产 MxcSandboxRuntime、runCandidateCommands、IPC 和固定 Runtime bundle，以及已有 MXC 1.0.0 Linux 安装。两个真实 Runtime 命令区间重叠，各自私有修改成功，来源和另一视图写入被拒绝，Git metadata/Broker 假秘密不可见；正式终态、平台 clean、启动标记清理和正常卸载均通过。[联调报告](posix-overlay-runtime-results.json)。命令模型是固定本地计划，没有真实服务模型或宿主 fallback。

显式启动引导和挂载控制协议已实现，异常生命周期仍未开放；实验不修改现有服务启动方式，也不要求宿主 root/系统挂载权限。视图只在应用 namespace 中存在，宿主外部编辑器不会自动看到同名目录中的挂载；不能把它当成普通 Worktree 的全系统路径。此早期实验本身未覆盖 Engine/UI；当前公开联动结果见上文。

发布桥接已实现并通过真实 WSL 闭环：Runtime 已确认排空后，lower 用 `seal UUID` 将实际观察的文件身份、原始元数据、按需内容对象及对象版本、目录成员写入独占创建并 fsync 的一次性清单。`src/local-overlays/posix-batch.ts` 有界读取清单，绑定来源与 seal ID，只为明确选择的实际变化生成 B/O；未修改的选集路径仍作为读依赖。已捕获正文可在来源后来变化时提供原始 B；只观察元数据而未捕获正文的路径，仅在来源版本仍一致时补读，否则保留私有修改并拒绝。目录版本沿用已有名称/类型摘要，不将文件替换引起的目录时间变化直接当冲突。

手动 `sandbox-probe.py --publish-probe ...` 从两个真实 Runtime 的私有结果生成批次，复用现有 Publisher 的来源队列、三方合并与写前检查。每次验证重新挂载候选 lower/upper，仅播种合并源码，真实 MXC 执行 Python 检查，排空后导出候选读依赖，再卸载。两批发布把同一文件不同两行合并到主目录，未选产物保留私有；随后真实 Runtime 制造同一行重叠修改，Publisher 在候选启动前拒绝且私有结果/来源不被覆盖。结果见 [发布联调报告](posix-overlay-publication-results.json)。

清单最多 16 MiB、10,000 个观察节点。已捕获的只读依赖以固定 64 KiB 缓冲校验，支持来源硬链接及原生上限内的 16 MiB 正文；重建原始版本后仍需复核当前来源。编辑基线和发布源码保持 2 MiB 普通单链接限制；不能据此推导完整 pnpm 符号链接布局或巨型工程通过。未捕获的只读依赖复用既有流式读版本。来源新文件沿用 Publisher 的私有模式默认创建，已有文件拒绝显式 mode 变化；不提供 POSIX ACL/xattr 保真。清单不证明 Runtime 已停止、挂载已冻结或私有结果不会再变，调用方必须独占生命周期；本实验的父控制器负责真实排空与独占视图。当前产品 backend 已复用此桥接，仍不自动恢复崩溃卷；正常跨轮实验见下文。

产品 backend 已将清单导出纳入冻结/收尾 span，Publisher 和候选 Runtime 复用现有 tracing，只记录 ID、计数、耗时和终态。早期手动桥接没有独立生产 span，其证据不扩大为当前产品观测。

正常跨轮已通过受控 WSL 实验（[报告](posix-overlay-round-results.json)）：任务排空后只遍历私有 upper，记录未发布普通文件的原始 B 和来源读依赖；生成物的缺失 B 不复制正文。新轮使用新 lower 读取当前来源，保留 upper 并在批次导出时优先使用持久旧 B。已发布路径只有在源码结果及私有版本都核对后才允许从卸载状态的 upper 移除。不能证明先前依赖仍有效时拒绝下一次发布，不把旧依赖换成最新值。此首版采用保守依赖并集，未记录 upper 实际读取路径，可能比 Windows 更容易拒绝；不据此自动恢复崩溃或清除未知状态。状态的 B 总正文最多 16 MiB，遍历私有 upper 最多 10,000 项；新生成物仅保存缺失基线。刷新目前验证已有普通文件，来源创建/删除造成的历史目录成员变化仍拒绝，不隐式重置目录依赖；不支持目录重命名/opaque 层的通用刷新。

正常保存与发布校验现已分开：历史凭据过期不阻断只读续聊的私有保存。相同 path/kind/version 去重，发生版本冲突时保留多份凭据，避免本轮观察覆盖旧事实；真正发布仍须通过全部历史和当前版本复核，冲突历史不能自动变为可发布。当前新观察本身无效、状态损坏或挂载未知仍按既有规则拒绝，不据此开放事故恢复。

macOS 先按 APFS 按需 CoW 与系统 FSKit 组合核对接口和打包要求，避免将递归目录克隆包装成零扫描；目前仅官方资料核对，无 macOS 实机验收。两平台均保留“源码明确选择、合并后验证、来源串行发布、冲突保留”的现有协议，不把原生隔离层直接当成发布器。
