# Linux 原生 OverlayFS 手动探针

验证内核文件层是否适合 POSIX Local 的低成本私有写入，不开放产品能力，不属于 Evaluation，也不接默认检查/CI。

需要 Linux 原生文件系统、Python 3、可用的非特权 user namespace 和支持 `--overlay` 的 Bubblewrap。本机验证环境为 WSL2/ext4、Bubblewrap 0.11.1；不使用 Windows DrvFS 作为 upper/lower，不安装软件或创建分区。

```powershell
wsl --exec python3 /mnt/g/codeagent/experiments/native-local-overlay/probe.py --files 100000
```

Linux 中将脚本路径替换为当前 checkout 的绝对路径。脚本创建 `~/codeatelier-native-overlay-probes/run-*`，保留报告和私有文件供检查。十万文件均为合成空文件，另外有固定源码和 Git metadata 哨兵；生成它们不计入挂载耗时。

探针比较 0/100,000 个附加文件的三次挂载到 ready 时间，统计已知夹具目录的 inotify OPEN/ACCESS，并检查 upper 中没有复制文件。随后验证两个命名空间的实际并行写入、来源写拒绝、根 `.git` 只读遮罩、正常卸载/重挂载保留 upper，以及独立候选中执行明确提供的合并代码。只遍历很小的 upper 统计分配；4 KiB 空 upper 不代表整个文件系统或进程总成本。

每次只运行固定脚本。Bubblewrap 子进程使用独立 user/mount/PID/network 等命名空间、只读宿主根和私有 overlay；退出即卸载，不向宿主挂载表传播。它不是生产 CodeAtelier Runtime，宿主根可读也不是产品读取 allowlist，不能拿此探针代替正式 Sandbox 验收。

不自动捕获修改基线/读依赖、不执行三方合并或源码发布。支持的实验全过程保持 lower 不变；内核明确不支持挂载期间更改 lower，不能据此承诺 Windows 那样的 live lower。该限制及 Apple 平台核对见 [POSIX Local 方案](../../docs/posix-local-overlay.md)。
