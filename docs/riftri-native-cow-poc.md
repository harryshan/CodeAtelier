# Riftri 原生 CoW PoC

日期：2026-10-25。状态：WSL/XFS 原生 reflink PoC 完成；不代表产品已接入。

后续 D167 已改为默认 Riftri 当前目录快照，与显式 Git worktree 并列：直接克隆原目录和独立 Git metadata，包含脏文件，不建立 immutable base，不支持指定提交，也不自动 fallback。当前实现及验证分别见 [工作区指南](worktrees.md) 和 [验证记录](verification.md)；下文保留原版 CLI PoC 的测量与限制，不能用其创建耗时代表当前实现。

## 授权与范围

用户要求验证 Riftri + 原生 CoW，不创建 Windows 分区，允许必要时在 WSL 实验。
本次只操作独立合成仓库及普通文件镜像，不改变 CodeAtelier 的调度、Sandbox、设置或真实项目工作目录。

环境初查：Windows 现有 C/D/E/G 卷均为 NTFS；WSL Ubuntu-26.04 根目录为 ext4，内核 6.18.33.2 支持 XFS。
实际使用 WSL 内 4 GiB 稀疏普通文件承载 XFS（reflink=1），以 loop 挂载；没有使用 OverlayFS，也没有创建分区表。
XFS 工具仅下载 deb 并解包到实验目录，没有 apt install 或全局安装 Riftri，没有修改 Git 全局配置。

## 验证计划

1. 固定 Riftri v0.6.5 官方 Linux 二进制，核对官方 SHA256SUMS。
2. 先确认 reflink backend 与共享 extent，再比较普通 Git worktree 和 Riftri 的增量块占用及耗时。
3. 两个独立 worktree 并发修改同一路径，检查原仓库、基础数据及另一 worktree 不被污染；读取扫描不生成数据副本。
4. 验证独立 index/commit、合并、文件替换/删除、脏目录删除保护与独立进程重新打开。
5. 卸载/重新挂载后检查持久化状态，最后卸载实验镜像；保留证据与复现材料。

## 结论边界

本实验不能证明 Windows ReFS/ACL、macOS APFS、CodeAtelier restricted token、巨型真实仓库或任意断电恢复已验证。
Riftri 的 Git commit 基础目录不自动包含源目录 staged、未提交和 ignored 内容。

## 结果

**结论：同一个 Git tree 下，Riftri 的原生 CoW 确实显著降低新增工作区的物理块占用，文件隔离及基本 Git 生命周期可行；本次创建速度没有优势。不同 tree 的完整基础目录成本是重要限制。**

### 环境与计量

- WSL2：Ubuntu-26.04，Linux `6.18.33.2-microsoft-standard-WSL2`，Git 2.53.0。
- Riftri：官方 `v0.6.5` Linux x64 GNU 发布包，SHA-256 为 `2fb4d697d76a751516971ae235996620281df4b648199a2661db4f8ca6c2a721`，与同版本 `SHA256SUMS` 一致。
- XFS 工具：xfsprogs 6.18.0-3；另外在实验目录解包 liburcu8t64、libinih1。
- 数据集：2,066 个受 Git 管理的文件，276,824,082 bytes（约 264 MiB）；其中 16 个 16 MiB 随机二进制文件、2,048 个 4 KiB 随机小文件，另有文本与 ignore 配置。随机内容避免压缩制造空间收益。
- 空间：操作前后执行 `sync`，取独占 XFS 文件系统 `statvfs` 已用块之差；包括该操作的目录、index、journal 等开销。证据输出放在镜像外，不把 reflink 文件的 `du` 相加当成独占占用。
- 时间：单次 CLI 子进程墙钟耗时，不含随后计量用的 `sync`；同一机器顺序执行，没有冷缓存控制和统计重复，不是通用性能基准。
- 后端：实际 worktree 收据与 status 均为 `reflink`。只读 `backends` 命令最初提示 XFS 需主动探测，不能把该输出当成实际创建失败；后续创建和 extent 验证证明 reflink 生效。

| 操作                                 | 新增 XFS 已用空间 | CLI 耗时 |
| ------------------------------------ | ----------------: | -------: |
| 普通 Git worktree A                  |        265.29 MiB |  0.300 s |
| 普通 Git worktree B                  |        265.32 MiB |  0.278 s |
| Riftri A，首次物化该 tree 的基础目录 |        266.46 MiB |  1.989 s |
| Riftri B，复用同一基础目录           |          1.29 MiB |  1.019 s |
| Riftri C，复用同一基础目录           |          1.32 MiB |  1.019 s |
| 新 tree 的首次 Riftri 工作区         |        266.39 MiB |  1.878 s |

暖创建的边际空间比普通 worktree 少约 99.5%；这一比例不包括首次基础目录成本，也不外推到所有文件分布。Riftri 暖创建在本样本中约为普通 worktree 耗时的 3.5 倍。

### 物理共享证据

`xfs_io -c 'fiemap -v'` 显示三个 CoW 工作区的 `data/00.bin` 初始均映射到相同的物理 512-byte block 范围 `6975376..7008143`，flags 为 `0x2001`（包含 SHARED）。普通 Git worktree 的同文件为另一物理范围，未带共享标志。

分别在 A/B 的文件起始处写入 4 KiB 后，两者前 8 个 block 分别成为 `5016120..5016127` 和 `2770752..2770759`，余下范围仍共享；未写入的 C 保持原范围。原仓库、C 和原始不可变 base 的文件哈希保持原值，A/B 哈希不同。这同时验证了真实共享块与写时分离。

完整读取 C 的全部 2,066 个文件并计算 SHA-256，XFS 已用块增量为 **0 bytes**。两个并发线程各自在不同工作区执行二进制局部写入、文本覆盖、原子替换和删除，合计新增 278,528 bytes；这不是仅二进制写入的开销。

### 功能与恢复

| 验证项                       | 实测结果                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 两个工作区并发写相同相对路径 | 相互独立，原仓库及基础目录未被污染                                                                                              |
| 独立 Git index               | A stage 后，B 的 cached diff 仍为空                                                                                             |
| 独立提交                     | A/B 得到不同 HEAD；共享仓库的 Git 写操作按顺序执行                                                                              |
| 集成修改                     | C merge A 成功；再 merge B 检出冲突；abort 恢复成功                                                                             |
| 脏工作区删除保护             | 不带 force 的 remove 非零退出，修改保留                                                                                         |
| 创建过程中 SIGKILL           | 在 intent、Git metadata 创建后，开始物化新 base 时 SIGSTOP/SIGKILL；进程返回 -9                                                 |
| repair                       | 中断后 pending_adds=1；首次 recovered_adds=1、errors=[]，其后 pending_adds=0、原 4 个活动视图保留                               |
| 重复 repair                  | recovered_adds=0、errors=[]，没有重复恢复                                                                                       |
| 干净卸载/重挂载              | 4 个工作区 HEAD、Git status 和选定文件哈希一致，repair 无错误                                                                   |
| 完成后删除和 GC              | 5 个干净 Riftri 工作区正常删除；GC 回收 833,986,560 bytes（约 795.35 MiB）；最终 active_views=0、bases=[]、diagnostic_issues=[] |
| Git 对象完整性               | `git fsck --no-dangling` 成功                                                                                                   |

这次 SIGKILL 覆盖一个真实进程中断点，不是断电测试；干净卸载不等于验证所有崩溃点的持久性。没有开放可写 subagent，也没有启动 CodeAtelier 产品任务。

### 接入含义与限制

1. **优先用于同一基线并行分叉。**本次只新增小文件的不同 tree 仍需要约 266 MiB 新基础目录，不能把 Riftri 视为跨版本全局块去重。应限制保留的 base 数量并安排显式 GC。
2. **启动成本不能按 O(1) 承诺。**文件/目录元数据和 Git index 仍需建立；海量小文件、巨大仓库需要另测。本次只验证约 264 MiB 合成仓库，不声称 Chromium 规模已验收。
3. **初始状态来自 commit。**源目录中特意设置的 staged、未提交、untracked、ignored 内容均未进入从 HEAD 创建的工作区。继承这些状态需要产品另行设计；构建输出和依赖缓存不自动受益。
4. **存储隔离不改变安全边界。**独立 index/worktree 仍共享 Git 对象和 refs；merge 冲突仍需处理。在 XFS 上以普通用户成功操作文件，不能证明 Windows restricted token、DACL/capability 或工作区之间的安全隔离。
5. **环境范围有限。**只实测 Linux XFS reflink 经 WSL2 内核执行；未实测 Windows ReFS、macOS APFS、Btrfs 或 CodeAtelier 安装态。
6. **空间层次不同。**GC 回收的是 XFS 内可用空间；镜像外的 ext4/WSL VHDX 不保证立即缩小。本次镜像逻辑长度 4 GiB，收尾后外层 `du` 仍约 2.0 GiB，保留用于复查，未挂载。

建议进入下一阶段的条件是：明确用户任务基线和 dirty snapshot 规则后，再做 CodeAtelier 的显式可选工作区适配。本 PoC 不批准替换当前同目录串行规则，也不推导 Windows 支持完成。

## 本地证据与复现入口

本机材料目录：`G:\codeagent\.local\riftri-cow-poc-20261025`，包含校验文件、下载包、`poc.py`、`finish.py`、`mounted.py` 和 `evidence/`。这些是本地实验材料，受 `.local/` 忽略，不随 Git 报告提交。

- `evidence/metrics.json`：原始 bytes、seconds 及行为断言结果。
- `evidence/run-command-*.json`：每条实验命令、退出码、耗时、stdout/stderr；包含 extent、真实 backend、Git 操作及 repair 收据。
- `evidence/interruption.json`：进程中断前的生命周期消息及 -9 退出码。
- `evidence/expected-after-remount.json`、`remount-verification.json`：4 个视图的重挂载验证。
- `evidence/finish-command-*.json`：新 tree 成本、正常删除、GC 和最终 Git fsck。

WSL 中原始实验根为 `/var/tmp/codeatelier-riftri-poc-20261025`；`xfs.img`、工具及镜像外 evidence 留存。最终 mountpoint 检查确认未挂载，`losetup -j` 没有该镜像的活动 loop。

初始化流程是：下载固定版本发布包并核对 SHA256SUMS；在新实验根解包 xfsprogs 及其缺失依赖；对新普通文件执行 `truncate -s 4G` 和 `mkfs.xfs -m reflink=1`；创建空挂载目录。禁止将 mkfs 目标替换为块设备。

实验脚本写死实验根和用户名以限定范围；重新完整运行时必须使用新的实验根并同步更新脚本，不要在已运行的镜像上重放 `run`。入口拒绝已有 repo 和未挂载的目标。每个实验阶段在同一 WSL 调用内管理挂载和普通用户子进程，结束后卸载，避免依赖跨调用挂载状态。

首次全新镜像准备后，顺序执行如下阶段（本次已完成收尾，不能直接重放）：

```powershell
wsl -u root --exec python3 /mnt/g/codeagent/.local/riftri-cow-poc-20261025/mounted.py run
wsl -u root --exec python3 /mnt/g/codeagent/.local/riftri-cow-poc-20261025/mounted.py verify
wsl -u root --exec python3 /mnt/g/codeagent/.local/riftri-cow-poc-20261025/mounted.py finish
```

`mounted.py` 只挂载已存在的普通文件，以 `harryshan` 执行实验，finally 同步并卸载；不会安装工具、创建分区或自动格式化。初始化挂载后需要将 XFS 根目录所有者设为实验用户。

## 参考与文档验证

- [Riftri v0.6.5 发布](https://github.com/assistant-ui/riftri/releases/tag/v0.6.5)
- [Riftri 安装与校验说明](https://github.com/assistant-ui/riftri/blob/v0.6.5/docs/install.md)
- [Riftri CLI 语义](https://github.com/assistant-ui/riftri/blob/v0.6.5/docs/cli.md)

本项目只新增此报告，运行文档格式及 diff 检查；没有改动产品源码，因此未运行产品单元/E2E 或任何 Evaluation。
