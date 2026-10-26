# Linux Local overlay 原生组件

`readonly-lower.cpp` 为内核 OverlayFS 提供按需稳定的只读 lower；`launcher.py` 管理应用 user/mount namespace、私有控制 socket 和挂载生命周期。可写 upper/copy-up 由内核完成。组件不管理 Git，不在创建时扫描或复制项目。

内部相对依赖链接固定自身身份/文本，目标经 overlay 解析；支持不越界的前导 `../`，拒绝绝对/外部链接及中途回退路径。发布仍只接受普通文件，不能用链接写入能力推断包安装器兼容性。新链接清单需配套当前 Broker，旧文件/目录清单仍可读取；真实 Sandbox 编译与改向拒绝证据见 [POSIX 方案](../../docs/posix-local-overlay.md)。

在 Linux checkout 中准备 Node.js 24/26、g++（C++20）、FUSE 3 开发头文件和库，然后执行：

```sh
pnpm overlay:build-linux
```

产物为 `dist/native/linux-<arch>/codeatelier-overlay-lower` 和同目录 `launcher.py`。编译失败不覆盖已有 helper；脚本不安装包、不挂载、不启动应用，也不进入默认 `pnpm build/check`。

若开发头文件已经解包到自有目录，可指定其包含 `fuse3/` 的父目录及已安装 Runtime 的版本化库名。以下路径和库版本只是示例：

```sh
pnpm overlay:build-linux --include-dir /absolute/fuse-dev/usr/include --library libfuse3.so.4
```

运行时还需要 Python 3、unshare/setpriv/mount/umount、fusermount3、可访问的 `/dev/fuse`、非特权 user namespace、Linux 对应的 MXC 依赖及已启用的 Sandbox。在源码根目录构建服务后显式启动：

```sh
pnpm build
pnpm start:overlay --data-dir /absolute/private-data --views /absolute/private-views
```

视图根必须独立于数据根和来源项目；挂载仅在应用 namespace 可见。服务使用普通 UID 并撤销 mount capabilities，原 supervisor 继续负责重载，正常退出先排空任务再卸载。启动器不会自动进入 WSL、安装依赖或接管未知挂载；完整限制见 [使用指南](../../docs/local-overlay-usage.md)。

底层 `launcher.py --root ... --views ... --helper ... -- <argv>` 保留用于受控手动实验；产品入口固定 helper 和 server 路径。真实装配/启动验收见 [探针说明](../../experiments/native-local-overlay/README.md)。

正常文件检查使用固定 `classify` 请求：只对已卸载且 mount 记录 ready 的 upper 明确路径读取类型和版本，区分空文件与 whiteout，不读取源码正文、不挂载或变更状态。Broker 自行读取有界内容和 round 基线。该能力不提供未知挂载恢复，旧启动器须随服务一起更新才能提供正常检查。
