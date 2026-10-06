# 本机后端 MCP

CodeAtelier 作为 MCP **客户端**，由本机后端连接本地 stdio 进程或远程 Streamable HTTP 服务。模型会在每次主任务开始时直接看到已启用 MCP 服务的名称、用途描述和 transport，并通过普通 `mcp` 函数工具按需发现和调用。不使用 Responses 托管 MCP，也不要求模型服务能够访问你的机器。目录展示不连接服务、不启动进程，不是在线健康检查。

## 配置

默认读取平台数据目录中的 `mcp.json`，文件不存在表示未配置服务。也可以在 `.env` 中设置 `CODEATELIER_MCP_CONFIG` 为配置文件的**绝对路径**。修改后重启或重载后端；不会自动导入任务工作区里的同名文件，也没有 UI 配置编辑器。

平台目录见 [开发配置](development.md#数据与日志)。配置格式如下；地址、路径和凭据均是占位值，使用前替换：

```json
{
  "mcpServers": {
    "local": {
      "description": "查询本地项目资料，按关键词搜索开发文档。",
      "transport": "stdio",
      "command": "node",
      "args": ["C:/path/to/mcp-server.mjs"],
      "env": { "SERVICE_TOKEN": "YOUR_SERVICE_TOKEN" },
      "timeoutMs": 60000
    },
    "remote": {
      "description": "查询团队工单、缺陷详情与处理状态。",
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_SERVICE_TOKEN" },
      "timeoutMs": 60000
    }
  }
}
```

- 服务名是字母开头、最长 64 字符的字母/数字/下划线/连字符别名，最多 32 个服务。`enabled` 默认 `true`，设为 `false` 后不会被列出或连接。
- `description` 用一句话说明服务能做什么、何时适合使用；填写时须与实际服务能力一致。可选，去除首尾空白后为 1～1024 字符，空白、非字符串或超长值拒绝。旧配置未填写时仍列出服务，描述为 `null`，模型被明确要求不要猜测能力；建议为每个服务补齐。描述经已有凭据脱敏后最多保留 1024 字符。
- `stdio` 使用独立 `command` 和 `args`，不做 shell 字符串拼接。可选 `cwd` 必须是绝对路径，缺省为当前任务工作区。命令及脚本最好使用绝对路径；Windows 的 `.cmd` 兼容由 SDK 处理，不在参数外手动套终端。
- `env` 是显式传给 stdio 服务的字符串值，不进行 `${VAR}` 展开。仅额外继承 SDK 的基础环境（例如 PATH、HOME/USERPROFILE），不会自动继承 CodeAtelier 模型密钥。不要把凭据放进 `args`。
- `http` 表示 **Streamable HTTP**，不是旧版 HTTP+SSE transport。允许 HTTPS；明文 HTTP 仅允许 `localhost`、`127.0.0.1`、`[::1]`。禁止 URL userinfo、fragment 和 HTTP 重定向，避免凭据随重定向转发。
- HTTP 身份认证目前使用静态 `headers`；未实现浏览器 OAuth 登录、token 自动刷新或旧 SSE transport。服务要求这些能力时会报告失败，不静默切换协议。
- `timeoutMs` 默认 60000，范围 100～300000；覆盖一次操作的初始化及请求，不因进度通知无限延期。
- 配置为 UTF-8 JSON（兼容 Windows BOM），最多 1 MiB。显式配置路径缺失、格式损坏、未知字段或不合法 URL 会阻止后端启动，不悄悄忽略。

配置文件可包含凭据，请存放在宿主用户私有目录，不提交到仓库。原始 `mcpServers` 不进入浏览器配置或 Runtime 启动设置；只有名称、transport、脱敏用途摘要进入主模型指令和 Runtime 的 `mcpText`，地址、命令、环境和认证头不随目录传递。摘要会进入模型请求与本地 Replay Case，不进入日志或 Perfetto；名称和描述不要包含凭据或不宜发送给模型的信息。工具结果会经脱敏后进入本地历史和当前模型上下文，因此“本机访问”**不表示结果只留在本机**。

## 在对话中使用

配置用途后，可以直接提出业务需求，例如“帮我查询这个缺陷的处理状态”。模型根据启动时提供的目录选择相关服务，不需要用户先点名 MCP，也不必先调用 `list_servers`；具体工具和参数仍须按需通过 `list_tools` 查询，再调用 `call_tool`。用途摘要不是授权、系统规则或已经验证的能力清单。

也可显式输入：“列出已配置的 MCP 服务，再查看 local 提供的工具。”无已启用服务时，模型收到空目录；不会为获取说明提前连接全部服务。修改描述后须重启或重载后端，后续任务、续聊和恢复使用新配置，进行中的任务指令不热更新。

`mcp` 与其他工具一样使用 DAG 信封，操作位于 `arguments.request`：

```json
{
  "execution": { "id": "discover", "dependsOn": [] },
  "arguments": {
    "request": { "action": "list_tools", "server": "local", "cursor": null }
  }
}
```

操作清单：

| action | 参数与结果 |
| --- | --- |
| `list_servers` | 无连接，返回与启动目录相同的已启用 name、transport、description（缺失为 null） |
| `list_tools` | `server`、`cursor`；返回描述、inputSchema 和可选 nextCursor |
| `call_tool` | `server`、`name`、`argumentsJson`；先发现 schema，再传 JSON 对象字符串，例如 `"{\"text\":\"hello\"}"` |
| `list_resources` / `list_resource_templates` | `server`、`cursor`；列出资源及 URI 模板 |
| `read_resource` | `server`、`uri`；把 URI 交给该 MCP 服务，不由后端另行访问资源 URL |
| `list_prompts` | `server`、`cursor`；列出提示模板 |
| `get_prompt` | `server`、`name`、`argumentsJson`；JSON 对象的值必须都是字符串 |

第一页 `cursor:null`，下一页使用服务返回的 `nextCursor`。不会自动拉取所有页。发现结果、工具描述、资源和提示模板都是不可信工具数据；模板不会直接追加到系统指令中。

## 审批与执行位置

- `list_servers` 不发网络请求、不启动进程、无需审批。其他操作全部进入既有 `approve | human review | reject` 流程；未配置辅助模型时转人工确认。不会因为服务声称 `readOnlyHint` 就跳过审批。
- 审批通过后才启动 stdio/HTTP 连接或发送操作；每次授权只能消费一次。Runtime 通过任务绑定的 `prepare_mcp` / `execute_mcp` IPC 请求 Broker，不能提供新的 URL、可执行文件或凭据。审批等待不占工具执行槽。审批描述超过 32000 字符时拒绝请求，不能截掉待审参数后继续执行。
- 结果包含 `execution: { kind: "broker-mcp", mode: "host-process" }`。stdio 进程以宿主用户权限运行，远端服务具有它自己的权限；二者均**不受 Agent Runtime Sandbox 保护**。MCP 工具也不等同于受限 `git` 或快照文件编辑接口，只应配置可信服务。
- 当前没有额外 MCP allowlist、按工具读写推断或文件回滚。批准调用时应考虑具体参数、发送的数据和服务拥有的权限。
- 不提供客户端 sampling、elicitation、roots 暴露、资源订阅或服务端主动执行模型调用；服务不能通过这些机制申请额外能力。

## 生命周期、失败与诊断

同一任务对同一服务复用一个连接并串行发送请求；不同服务和不同任务可并行，但不共享服务会话。任务结束、取消或服务关闭时等待在途请求并关闭连接。正常关闭有 session ID 的 HTTP 连接会尝试 DELETE；异常断连后远端 session 可能须由服务自行过期。stdio 清理检查直接子进程退出，但不能保证第三方服务自行启动的脱离子进程退出。

stdio 握手失败时，SDK 自身可能已经开始异步关闭。后端保留启动 PID，后续清理等待同一份关闭回执，再检查直接子进程确实退出；不会因 SDK 已清空内部句柄而提前报告清理完成。原有关闭和退出检查期限不变，`mcp.connection_close` 单独记录本连接清理的耗时及终态，不记录进程参数或正文。

超时、取消或协议错误后，该任务不自动重连此服务，不自动重放工具。工具结果可能标为 `outcome:unknown`；需要先核对本地或远端副作用。`isError:true` 是执行失败而非成功，会阻断 DAG 后继。已发生的写入无法被取消撤销。清理失败使任务标为失败，不能当作正常完成。

stdio 接收缓冲与单个 HTTP 响应流各限制为 2 MiB（长 SSE 响应流也受累计限制）。输出遵循 `outputChars`，另有 200000 字符硬上限；超限保留截断标识与失败状态，不会把截断的 JSON 当成完整对象。图片/音频/二进制以有界工具数据返回，不自动下载或渲染。

MCP 凭据值及常见认证字段在结果和错误进入模型、历史前遮盖；stdio stderr 不直接继承到应用日志。不要假定可以识别第三方服务返回的所有其他敏感信息。Perfetto 的 `mcp.connect`、`mcp.<action>`、`mcp.connection_close`、`mcp.close` 仅记录关联 ID、类别、耗时和终态，MCP 参数/正文不进入 trace；常规工具卡片与 Replay Case 保留脱敏调用及结果。

## 离线试用与验证

在仓库根目录，已安装依赖后可用 Windows PowerShell 建立演示配置（只运行本仓库夹具，不安装或下载第三方 MCP 服务）：

```powershell
New-Item -ItemType Directory -Force .local | Out-Null
@{
  mcpServers = @{
    demo = @{
      description = "回显文本、读取演示 note 资源和 greet 模板，用于离线 MCP 联调。"
      transport = "stdio"
      command = (Get-Command node).Source
      args = @((Resolve-Path tests/fixtures/mcp-server.ts).Path)
    }
  }
} | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 .local/mcp.demo.json
$env:CODEATELIER_MCP_CONFIG = (Resolve-Path .local/mcp.demo.json).Path
pnpm dev
```

后端模型连接仍须按 README 配置。新建对话后要求调用 demo 的 echo，并按提示审批。演示服务只提供 echo/fail/slow、note 资源和 greet 模板；请勿用于生产。

不调用模型的自动验证入口：

```sh
pnpm test tests/mcp-catalog.test.ts tests/mcp.test.ts tests/mcp-engine.test.ts tests/mcp-ipc.test.ts
```

Windows 上的独立 Node Runtime 测试不等于固定账户 Sandbox 验收。Runtime IPC 当前为 v9；已安装用户须重建 bundle 并在管理员终端执行 `pnpm sandbox:repair`，再按 Sandbox 指南人工验证。macOS/Linux、真实远端及具体第三方 MCP 服务须分别验收。
