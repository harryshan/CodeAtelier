# Windows Git 配置投影最小验证

该实验只验证 Windows Sandbox 设计中的真实 Git 配置加载机制，不创建账户、不访问网络，也不修改用户的真实 Git 配置。

运行：

```powershell
pwsh -File experiments/windows-git-config-demo/run-demo.ps1
```

探针在仓库 `.local` 下创建临时仓库、逐租约私有 HOME 和 Broker 只读配置投影，使用当前安装的 Git 验证以下顺序：

```text
system -> global-a -> matching includeIf -> global-b -> local -> worktree
```

它还验证私有 HOME 中的 `.gitconfig` 不会在显式 `GIT_CONFIG_GLOBAL` 下被发现，以及 `git config --global` 无法在只读投影目录创建 lock 文件。聚合 config 必须位于 Broker 控制的只读目录，不能放在 Runtime 可写的私有 HOME 中，否则 Runtime 可通过替换文件绕过“只读”。

该结果不证明宿主真实配置图解析器、逐文件 ACL、helper/证书可用性或 Git push；这些属于产品实现与集成验收。
