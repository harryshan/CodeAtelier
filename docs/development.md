# 开发、配置与排错

## 环境与命令

Node.js 24，pnpm 11.22.0（packageManager 固定）。提交 pnpm-lock.yaml，使用 pnpm install --frozen-lockfile 重现依赖。esbuild 的安装脚本在 pnpm-workspace.yaml 中明确允许。

| 命令 | 用途 |
| --- | --- |
| pnpm dev | 后端源码监听，4142 端口；tsx watch 在源码更新后重启后端 |
| pnpm dev:web | Vite 前端，5173 端口；Vite HMR 更新前端模块 |
| pnpm build | 编译后端和前端 |
| pnpm start | 运行构建后的本机服务；由监督进程支持 UI 确认后的后端重载 |
| pnpm typecheck / lint / test | 类型、静态规则、核心测试 |
| pnpm check | 类型、lint、核心测试、生产构建 |
| pnpm test:e2e | 先编译后端和前端，再启动独立模拟服务验证浏览器交互 |
| node --env-file=.env --import tsx scripts/probe-model-capabilities.ts | 检查模型窗口、计数接口及真实 usage（少量模型调用） |
| node --env-file=.env --import tsx scripts/probe-responses.ts | 使用环境变量密钥测试真实服务工具往返 |
| node --env-file=.env --import tsx scripts/smoke-agent.ts | 在 .local 下创建隔离项目，真实模型修复并运行测试 |

脚本只接受环境变量密钥，不内置真实凭据；真实验证会消耗配置服务的模型额度。smoke-agent 只自动批准它自己创建的示例项目内固定 node --test 命令。

## 配置

后端启动时读取本地 .env。无已保存连接配置时，必须在 .env 或环境变量提供 API 地址和模型标识，否则启动明确报错。推荐通过 Web UI 输入密钥或使用环境变量；本地 .env 仅供开发使用，不提交 Git。

| 环境变量 | 默认 / 用途 |
| --- | --- |
| CODEATELIER_BASE_URL | 无默认值；在 .env 填写实际 API Base URL |
| CODEATELIER_MODEL | 无默认值；在 .env 填写服务公布的完整模型标识 |
| CODEATELIER_REASONING_EFFORT | high；可选 low、medium、high |
| CODEATELIER_API_KEY | 无默认值 |
| CODEATELIER_DATA_DIR | 平台用户数据目录 |
| CODEATELIER_PORT | 4142 |
| CODEATELIER_LOG_LEVEL | info |

非敏感设置保存为 settings.json。已保存设置优先于环境变量默认值；通过 UI 修改。密钥始终来自环境或当前进程内存，不写 settings.json。任务运行时禁止修改配置。

思考等级在“模型与设置”中选择，保存为 reasoningEffort，每次 Responses 请求显式发送 reasoning.effort，主任务和上下文摘要共用。默认 high，旧配置缺少字段时采用环境默认值或 high。例如 .env 中设置 CODEATELIER_REASONING_EFFORT=high；已保存设置优先，保存后用于后续调用。服务或模型不支持所选等级时按现有错误流程报告，不静默降级。

默认限制：100 次模型调用、命令 120 秒、模型请求总计 300 秒、流空闲 60 秒、上下文 180000 字符、单工具输出 32000 字符。这是可配置字符预算，不是精确 token 计量。发现服务容量和支持的 tokenizer 后改用 token 预算，contextChars 仅备用；maxOutputTokens 默认 16384。输入预算扣除输出与安全余量后，达到 80% 时尝试压缩至 60% 以内。失败保留原历史，超过硬上限则停止。实测值和用量展示见 [model-tokens.md](model-tokens.md)。详见 [上下文管理](context-management.md)。高级字段可在停机时编辑 settings.json 或通过设置 API 更新。

## 数据与日志

- Windows：%LOCALAPPDATA%/CodeAtelier
- macOS：~/Library/Application Support/CodeAtelier
- Linux：$XDG_DATA_HOME/CodeAtelier，未设置则 ~/.local/share/CodeAtelier

目录包含 history.sqlite（及 SQLite WAL 文件）、settings.json、logs/app.log。历史会话与运行日志分开保存，不写入用户代码项目。

日志支持 trace/debug/info/warn/error，默认 info。文件和终端均为紧凑纯文本，例如 `2026-09-15T12:00:00.000Z INFO  agent task.started | session=… task=…`，不输出 JSON；固定的应用、进程和主机字段不重复写入。任务日志带 sessionId/taskId，工具日志包含 toolCallId、耗时和成功状态。错误记录保留脱敏且限长的名称、消息、受控错误码/状态、原因链和堆栈，不能只写 errorName；模型服务响应正文、完整源码、提示词和原始响应仍不记录。日志按约 10 MiB 轮转，共最多 5 个文件；DEBUG 可查看模型步骤。已知密钥和认证信息在格式化前脱敏。

## 代码阅读策略

模型应先用 `list_files` 了解目录，再用 `search` 按符号名、错误文本、测试名或配置键定位；搜索结果含命中行号，随后用 `read_file` 围绕命中行读取。普通代码定位默认从 80～200 行开始，只在上下文不足时继续扩展；短文件、`AGENTS.md` 或确有全局分析需要时才读取完整文件。同一任务内复用已读取范围及成功修改后的已知内容，无须每次编辑前重复读取；新任务必须重新读取，外部变化、编辑冲突或上下文不足时也须重新读取。

`read_file` 必须提供 `startLine` 和 `endLine`，每次最多返回 500 行。结果的 `returnedEndLine` 表示实际最后一行，`truncated` 表示请求因行数上限未完整返回，`hasMore` 表示文件后面还有行，`nextStartLine` 给出继续读取的位置（没有后续行时为 `null`）。执行器当前为检查 UTF-8、二进制、行数和编辑前的内容哈希，仍会在后端读取不超过 2 MiB 的整个文件；行范围限制的是发送给模型和保存到会话的文本，不承诺同等粒度的磁盘 I/O。

模型已被要求在信息充分且操作互不依赖时，在一次 Responses 请求中返回多个工具调用，例如不同文件的读取、搜索或已读取文件的精确编辑。请求显式发送 `parallel_tool_calls: true`；这只是服务端的调用批次偏好，本机仍按模型返回顺序逐项校验、审批和执行。所有已有文件的精确修改均使用一个 `edit_files` 调用：同一路径的多处修改合并在一个文件条目，不同文件的独立修改合入同一个调用；单文件也使用一个文件条目。对于命令，模型应把可预先审批的顺序步骤、管道和安全的独立检查合入一条 `run_command` 文本；只有需要前一步结果或新的审批时才拆分，不为凑批次扩大范围。

`run_command` 的模型参数只有 `{ command }`，工作目录固定为会话工作区。服务内部在 Windows 检查 `PATH`、`SystemRoot` 和 `ComSpec`，按 `pwsh`、`powershell`、`cmd.exe` 的优先级选择第一个真实存在的 shell；macOS 和 Linux 使用已验证的 `/bin/sh`。执行器追加固定的非交互参数（PowerShell 为 `-NoLogo -NoProfile -NonInteractive -Command`，cmd 为 `/d /s /c`，POSIX shell 为 `-c`），模型既不提供也不探测这些细节。完整复合命令仍作为一次副作用审批；不要求或保存命令间的人工分隔标记。

命令每次流式输出都以工具调用 ID 保存。Web UI 将开始、所有输出分块和退出状态聚合在同一可展开命令卡片中，任务完成或刷新历史后仍可查看。

`edit_files` 是唯一的精确编辑工具，参数为 `{ files: [{ path, edits: [{ oldText, newText, startLine, endLine }] }] }`；一次编辑 1～20 个已有文件，每个文件条目接受 1～100 项修改，重复的真实路径会拒绝。单文件修改同样使用一个文件条目。新文件仍使用 `write_file`。原文和修改后文件各不超过 2 MiB，整批原文与结果合计不超过 16 MiB。

该工具的每项修改都基于**调用前的原始文件快照**，不能引用同一调用前项生成的新文本。可不使用行号（模型 strict 协议显式传 `startLine: null, endLine: null`；本地旧调用省略时默认 null），此时 `oldText` 必须在原文中精确匹配一次，包括重叠出现也视为歧义。提供行号时必须同时提供两个正整数，以 1 起算、首尾均包含；行号只限定搜索范围（包含末行换行符），`oldText` 可为行内片段或跨行片段，但必须完整位于范围内且精确匹配一次。仅替换匹配片段，保留周围内容。空白和换行（包括 CRLF）仍须逐字一致，不包含读取结果显示的行号前缀。未匹配或匹配多处时明确拒绝，不向范围外搜索，不做模糊匹配或自动修正行号。重叠区间拒绝；从后向前应用已定位区间，因此插入行不会移动其他修改的位置。

多文件工具先完成全部路径审批、读取哈希和编辑校验，再复核所有快照，随后逐文件写入。每次写入前也复核路径和正文，成功后更新读取哈希并发出 diff。预检失败不写任何文件；实际写入期间失败或取消，保留已完成文件，不回滚、不自动重放。返回逐文件状态：`written` 已写入、`not_attempted` 未开始、`unknown` 曾进入写入阶段但结果需核实。历史 `edit_progress` 在写入前记录 unknown，成功后记录 written，UI 合并显示最新状态；进程崩溃后必须结合当前文件核实。跨文件没有事务保证，权限/路径复核也不是操作系统级沙箱。

示例：

```json
{
  "files": [
    { "path": "src/a.ts", "edits": [{ "oldText": "1", "newText": "2", "startLine": 1, "endLine": 1 }] },
    { "path": "src/b.ts", "edits": [{ "oldText": "oldName", "newText": "newName", "startLine": null, "endLine": null }] }
  ]
}
```

旧历史参数保留展示，不重放旧工具调用。

## 权限交互

普通工作区文件操作自动执行。工作区外访问、敏感文件、修改 AGENTS.md、完整覆盖已有文件需确认；直接修改 .git 被拒绝。外部读取当前采用逐次确认，尚未提供额外只读目录授权管理界面。

命令均首次确认；简单的 `pnpm`/`npm` test/build/lint/typecheck 或 `node --test` 在可计算项目指纹时可授予本次会话重复执行。包含更多 shell 语法的命令不支持会话放行，仍按单次审批处理。执行器内部选择 shell，不改变命令的权限边界；直接 Git 程序名（包括复合命令中的 Git）和提权命令会在审批前拒绝。子进程环境设置 `NO_COLOR=1`、`FORCE_COLOR=0`、`CLICOLOR=0`、`CLICOLOR_FORCE=0` 和 `TERM=dumb` 请求工具禁用颜色；执行器还会跨输出分块移除 ANSI、OSC 等控制序列，只保存、展示和回传纯文本。没有系统沙箱、回滚或提权工具。请只操作可信项目。

Git 不经 `run_command` 执行，而使用单一 `git` 工具；模型可以主动调用允许的 action，不等待人工审批。`status`、`diff`、`log`、`show`、`branch` 只读；`add`、`commit`、`push` 会写入索引、仓库或已配置远程。`diff` 显式传 `staged`、`paths` 和 `contextLines`，空 paths 的全量差异先列出全部变更路径并拒绝敏感内容；`log` 传安全 revision、paths 与 limit；`show` 必须传安全 revision 和明确 paths；`add`/`commit` 必须传明确 paths，commit 另传非空 message；`push` 没有额外参数。

每次调用先确认会话工作区恰好是非 bare Git worktree 根目录。所有路径必须为非选项式的相对路径，解析真实位置后仍在工作区，且不含 `.git`、敏感组件或敏感目录后代；revision 仅接受保守的分支、标签或提交哈希字符。Git 固定禁用 hooks、GPG 签名、外部 diff/textconv、交互认证提示、分页和编辑器。push 从当前分支配置读取唯一 remote 与 `refs/heads/*` upstream，拒绝本地、`ext::` 及其他非 HTTPS/SSH/SCP 风格地址，并以显式 refspec 推送，不接受 remote、branch、force 或其他选项。应用层校验不等于操作系统沙箱，可信项目中的 Git clean filter 等仓库配置仍可能以当前用户权限运行。add、commit 或 push 中断时结果可能未知，恢复前必须用 status/diff/log 重新检查，不自动重放。

## 常见问题

- 模型返回“不支持 Responses”：核对服务公布的完整模型标识；配置原样传递，不自动转换简称。
- 请求结束但无结果：检查服务是否发送完成事件。适配器支持从 output_item.done 收集结果。
- 找不到 Windows shell：服务会按 `pwsh`、`powershell`、`cmd.exe` 检查环境；若三者均不可用，`run_command` 会明确失败。模型无需也不得提供、探测或回退 shell；使用内部检测到的 `cmd.exe` 运行 pnpm 的 `.cmd` 脚本仍按单次审批处理。
- 文件已变化：重新读取后再编辑；不要关闭并发修改检测。
- 刷新后需要重新认证：服务重启会轮换本机会话 token，刷新页面。
- 任务中断：在会话底部点击“恢复任务”，可先填写恢复说明。密钥或模型配置错误先到设置修正，超时可调整模型请求/空闲超时。模型自动重试记录 model.retry（含步骤、尝试次数、错误分类、HTTP 状态、等待时间）；耗尽后保留失败状态。详见 [恢复机制](recovery.md)。
- 数据目录不可写：先检查该目录所有权和 ACL，或使用 CODEATELIER_DATA_DIR 指定可写目录；不要扩大系统目录权限。
- 端口占用：用 CODEATELIER_PORT 指定其他端口；开发时也同步修改 Vite 代理地址。

## 贡献流程

按职责划分文件，保持 strict 类型检查；协议边界的动态结构应由 schema 验证。变更前读 AGENTS.md 与需求文档。核心行为修改添加对应行为测试，纯文档不写形式化测试。每个独立可验证增量创建 commit，同步更新文档；隔一段时间批量 push。

CI 使用 GitHub 托管的 Windows、Linux、macOS runner 执行 pnpm check，Linux Chromium 执行 UI 验收。测试不需要真实 API key；真实服务 smoke 手动运行。

## 开发中的测试要求

所有功能开发必须配套合理的单元/回归测试。每个可验证增量后运行相关测试，修复缺陷先复现再修正，提交前运行 pnpm check；涉及 UI、API 或 SSE 的变更还需 pnpm test:e2e。测试分层、运行命令、功能覆盖与限制见 [testing.md](testing.md)。

## 服务退出

Web 侧栏的“关闭服务”需确认。`POST /api/server/shutdown` 接受 `{ "confirm": true }`，沿用 cookie/token 校验。关闭期间拒绝新业务请求，先停止模型/命令并记录任务中断，响应确认后关闭 SSE、HTTP 和 SQLite。请求方提前断开时仍继续清理。生命周期关闭操作幂等；日志事件为 server.stopping/server.stopped，异常为 server.shutdown_failed。

`Ctrl+C`、SIGTERM 调用同一个 shutdown。开发模式还需退出 tsx watch 监视器时，在启动终端按 Ctrl+C。

## 开发服务重载

`pnpm start` 先运行常驻的 `launcher.ts`，它 fork 实际提供 HTTP 服务的子进程。侧栏的“重载服务”必须在确认框选择“确认重载服务”，随后以与关闭相同的任务中断持久化和资源清理流程停止旧子进程；旧进程通过固定 IPC 请求 launcher 在端口释放后 fork 新子进程。UI 通过新生成的本机会话 token 确认替代服务已监听，才完整刷新页面。请求沿用 cookie/token 与 `{ "confirm": true }` 校验；无监督启动时接口返回 409，不自行生成游离进程。重载保留历史和已修改文件，但当前任务须从恢复入口继续。

重载只重新执行已有构建产物，不会编译源码。生产模式修改后先执行 `pnpm build`，再点击入口即可替换 `pnpm start` 当前的服务；若服务已经关闭仍须在终端重新运行 `pnpm start`。同时运行 `pnpm dev` 和 `pnpm dev:web` 时，tsx watch 负责后端源码变化后的进程重启，Vite HMR 负责前端模块更新；重载入口可在需要完整重建本机会话时使用。

## 代码阅读与审核

可读性是长期交付要求，见 [code-style.md](code-style.md)。运行 `pnpm format` 统一格式，`pnpm format:check` 只检查不修改。`pnpm check` 已包含格式检查；源码、测试、脚本和根目录工具配置一并检查。段落、命名与关键原因注释仍需要人工审核。

## 自举开发验证

`pnpm exec tsx scripts/bootstrap-agent.ts --prepare-only` 只准备隔离源码副本并复现缺陷；移除该参数后使用环境变量密钥执行真实模型任务。数据发送范围、审批限制和证据判定见 [bootstrap.md](bootstrap.md)。

结构化事件和工具结果先解析 JSON，对字段值脱敏后重新序列化；不直接用正则替换 JSON 转义文本。Pino 内部记录同样先按字段脱敏，再格式化为纯文本日志；格式化后的诊断文字继续通过统一脱敏函数处理。

## 可选低成本辅助模型

设置界面提供“辅助模型（低成本，可选）”与“辅助模型推理强度”；保存后重启仍保留。也可在本地 `.env` 设置（模型 ID 为占位值，须替换为服务实际提供的 ID）：

```dotenv
CODEATELIER_AUXILIARY_MODEL=your-low-cost-model-id
CODEATELIER_AUXILIARY_REASONING_EFFORT=low
```

辅助模型共用主模型的 API 地址与密钥，默认不指定模型；空值沿用主模型及其思考等级。已保存设置优先于环境默认值，在 UI 清空即可恢复沿用。推理强度可选 low/medium/high，指定辅助模型时默认 low；程序不推断价格或自动选择模型。

上下文摘要和首条用户 prompt 的标题生成均使用 `auxiliarySettings`：创建会话后先显示“新对话”，Engine 对首条消息发起无工具、64 token 上限的标题请求，成功后通过 SSE 更新侧栏；失败保留占位标题而不阻断编码任务，取消会中止任务。工具审批仍遵守规则和人工确认，未启用模型自动授权。配置不意味着服务兼容性已经实测。


### Git 模型参数兼容性

模型侧 `git` 参数采用 `{ "request": { "action": "status" } }`，其他 action 的字段也放在 request 内。根节点为严格 object，request 使用嵌套 anyOf；避免服务拒绝根级 oneOf。执行前严格验证各 action 字段，再解包交给原 Git 执行器；历史扁平参数继续受原校验约束。tool-schema.test.ts 覆盖根节点、oneOf 禁用、包装解包、历史兼容和额外/非法字段拒绝。
