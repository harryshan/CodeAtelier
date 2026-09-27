# CodeAtelier

本机浏览器中的个人 coding agent。使用 TypeScript，自研 agent 循环、上下文管理和工具调度，通过用户自建 Responses API 服务完成代码阅读、修改与验证。

## 快速开始

需要 Node.js 24 和 pnpm 11.22.0。

1. 复制 `.env.example` 为 `.env`，填写 API 地址、完整模型标识和密钥。
2. 在仓库目录安装、构建并启动：

   ```sh
   pnpm install --frozen-lockfile
   pnpm build
   pnpm start
   ```

3. 打开 [http://127.0.0.1:4142](http://127.0.0.1:4142)，在“模型与设置”确认配置，再新建会话并输入本机项目目录。

API 地址与主、辅助模型标识只从启动环境读取，修改 `.env` 后须重启或重载服务。`settings.json` 保存思考等级、超时等偏好；UI 输入的 API key 只保留在后端内存。不要提交 `.env`、密钥或访问密码。

## 可以做什么

- **读写与验证**：通过命令浏览和搜索代码，按行读取文件，使用 `edit_files` 批量新建或精确修改文件，再运行构建和测试。
- **Git**：通过单一受限工具查看状态、差异、历史、文件和分支，暂存、提交指定路径，并推送当前分支已校验的 upstream。
- **公开网页检索**：通过 Responses 内置 `web_search` 查询并显示来源；需要正文时，在命令与网络权限范围内使用 `curl`。
- **会话与恢复**：支持流式回复、Markdown 输入和显示、历史持久化、自动标题及人工恢复。未知工具结果不会自动重放。
- **上下文与项目记忆**：自动管理上下文预算和压缩；按真实项目目录检索 Markdown 记忆，模型可在任务内维护条目。记忆管理 UI 尚未实现。
- **诊断**：提供分级日志、会话统计、Perfetto 时间线和受保护的本地 Replay Case。

不同工作目录默认最多同时运行 2 个任务，可调为 1～4；同一目录始终串行。修改直接写入选定工作区，取消或失败不会撤销已发生的修改。

## 访问与执行边界

默认只监听回环地址。需要受信任局域网访问时，将 `CODEATELIER_LISTEN_ADDRESS` 显式设为 `0.0.0.0` 或 `::`，使用本机局域网 IP 访问。

默认任何能访问服务地址的设备都可以使用本机 agent。可通过 `CODEATELIER_WEB_PASSWORD_ENABLED=true` 和非空 `CODEATELIER_WEB_PASSWORD` 开启共享密码门禁；它不提供多用户账户、角色或公网安全保证。

宿主模式下，需要审批的操作先由已配置的辅助模型分为通过、人工确认或拒绝；模型不可用时转人工确认。获准命令以本机用户权限运行，适用于可信项目。

Windows 专用用户 Sandbox 默认关闭，需要管理员安装。当前 Windows 主机上的模拟模型产品链路、普通命令、Broker Git、主动取消和正常清理已通过；复杂 ACL、真实远端 push、强制终止和重启恢复仍待验收。Runtime token 为 Windows 兼容包含 Everyone restricting SID，因此不承诺完整文件写入 allowlist。macOS/Linux 使用宿主路径。试用前阅读 [Sandbox 使用指南](docs/windows-sandbox-guide.md)；实现与验证范围见 [Sandbox 架构](docs/windows-integrity-sandbox.md) 和 [验证记录](docs/verification.md)。

## 开发与验证

```sh
pnpm dev
# 另一个终端
pnpm dev:web
```

开发界面为 [http://127.0.0.1:5173](http://127.0.0.1:5173)。后端由 `tsx watch` 监视源码，前端由 Vite 更新。

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
```

Evaluation 仅在用户明确需要时手动运行，不进入默认测试或 CI。详细约定见 [测试说明](docs/testing.md) 与 [AGENTS.md](AGENTS.md)。

## 重载与关闭服务

在侧栏选择 **重载服务 → 确认重载服务**，会停止任务、保存可恢复中断并替换后端进程，随后刷新页面。生产模式修改源码后需先 `pnpm build`；重载只加载现有构建产物。

选择 **关闭服务 → 确认关闭服务**，或在终端按 `Ctrl+C`，会停止任务并释放服务资源。历史和已修改文件保留；再次运行 `pnpm start` 后刷新页面即可继续使用。开发模式退出文件监视器仍需在终端按 `Ctrl+C`。

## 文档入口

- [文档导航](docs/README.md)：按使用、开发、专题和历史记录查找。
- [需求与范围](docs/requirements.md)：已确认的产品边界和验收标准。
- [架构](docs/architecture.md)：模块职责和任务数据流。
- [开发、配置与排错](docs/development.md)：配置项、工具契约与诊断方式。
- [测试约定](docs/testing.md) / [验证记录](docs/verification.md)：如何验证与已经验证的证据。
