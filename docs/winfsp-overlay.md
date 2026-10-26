# 自研 WinFsp Local overlay

当前 Windows 文件系统基于 WinFsp 原生 API 自研，不依赖 Riftri，不管理 Git branch/index/objects。整个隔离 Local 产品功能由 `src/local-overlays/readiness.ts` 的 `LOCAL_OVERLAY_ENABLED = false` 默认关闭；创建、任务、发布、检查与恢复入口均受控。普通 Local 和 Git worktree 不依赖 WinFsp。

## 文件与持久化

来源目录是实时只读 lower，每会话使用私有 upper。按访问导入元数据，首次修改记录基线并 copy-up；SQLite v6 保存名称、ACL、对象、观察代次、删除标记与恢复凭据。创建不遍历或复制项目树；首次读取/枚举以及修改大文件仍有成本。

所有层级屏蔽来源 `.git`；不是 Git 命令关键词过滤，也不授权读取外部 Git 路径。选择源码后在独立候选视图和 Sandbox 验证，排空后按来源串行发布；冲突、验证失败和未知结果保留私有修改。具体协议见 [设计](local-overlay-design.md) 和 [使用指南](local-overlay-usage.md)。

`src/local-overlays/winfsp-manager.ts` 管理长驻 helper、策略收据、冻结、代次、确认和正常卸载；`native/winfsp-overlay` 实现文件系统与原生发布/租约。只接受 Local 和根 ACL 专用恢复模式，旧 live/Git-tree 挂载命令已移除。异常关闭不清 dirty，不自动重建或回放。

## Sandbox 与限制

挂载采用跨账户可见的本机 UNC。任务只授予虚拟工作根，来源文件和私有控制目录不作为可写根；文件 DACL 在虚拟卷处理，遵循现行 Sandbox 的账户、token 和任务间隔离限制。此方案不承诺任务间完整 OS 安全隔离。

`restore-local-security` 只暴露已知旧 Local 卷的根身份/DACL，供启动排空账户后的授权撤销；禁止普通文件 I/O、枚举与改名，不清除任务锁、dirty 或旧执行证明。功能开关关闭也保留必要的旧授权清理。

支持 owner/group、DACL 拒绝/继承/保护；不宣称完整 NTFS 等价：SACL/审计/完整性标签写入、ADS、EFS、创建硬链接和 lower 外部通知不在当前能力内。仅 Windows x64 已有实机证据；UNC 不支持的程序需要另行处理。原生格式与源码须一起重建，不自动安装驱动或升级运行服务。

## 显式构建

```powershell
pnpm overlay:build-winfsp -Sdk '<WinFsp SDK 绝对目录>' -VerifyReparse -VerifyImport
```

SDK 须包含 `inc/winfsp`、`lib/winfsp-x64.lib` 与 `License.txt`，需要 MSVC x64。产物为 `dist/native/win32-x64/codeatelier-overlay.exe`；默认 build/check 不下载 SDK、不安装驱动。解析/导入回归不挂载，真实挂载可手动运行 `pnpm overlay:verify-filesystem` 与其它 Local 专项脚本，见 [覆盖清单](testing.md)。产品门禁仍默认关闭，不以手动 helper 实验视为已开放。

## 依赖、许可与当前环境

既有验证使用 WinFsp 2.1.25156；用户曾明确授权官方 Runtime 安装。SDK 本机材料位于 `.local/winfsp-sdk`，此次清理不安装、卸载或更新系统驱动，不创建分区。

WinFsp 的 GPLv3/FLOSS 例外及商业许可条件仍独立适用；移除 Riftri 不改变它的许可，也不为 CodeAtelier 自动选择分发许可证。既有依赖记录与许可原文：[WinFsp 许可证](https://github.com/winfsp/winfsp/blob/master/License.txt)、[Native API](https://winfsp.dev/doc/WinFsp-API-winfsp.h/)。
