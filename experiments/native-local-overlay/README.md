# Linux 原生 OverlayFS 手动探针

## 正式构建与启动

helper 已迁入 `native/linux-local-overlay/readonly-lower.cpp`，使用 `pnpm overlay:build-linux` 显式构建；产品通过 `pnpm start:overlay --data-dir ... --views ...` 启动，见 [原生组件说明](../../native/linux-local-overlay/README.md)。

`startup-probe.mjs` 不注入 Engine/Runtime：将当前构建产物装配到独占 Linux 夹具，用已有 Linux MXC 安装和其余 JS 依赖启动正式入口。模型由本脚本的回环 Responses HTTP/SSE 固定计划替代；公开 HTTP 创建双会话，真实 Sandbox 并行执行及候选验证，检查合并源码/私有产物并通过公开关闭 API 正常退出。需要先 `pnpm build` 和 Linux helper 构建。示例在 Linux shell 执行，Node 和 SDK 路径须为已准备的 Linux 版本：

```sh
probe_root=$(mktemp -d "$HOME/codeatelier-native-overlay-probes/startup-XXXXXX")
node experiments/native-local-overlay/startup-probe.mjs "$probe_root" /absolute/linux-node_modules/@microsoft/mxc-sdk
```

报告为夹具 `startup-report.json`，当前摘要见 [正式启动结果](../../docs/posix-overlay-startup-results.json)。发布后还通过公开 API 重载，确认服务身份变化，并在原会话继续实际 Sandbox 读取合并源码及私有产物。Windows 安装的 Koffi 原生模块不能在 Linux 加载，因此探针只在独占安装树绑定已有 Linux SDK；不改宿主 node_modules，不下载安装包，也不复制用户项目。它不替代真实模型或大型工程验收，不自动触发。

在命令尾追加 `--typescript`，另将现有 TypeScript 的 `tsc.js`、`_tsc.js` 和 `.d.ts` 库准备为合成项目依赖，并为大型编译器正文建立第二个硬链接。主 Runtime 与候选都实际编译一个小 TS 文件，核对命令退出/输出回执、仅私有层的编译产物及持久读依赖；不依赖私有 SDK 注入。它用于验证大型/硬链接只读依赖不会阻断源码发布，仍不覆盖符号链接包布局或任意工程。最新 [编译结果](../../docs/posix-overlay-typescript-results.json) 同时记录重载/续聊和正常关闭后的私有层计数；计数只汇总夹具内各视图的 `st_blocks * 512`，不代表运行峰值或应用总占用。控制 socket 有平台路径长度上限，夹具应采用较短目录名。

## Engine 主流程

`build-runtime-probe.mjs` 现在另生成 `.local/posix-overlay-engine-probe.mjs`。沿用下文显式 namespace 启动命令和独立 `--views`，将 backend 探针路径改为该文件，参数仍为独占夹具根、既有 MXC SDK 入口和当前 POSIX Runtime bundle。运行固定内存模型 → `run_command` → `local_publish` → Engine 排空 → 独立候选 Sandbox → Publisher，报告保存在夹具 `engine-report.json`，包含合成任务事件。无需真实模型或凭据。

基础 Engine 报告为 [Engine 结果](../../docs/posix-overlay-engine-results.json)。在 SDK/bundle 参数后追加 `--http`，走生产 Fastify、AsyncStore Workers、SandboxBroker 和真实 HTTP/CSRF/SSE，验证双会话创建、固定模型任务、候选发布和正常关闭；只指定实验 SDK/bundle 位置，不替换 Broker 或 Runtime 工厂。[HTTP 报告](../../docs/posix-overlay-http-results.json) 已通过。构建脚本同时打包异步 Store 的 host/worker 到忽略的 `.local`。

再追加 `--browser` 会在夹具根写 `browser-ready.json` 并最多保持五分钟，供浏览器打开其中回环地址；核对后创建该夹具根下的空 `browser-done` 文件结束等待。页面由当前 `pnpm build` 产物提供。该模式需要操作者，不能放入默认检查。旧版本人工浏览器持有探针曾停在退出等待并被定点终止；新的不持有 HTTP 探针确认 `closed: true` 和进程正常退出，不把旧现场描述为正常关闭。

`git-policy-probe.mjs` 仅保留历史诊断，用户已要求不再考虑内部建仓库，不继续扩展该矩阵。以下各节描述先前阶段的探针边界，当前产品入口见 [使用指南](../../docs/local-overlay-usage.md)。

## 基础原语

验证内核文件层是否适合 POSIX Local 的低成本私有写入，不开放产品能力，不属于 Evaluation，也不接默认检查/CI。

需要 Linux 原生文件系统、Python 3、可用的非特权 user namespace 和支持 `--overlay` 的 Bubblewrap。本机验证环境为 WSL2/ext4、Bubblewrap 0.11.1；不使用 Windows DrvFS 作为 upper/lower，不安装软件或创建分区。

```powershell
wsl --exec python3 /mnt/g/codeagent/experiments/native-local-overlay/probe.py --files 100000
```

Linux 中将脚本路径替换为当前 checkout 的绝对路径。脚本创建 `~/codeatelier-native-overlay-probes/run-*`，保留报告和私有文件供检查。十万文件均为合成空文件，另外有固定源码和 Git metadata 哨兵；生成它们不计入挂载耗时。

探针比较 0/100,000 个附加文件的三次挂载到 ready 时间，统计已知夹具目录的 inotify OPEN/ACCESS，并检查 upper 中没有复制文件。随后验证两个命名空间的实际并行写入、来源写拒绝、根 `.git` 只读遮罩、正常卸载/重挂载保留 upper，以及独立候选中执行明确提供的合并代码。只遍历很小的 upper 统计分配；4 KiB 空 upper 不代表整个文件系统或进程总成本。

每次只运行固定脚本。Bubblewrap 子进程使用独立 user/mount/PID/network 等命名空间、只读宿主根和私有 overlay；退出即卸载，不向宿主挂载表传播。它不是生产 CodeAtelier Runtime，宿主根可读也不是产品读取 allowlist，不能拿此探针代替正式 Sandbox 验收。

不自动捕获修改基线/读依赖、不执行三方合并或源码发布。支持的实验全过程保持 lower 不变；内核明确不支持挂载期间更改 lower，不能据此承诺 Windows 那样的 live lower。该限制及 Apple 平台核对见 [POSIX Local 方案](../../docs/posix-local-overlay.md)。

## 只读基线层与内核 OverlayFS 组合

`native/linux-local-overlay/readonly-lower.cpp` 只实现按需固定内容的只读 FUSE 文件系统，内核 OverlayFS 仍负责私有写入。`stable-lower-probe.py` 比较 0/100,000 个附加文件的创建计数，检查来源修改后的稳定读取、目录成员、首读过期拒绝及真实 copy-up；正常退出先关闭消费者再卸载 lower。报告保存在 `~/codeatelier-native-overlay-probes/stable-*/report.json`，私有数据不自动删除。

需要 C++20 编译器、匹配已安装 libfuse3 的头文件/库、已有 fusermount3 与可访问 `/dev/fuse`。不要求 `allow_other` 或修改 fuse.conf。本机仅下载并用 dpkg-deb 解包 `libfuse3-dev=3.18.2-1`，未执行系统安装；ABI 库名依发行版核对。以下命令在 Linux shell 中执行，路径按本机 checkout 和已准备依赖替换：

```sh
g++ -std=c++20 -Wall -Wextra -Werror -D_FILE_OFFSET_BITS=64 \
  -I/home/harryshan/codeatelier-native-overlay-probes/deps/fuse3-3.18.2/usr/include \
  /mnt/g/codeagent/native/linux-local-overlay/readonly-lower.cpp \
  -Wl,-l:libfuse3.so.4 -pthread \
  -o /home/harryshan/codeatelier-native-overlay-probes/readonly-lower
python3 -B /mnt/g/codeagent/experiments/native-local-overlay/stable-lower-probe.py \
  --files 100000 \
  --binary /home/harryshan/codeatelier-native-overlay-probes/readonly-lower
```

原型没有持久清单、自动发布或产品 Runtime 集成。首次读取在 ext4 上复制该文件基线，首次查找枚举父目录；创建不扫描不代表构建读取时免费。只读层过滤来源管理目录，但没有限制私有 upper 创建新管理目录。挂载表与报告只能证明本探针正常退出，不证明任意崩溃恢复。详细边界和数值见 [报告](../../docs/posix-stable-lower-results.json) 与 [设计](../../docs/posix-local-overlay.md)。

## 真实 MXC Runtime 联调

`namespace-probe.py` 先验证独立 mount namespace 的 proc-root 路径：直接访问可用，但 realpath 丢失挂载上下文，因此不能直接传给现有 Broker。`sandbox-probe.py` 验证应用专属 user/mount namespace 的替代方案：挂载控制器保留该 namespace 内能力，Broker 子进程通过 setpriv 撤销全部 capabilities，保持普通 UID；两个真实 MXC Runtime 使用普通路径访问各自内核 overlay。

从仓库运行以下构建命令，打包的是当前生产启动器、候选命令执行器、IPC 和 tracing，不复制旧产品源码：

```sh
pnpm exec node experiments/native-local-overlay/build-runtime-probe.mjs
```

需要现有 Linux Node 24/26、MXC SDK 1.0.0、当前 `dist/runtime/posix` 及前述只读 helper。SDK 入口为其实际安装位置；运行前先按常规构建生成并核对 Runtime manifest。本机 WSL 命令如下（不安装依赖）：

```sh
python3 -B /mnt/g/codeagent/experiments/native-local-overlay/sandbox-probe.py \
  --helper /home/harryshan/codeatelier-native-overlay-probes/readonly-lower \
  --node /home/harryshan/codeatelier-mxc-wsl-20261010/node-v24.19.0-linux-x64/bin/node \
  --probe /mnt/g/codeagent/.local/posix-overlay-runtime-probe.mjs \
  --sdk /home/harryshan/codeatelier-mxc-wsl-20261010/app/node_modules/@microsoft/mxc-sdk/dist/v1/index.js \
  --bundle /mnt/g/codeagent/dist/runtime/posix
```

脚本只在 `~/codeatelier-native-overlay-probes/sandbox-*` 合成项目运行，报告和 trace 留在该目录。检查两个命令区间重叠、真实 `linux-bubblewrap` 归因、主目录/另一视图写入拒绝、Git metadata 隐藏、Broker 假秘密不可见、正式终态/clean 清理与零启动标记。普通卸载不使用 lazy/force；宿主挂载表不得出现实验路径。

这次已调用生产 Runtime，但仍不是 Engine/UI/自动发布验收。应用 namespace 启动器、挂载控制协议、异常恢复及基线/候选发布联动未接入产品。实验不修改现有服务启动方式，不扩大为不同任务间完整 OS 安全隔离证明。

## 原生观察清单与生产发布器

重新编译 helper，并运行 `build-runtime-probe.mjs` 后，在上面的 `sandbox-probe.py` 命令中增加：

```sh
--publish-probe /mnt/g/codeagent/.local/posix-overlay-publish-probe.mjs
```

控制器在 Runtime 排空后调用 helper 的 `seal UUID`，清单以 `<UUID>.json` 独占创建并 fsync，包含来源身份、首次观察 stamp、私有基线对象/版本及目录名称/类型。它不复制整个项目，也不把主目录当前正文当成已捕获的旧 B；重复文件名拒绝覆盖。清单只供已控制生命周期的调用方使用，不证明进程已经退出。

`publish-probe.mjs` 用当前 `posix-batch.ts` 和 Publisher 发布两份实际私有结果。通过私有 stdio 请父控制器建立新候选，每次只播种所选源码；真实 MXC Runtime 执行 Python 检查，正常排空后核对候选未改写、导出依赖并卸载，再由 Publisher 写回。第三次 Runtime 修改制造同一行冲突，要求拒绝且原私有内容保留。报告增加 `publication` 段，私有清单、journal、候选产物和 trace 全部保留。

同一探针还保存 B 会话的跨轮状态。A 发布后，B 正常卸载并在新 lower 上保留原 upper；真实 Runtime 继续读到未发布内容，批次仍使用旧 B。B 发布完成后，先保存确认计划，普通卸载并核对源码覆盖摘要后移除，再重挂载；真实 Runtime 读到合并源码且未选产物保留。状态与 `refresh-pending.json` 留作实验记录，不提供异常重放。挂载显式使用 `userxattr,index=off,metacopy=off,redirect_dir=nofollow`。

这仍是受控实验，不是 Engine/UI 自动发布已开放。尚无产品 namespace 启动器或崩溃重挂载；正常刷新只验证已有普通源码文件。捕获正文桥接暂为 2 MiB 单链接文件，历史依赖采用保守并集，未覆盖大型工程读集和目录成员变化后的刷新。未修改选集须保留读依赖，不能用于绕过来源变更检查。具体证据与限制见 [POSIX Local 方案](../../docs/posix-local-overlay.md)。

## 显式 namespace 启动器与 Broker IPC

`native/linux-local-overlay/launcher.py` 已提供可复用启动基础设施；`src/local-overlays/linux-controller.ts` 是正式 Broker 客户端。预装 Python 3、unshare/setpriv/mount、FUSE Runtime 和匹配 helper 后，可在独占 ext4 夹具执行：

```sh
probe_root=$(mktemp -d "$HOME/codeatelier-native-overlay-probes/controller-XXXXXX")
python3 -B /mnt/g/codeagent/native/linux-local-overlay/launcher.py \
  --root "$probe_root/control" \
  --helper "$HOME/codeatelier-native-overlay-probes/readonly-lower" -- \
  "$HOME/codeatelier-mxc-wsl-20261010/node-v24.19.0-linux-x64/bin/node" \
  /mnt/g/codeagent/.local/posix-overlay-controller-probe.mjs "$probe_root" \
  "$HOME/codeatelier-mxc-wsl-20261010/app/node_modules/@microsoft/mxc-sdk/dist/v1/index.js" \
  /mnt/g/codeagent/dist/runtime/posix
```

先运行上述打包脚本生成探针。启动器后面的命令也可使用构建后的 `node dist/server/server/launcher.js --data-dir /absolute/private-data`，同时须指定 `--root /absolute/private-data/local-overlays --views /absolute/private-views`；当前版本在此上下文有效且 Sandbox 已启用时开放 Linux Local UI。控制根须独立于来源、当前 UID 所有、权限 0700，Unix socket 路径须满足系统长度限制；不支持 root 启动或自动安装。

每个视图用 UUID 派生目录，open 前 flush active，明确 close 正常卸载后保存 ready。客户端核对 mount namespace；断线/坏回复/超时不重发，服务未关闭视图即退出则保留 active 并返回失败。正常重新打开新建 lower、保留 upper；它不恢复未知卷，也不生成跨轮 B 或执行发布，这仍由后续 backend 协调。报告见 [控制器验收](../../docs/posix-overlay-controller-results.json)。

## 正式 Service 与 Linux backend

`backend-probe.mjs` 使用正式 LocalOverlayService、SQLite Store、LinuxLocalBackend 和 LinuxCandidateValidator。编译探针后，使用上面的启动器命令并替换以下参数（其余 Node/SDK/bundle 参数不变）：

```sh
--root "$probe_root/data/local-overlays" --views "$probe_root/views"
# Node 的探针入口替换为：
/mnt/g/codeagent/.local/posix-overlay-backend-probe.mjs
```

必须使用新空夹具。`--views` 将实际 workspace 放到 Broker 数据目录之外，不放宽 MXC 对私有数据的重叠检查。两会话通过真实 Runtime 并行编辑，经 Service 选集和排空收尾，各自在全新候选 Sandbox 验证，合并源码后刷新所选覆盖；续轮读取合并源码及未选产物。第三会话验证外部重叠修改导致 rejected、私有修改保留且视图正常关闭。[报告](../../docs/posix-overlay-backend-results.json) 不证明模型/Engine/HTTP/UI 入口已开放。

最新探针使用 Engine 共用平台工厂，B 在 A 发布前先无发布收尾并回收 lower 缓存；再次挂载后使用 round 中旧 B 合并。后续增加三轮真实 Runtime 读取，每轮记录缓存数，断言只有创建时一个空缓存、正文对象为 0；私有产物和原始 B 不丢失。[缓存报告](../../docs/posix-overlay-cache-results.json)。这些数字不包含 upper、round、发布日志或总文件系统分配；未知/旧缓存不自动删除。
