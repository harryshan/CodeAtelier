# 隔离 Local 使用指南

隔离 Local 用于多个对话同时修改同一个项目。每个对话拥有私有写层，按需读取主目录文件；创建时不遍历或复制整个项目，也不创建 Git worktree。Windows 和显式启动的 Linux 已接入任务、Sandbox、发布及正常文件检查/参考继续；Linux 异常恢复和 macOS 后端尚未实现。

## 开始使用

1. Windows 准备 WinFsp Runtime、仓库构建的 WinFsp helper 和已启用的 CodeAtelier Sandbox；Linux 按下节显式启动。安装或 Repair 仍须显式执行，入口可见不表示安装健康。
2. 在新项目入口选“使用隔离 Local”，或在已有项目旁选“新建隔离 Local 对话”，确认来源目录后创建。需要并行时为同一来源创建两个对话，设置中的并发任务数至少为 2。
3. 正常提交编码任务。文件工具和命令使用该对话的虚拟目录；项目分组和记忆仍归属原项目。不要在来源内部指定应用数据目录。
4. Agent 用 `local_publish` 明确选择源码路径和验证命令。任务成功后，服务合并当前来源，创建独立候选视图重新验证，再按来源串行发布。未选择的修改、缓存和构建产物留在私有层。
5. 查看任务结束状态：“已发布”才表示所选文件已写回来源；“私有内容已保留”不表示写回。正常结束后视图卸载，下一轮使用原会话继续。

新建对话的既有默认模式保持不变；需要这个机制时明确选择“隔离 Local”。已有 Local、Riftri 和 Worktree 会话不自动迁移。

## Linux 启动

当前通过源码构建和显式启动器使用，尚无自动安装/预编译包分发。需要 Linux Node.js 24/26、Python 3、unshare/setpriv/mount、非特权 user namespace、FUSE 3 Runtime/开发头文件、g++ C++20 编译器，以及已准备的 MXC/Bubblewrap Sandbox。依赖必须按 Linux 安装，不能直接复用 Windows `node_modules` 中的原生模块。真实验证环境为 WSL2/ext4；不支持把本实验能力扩展到 DrvFS。

先在所用数据目录的设置中启用 Sandbox。以下从 Linux checkout 根目录执行，替换两个绝对路径占位值；数据目录和视图目录都必须独立于来源项目，视图目录还须独立于数据目录。

```sh
pnpm build
pnpm overlay:build-linux
pnpm start:overlay --data-dir /absolute/private-data --views /absolute/private-views
```

`overlay:build-linux` 将只读 helper 和控制器放到 `dist/native/linux-<arch>`；默认 build/check 不编译或安装 FUSE。预先解包开发头文件时可显式传 `--include-dir /absolute/include --library libfuse3.so.4`，库名须与现有系统 Runtime 匹配，见 [构建说明](../native/linux-local-overlay/README.md)。

`start:overlay` 自动绑定控制根与同一个 `--data-dir`，仍由原 supervisor 支持服务重载。省略 `--data-dir` 时沿用 Linux 默认数据目录，`--views` 必须明确提供；不会在 Windows 自动进入 WSL。启动器只在应用 namespace 内挂载，服务进程撤销挂载 capabilities；宿主编辑器不能通过同名路径直接访问虚拟文件。普通 `pnpm start` 不开放创建入口，缺少依赖不会静默改用宿主执行。关闭应用前先排空任务和 Runtime，再正常卸载；不自动接管未知挂载。

## 冲突和中断

互不重叠的文本改动可以三方合并；同段冲突、依赖变化或候选测试失败时保留私有修改。Windows 与 Linux 的正常 ready 会话均可通过“检查私有修改”输入明确相对路径，查看原文、私有修改、当前来源和合并预览，再创建参考会话重新处理。新会话从当前主目录开始，只附带旧材料，不自动应用或运行任务；原对话保留。检查不是发布许可，后续仍须重新读取、验证和明确选择源码。原会话也可继续任务，但历史依赖保守保留，续聊不保证消除先前发布冲突。

Linux 检查仅读取正常卸载后已有基线的文件，最多 100 项、单文件 2 MiB、整组内容/预览 16 MiB；支持普通文件、空文件和删除标记，不重新挂载或扫描主目录。不检查目录树、链接、opaque/redirect 目录覆盖或待确认的收尾现场。

服务中断不自动重放命令或发布。Windows 已确认的完成态可通过对应恢复入口收尾，异常私有卷可检查中断参考，可能含部分写入；候选中断保留记录，启动仅清理 Sandbox 残留授权，不视为测试通过。Linux 异常现场保持保留，暂不提供这些恢复入口。元数据损坏或缺少证明时不自动修复。

## 与 Git 和 Sandbox 的关系

| 模式 | 文件来源和写入 | Git | 发布到主目录 |
| --- | --- | --- | --- |
| 隔离 Local | 按需来源 + 会话私有写层 | 视图隐藏来源 `.git`，不管理 Git 状态 | 成功任务明确选择、候选验证后自动发布 |
| Git worktree | 指定提交建立的独立工作目录 | 标准独立 HEAD/index 和分支流程 | 沿用 Git 工作流，不自动回写 |

隔离 Local 的 Runtime 只获得视图及显式授权根，不因回写而获得来源写根；发布由宿主协调器处理。Sandbox 启动失败拒绝该任务，不静默转为宿主执行。`.git` 隐藏只阻止视图内的普通仓库发现，不是禁止所有 Git 程序或显式外部路径的安全边界。

多个对话不是互相敌对的 OS 安全边界，沿用各平台既有 Sandbox 限制。主目录仍可被编辑器等外部程序修改；发布会复核已记录依赖，但不提供任意外部写者 CAS、多文件原子事务或完整工作区外依赖跟踪。

## 当前限制与成本

- 当前主流程验收覆盖 Windows/NTFS + WinFsp 和 WSL2/ext4 + Linux OverlayFS/MXC；不扩大为所有 Linux 发行版、macOS 或大型工程验收。
- 发布最多 100 个普通单链接文件，每文件 2 MiB，总内容 16 MiB；父目录须已存在。不发布目录树、链接或特殊文件；二进制双改保守拒绝。
- 创建不扫描源码；读取依赖检查、首次写入复制和候选构建仍有成本。私有产物占磁盘，来源大树创建测试不代表大型构建没有开销。
- Linux 只读 lower 首次查找缓存父目录成员、首次读取保存文件基线；不提供创建时全目录原子快照。支持项目内相对依赖链接（包含前导 `../`，但不能越出项目；不支持 `a/../b` 这类中途回退、绝对或外部链接）。链接和目标各自记录读依赖，发布仍只接受真实普通文件路径；不支持发布链接或保证包安装器在 upper 创建链接后正常收尾。只读依赖可为硬链接，捕获正文最多 16 MiB，并以 64 KiB 缓冲校验；待发布源码及未发布编辑基线仍限 2 MiB 单链接文件。历史依赖并集和目录成员变化可能保守拒绝发布；不能套用 Windows 工程读集验收。
- 不自动删除会话或丢弃未发布内容。异常状态优先保留，不承诺自动恢复所有崩溃和损坏情况。

设计和证据见 [Local overlay 设计](local-overlay-design.md)、[验证记录](verification.md)；Windows 手动验收为 `pnpm overlay:verify-browser`，Linux 使用 [HTTP 探针](../experiments/native-local-overlay/README.md)。两者均不在默认检查或 Evaluation 中自动执行。
