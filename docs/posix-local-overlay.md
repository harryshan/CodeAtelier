# POSIX Local overlay：原生文件系统优先

状态：2026-10-26 用户要求 POSIX 尽量使用平台原生文件系统，并参考相似实现。本增量先验证系统原语，不开放产品平台门禁，不将挂载成功视为发布协议已接入。Windows 的已验证实现保持不变。

## 可复用的结构

参考 Bubblewrap 的 `--overlay-src/--overlay`，Linux 优先由内核 OverlayFS 提供 lower/upper/workdir，并在任务的 mount/user namespace 中建立视图；私有写入由内核完成，不重新用 FUSE 实现同样的 copy-up。正常结束退出命名空间即可卸载，upper 留在宿主私有目录供检查和下一轮使用。[Bubblewrap 官方接口](https://raw.githubusercontent.com/containers/bubblewrap/main/bwrap.xml)

Docker 同样用只读 image layers 作为 lower、独立容器层作为 upper。可借鉴其共享 lower、独占 upper、按文件 copy-up 和 whiteout 处理；它没有为可变宿主项目提供 CodeAtelier 的三方源码发布协议。[Docker OverlayFS 说明](https://docs.docker.com/engine/storage/drivers/overlayfs-driver/)

任务调度、来源项目身份、选集、三方合并、候选命令、来源串行发布与 UI 可以保留。原生批次导出、读依赖检查、私有刷新和异常检查当前依赖 WinFsp v6 状态，必须有 POSIX 实现再开放入口，不能只移除平台判断。

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

## 下一步接入方向

只读 lower 原型已通过 WSL/ext4 手动实验，代码为 `experiments/native-local-overlay/readonly-lower.cpp` 和 `stable-lower-probe.py`，结果见 [只读基线报告](posix-stable-lower-results.json)。现有 ext4 无原生目录快照时，用只读 FUSE 适配层为内核 OverlayFS 固定已观察的命名空间和内容；内核继续负责可写 upper 与 copy-up。只解包匹配现有 Runtime 的 FUSE 开发头文件，没有安装驱动或系统包。

创建只读取根身份；挂载完成时没有目录枚举或内容副本。首次路径查找缓存父目录成员，首次普通文件读取保存该文件内容，前后身份/版本不一致则返回 ESTALE。已读文件与目录列表在来源修改后保持稳定；单独修改来源文件即可让版本验证失败，已观察元数据但未读内容的文件修改后也被拒绝。私有写入通过内核 copy-up 成功，来源保持外部修改，最后先退出消费者再正常卸载 lower。

该原型不提供创建时全目录原子快照；未观察内容仍在实际访问时取基线。缓存元数据与目录成员只存在内存，普通文件上限 16 MiB、观察节点上限 10,000；不支持符号链接、持久版本清单或异常重挂载。来源版本检查当前是元数据比较，不是现有发布器要求的完整内容收据。`.git/.hg/.svn` 在来源 lower 中隐藏，尚未限制 upper 中新建管理目录，不能作为产品 Git 策略验收。

成本从创建移到实际访问：首次查询一个文件会枚举它的父目录，ext4 上首次读取要保存整个文件的基线副本，写入后还会有 upper 副本。全项目构建若读取大量文件，基线磁盘成本仍会增长；不承诺零读取开销或低总内存。报告仅是固定小文件、十万附加空文件的单机样本，不是大型构建基准。

下一步才是基线清单/读依赖导出、真实 MXC Runtime、候选验证和发布器联动。优先使用来源已有且符合授权范围的原生快照，不自动转换 ext4 或扩大到整卷快照；普通 ext4 的上述组合仍是实验，不开放产品入口。实验只输出无正文计数和状态，未启动生产 tracing；产品接入时须沿用现有生命周期 tracing。

命名空间接入已通过真实实验：非特权 OverlayFS 位于独立 mount namespace，直接经 `/proc/<keeper>/root` 可读写，但 realpath 会返回宿主同名空挂载点；现有 Broker/MXC 的规范化不能直接使用此路径。应用专属 user/mount namespace 则可保持普通路径和 realpath 语义：挂载控制进程仅在该 namespace 保留 mount 能力，普通 UID 的 Broker 子进程撤销全部 capabilities，再运行现有 MXC Runtime。挂载不传播到宿主。直接带 namespace capabilities 启动 Bubblewrap 会被其拒绝，不能省略 Broker 的撤销步骤。

`sandbox-probe.py` 使用当前生产 MxcSandboxRuntime、runCandidateCommands、IPC 和固定 Runtime bundle，以及已有 MXC 1.0.0 Linux 安装。两个真实 Runtime 命令区间重叠，各自私有修改成功，来源和另一视图写入被拒绝，Git metadata/Broker 假秘密不可见；正式终态、平台 clean、启动标记清理和正常卸载均通过。[联调报告](posix-overlay-runtime-results.json)。命令模型是固定本地计划，没有真实服务模型或宿主 fallback。

这条路线仍需要产品级显式启动引导、挂载控制协议和异常生命周期实现；实验不修改现有服务启动方式，也不要求宿主 root/系统挂载权限。视图只在应用 namespace 中存在，宿主外部编辑器不会自动看到同名目录中的挂载；不能把它当成普通 Worktree 的全系统路径。Engine/UI 创建和发布联动未验收，平台入口继续关闭。

macOS 先按 APFS 按需 CoW 与系统 FSKit 组合核对接口和打包要求，避免将递归目录克隆包装成零扫描；目前仅官方资料核对，无 macOS 实机验收。两平台均保留“源码明确选择、合并后验证、来源串行发布、冲突保留”的现有协议，不把原生隔离层直接当成发布器。
