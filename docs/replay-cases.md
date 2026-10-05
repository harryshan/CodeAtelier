# 任务 Replay Case

任务 replay case 用于把一次已保存的 CodeAtelier 任务转为本地、可审计的改进测试材料。它不是产品中的恢复机制：恢复面对真实当前工作区且绝不盲目重放副作用；replay case 则保存 agent 当时看见的模型和工具材料，供开发者在**隔离环境**中重放、比较或建立回归测试。

## 能力与边界

每个新任务开始时会在本机 SQLite 历史中逐次保存；任务元数据保存在 `task_replays`，各模型与工具条目在 `replay_entries` 单独增量写入，结束时只更新相应条目而不重写整份任务 JSON。模型 input 按相邻请求的相同前缀长度与新尾部存储，导出时恢复完整 input（每次请求依然保留原始观察语义）。旧任务的整条 JSON 原样可读，不在迁移时改写：

- 任务、会话和影响执行的非连接设置；不保存 API key 或 API 地址；
- 每次模型请求的完整 input、instructions、工具定义和输出上限，以及成功响应或受控错误；请求先保存，因此崩溃中的请求会明确缺少终态；
- 工具 DAG 节点的完整脱敏参数和结果；这与 UI/上下文的输出截断分离；
- `read_file` 的全文版本哈希、已返回行和 `edit_files` 的 `fileVersion`，用于判断能否重建编辑前文件。

这些资料可能包含用户 prompt、源码、路径、命令和工具输出。未来 sandbox 经授权由 Broker 读取的工作区外文件内容，以及相应工具结果和后续模型请求材料，也允许进入 Replay Case；不因来源在工作区外而额外排除。它们只保存在受保护的本地数据目录；不得上传、共享给不受信任方或提交到 Git。凭据仍按现有 JSON 脱敏规则处理，但 case 不是面向公网或多人环境的安全存储。外部读取的审批界面必须提示这些内容可被本地捕获并手动导出。

Perfetto trace 仍只用于性能诊断，刻意不含这些高保真 payload；trace 不能代替 replay case。

### 三种结果

1. **captured transcript**：任务在新捕获链路中正常结束，所有模型请求和工具节点均有终态。`RecordedModelProvider` 可严格比较后续测试的请求并返回已记录响应，参数漂移立即失败。
2. **可物化的文件场景**：除 transcript 条件外，某个 `edit_files(create:false)` 涉及的每一个文件都能从同一 `contentHash` 的 `read_file` 记录拼接出完整内容，并再次计算 SHA-256 一致。该 case 才能写入一个全新的隔离目录，复现补丁匹配、版本冲突或行范围错误。
3. **部分材料 / legacy**：仅有局部读取、读取版本不一致、未保存的模型请求、未完成工具或缺少捕获的旧历史时，case 会保留已有 transcript/读取材料，但明确拒绝把它称为完整文件重建。可据此人工补 fixture，或重做任务以获得完整捕获。

旧版已捕获的整条 replay JSON 继续导出为 `captured`；更早、没有逐次模型请求、完整工具结果和当时 instructions 的历史无法补造为 captured transcript，导出时标为 `legacy`。不过若旧事件保留了完整 `read_file` 页和匹配哈希，仍可用于判断并物化其有限的编辑前文件。

## 手动导出

只在需要开发 replay 测试时执行；不会调用模型、执行工具或运行 Evaluation。

```sh
# 先列出可导出的任务：每行是 task ID、状态和创建时间
pnpm replay:export -- --list

pnpm replay:export -- --task-id TASK_ID --output C:\safe\case.json
# 如数据目录不是默认平台目录：
pnpm replay:export -- --data-dir C:\CodeAtelierData --task-id TASK_ID --output C:\safe\case.json
```

`--list` 和导出都不会变更任务状态。`--output` 必须是一个不存在的新文件，避免覆盖其他本地 case。输出的 `source` 为 `captured` 或 `legacy`；导出本身不表示文件场景完整。

在 TypeScript 改进测试中，先调用 `analyzeReplayWorkspace(caseFile)`。只有 `complete: true` 时，才调用 `materializeReplayWorkspace(caseFile, newDirectory)`；函数要求 `newDirectory` 尚不存在，只会写入被 `edit_files(create:false)` 所需、经哈希验证的读取文件。

随后测试可以在该目录创建自己的 ToolRunner/Engine。不要把原 workspace 传入 replay，也不要执行已记录的 `run_command`、Git 或其他副作用工具。

对于只验证提示、上下文或模型循环的测试，使用 `new RecordedModelProvider(caseFile.capture)`；它逐项比较 input、instructions、工具 schema 和输出选项，然后返回记录的模型响应。它不会运行工具，测试必须自行提供受控工具层或只测试模型交互。

## 可视化阅读

阅读器直接由现有 CodeAtelier Web 服务提供，不需要生成独立 HTML，也不另开服务器：

1. 按 README 构建并启动 CodeAtelier（已有服务只需使用更新后的前端产物）。
2. 点击侧栏“对话阅读器”，在新标签页打开；也可直接访问 `http://127.0.0.1:4142/?view=replay`。修改端口时使用实际地址；Vite 开发模式为 `http://127.0.0.1:5173/?view=replay`。
3. 启用访问密码时先通过与主页面相同的门禁，再选择本地 Replay JSON。JSON 只在当前浏览器读取，不发往后端或模型，不写 localStorage；刷新后需重新选择。

阅读器使用 `replay:export` 的 **TaskReplayCase v1**，不是 Perfetto trace 或任意 JSON；现有 captured/legacy 导出均可查看。服务仅提供页面、同源脚本/样式与访问验证，不根据 JSON 或 URL 参数读取服务器文件。

- **按轮次**：每次模型请求独立编号，展示 purpose、原始 step/attempt、回复、实报 token 用量和关联工具。重试不会合并，编号不是新的对话轮次协议。
- **工具详情**：查看参数、可读输出、完整结果、call ID、DAG 节点、批次和依赖；可返回所属模型调用。关联只使用唯一 `function_call.call_id`，缺失或歧义记录放在“未关联模型调用”，不凭顺序猜测。
- **原始材料**：输入上下文、instructions、工具定义、响应协议项、错误和扩展字段可分别展开；审批、压缩、状态与其他过程在“历史事件”中按导出顺序查看。模型和事件没有共同可靠时钟，不拼造精确耗时图；性能分析继续使用 Perfetto。
- **定位**：类型/状态筛选、当前视图全文搜索、每页 40 条目录、单条详情；大文本每次显示 20,000 字符，可继续显示，不截掉底层数据。搜索按完整原始记录匹配，不仅搜索预览。
- **诚实状态**：“已记录”只表示存在响应/结果，不等同成功；已知错误标为异常；没有结果明确为未知。legacy 缺失模型请求时不补造，缺失 usage 不当零。

JSON 可能包含完整源码、提示词、命令与工具输出，必须保存在受保护本地目录，不能提交 Git 或公开。页面用纯文本而非可执行 HTML/Markdown 显示载荷；查看不会调用模型、重放工具或运行 Evaluation。主界面目前提供阅读入口，不提供服务端历史导出按钮。

JSON 解析和搜索仍在内存中处理完整文件，分页主要减少 DOM 数量；超大文件仍受本机内存与浏览器性能限制。

### 可选：保留旧单文件导出

仅在需要脱离服务携带阅读器时使用，普通 Web 阅读不需要此步骤：

```sh
pnpm replay:view --input C:\safe\case.json --output C:\safe\case-view.html
# 不内嵌数据，在页面中选择 JSON：
pnpm replay:view --output C:\safe\replay-viewer.html
```

输出必须是新文件，可直接通过 `file://` 打开；独立文件使用哈希 CSP 禁止网络、外部资源与表单。Web 入口则需要同源资源及门禁请求，不宣称完全无网络。带数据的 HTML 与 JSON 同样敏感；CLI 不读取 case 内记录的路径。Windows 文件权限依赖目标目录 ACL，不能将 POSIX 的 0600 当作 Windows 隔离保证。

## 当前限制

- case 不捕获未读取文件、Git 索引/提交状态、环境变量、依赖安装、子进程、网络、外部服务或操作系统状态；这些不能从工具输出可靠推导。
- `read_file` 最多返回 500 行。多页读取可按相同 `contentHash` 拼接；只读了部分行、文件过大/二进制或发生读取错误时不能物化该文件。
- `create:true` 的成功结果只证明初态不存在；失败的新建没有完整目标状态，隔离物化会保守拒绝。
- 物化目录仅重建记录的原始文件版本，**不会**自动执行记录中的编辑、命令或 Git 操作。这样既防止改动用户当前文件，也延续未知副作用不重放的安全边界。
