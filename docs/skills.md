# Skill 系统

Skill 是本地 `SKILL.md` 中的任务说明和工作流程，不是可执行插件。每个主任务开始时后端自动扫描预设目录，把名称、用途和来源类别提供给模型；模型通过 `skill` 工具按需加载正文，再使用现有文件、命令等工具完成工作。加载本身不执行脚本，也不等于任务完成。

## 预设目录与优先级

按下面顺序扫描，同名 Skill 取第一个**有效**条目：

1. `<workspace>/.codeatelier/skills`
2. `<workspace>/.agents/skills`
3. `<workspace>/.claude/skills`
4. `<home>/.codeatelier/skills`
5. `<home>/.agents/skills`
6. `<home>/.claude/skills`

`workspace` 是当前会话的工作区，不是后端启动目录；`home` 是后端宿主用户的 `os.homedir()`，Windows 通常为 `%USERPROFILE%`，不是 Sandbox 专用账户的 home。同一真实根只扫描一次，每根只检查一级 `<name>/SKILL.md`，不递归搜索祖先项目、子项目、`node_modules` 或技能的资源目录。

根不存在时正常跳过，不自动创建目录。坏条目不会阻止其它有效条目，也不会掩盖低优先级同名有效技能。被覆盖、无效或超过限制的条目可以通过 `skill list` 查看诊断。

每次新任务、续聊和人工恢复都会重新扫描；进行中的任务使用固定名称/描述/来源/内容哈希目录。加载时重新读取并核对文件版本，文件已变化、被删除或变成不安全路径时拒绝加载，需发起新任务重新发现。不需要重启后端。

## 创建一个 Skill

例如在当前项目创建 `.codeatelier/skills/review/SKILL.md`：

```markdown
---
name: review
description: 检查代码修改、相关调用方和测试覆盖，并按严重程度汇报问题。
---

# 代码审查

1. 先读取项目规则和相关修改，确认变更目的。
2. 查找调用方，检查正常、失败和边界路径。
3. 在现有权限内运行相关验证。
4. 报告有证据的问题，明确未验证部分；不要自动修改文件。
```

也可以从项目根用 Node 创建目录，再在编辑器保存上面的文件：

```sh
node -e "require('node:fs').mkdirSync('.codeatelier/skills/review', {recursive:true})"
```

格式要求：

- UTF-8，允许 BOM、LF 和 CRLF。
- 文件开头为 `---` 包围的 YAML frontmatter，然后是非空 Markdown 正文。
- `name` 与技能目录名一致；1～64 个小写英文字母、数字、单连字符，不以连字符开头/结尾，不含连续连字符。
- `description` 为 1～1024 字符的非空字符串，支持 YAML 引号与 `>`/`|` 多行文本。
- 其它元信息可存在，但本版不解释；尤其 `allowed-tools` 不授予工具权限，`license`、`metadata` 等不会改变执行策略。
- 文件最大 64 KiB，YAML 头结束位置不超过 8 Ki 字符；每根最多枚举 512 个目录项，超过则整根跳过，避免依赖不稳定的枚举顺序。目录最多保留 64 个技能，根内按名称排序后选取；诊断最多保留 32 条。

技能可以包含 `scripts/`、`references/`、`assets/` 等目录，但不会自动读取、上传或执行。正文中的相对引用以工具返回的 `skill.directory` 为基准，进一步读取或运行仍使用普通工具及现有审批。宿主全局技能目录不会因此成为 Sandbox 的新文件授权根；需要额外访问时仍走既有权限流程。

## 模型调用接口

普通 function 工具 `skill` 支持两个 action，沿用 DAG 信封：

```json
{
  "execution": { "id": "list-skills", "dependsOn": [] },
  "arguments": { "request": { "action": "list" } }
}
```

```json
{
  "execution": { "id": "load-review", "dependsOn": [] },
  "arguments": { "request": { "action": "load", "name": "review" } }
}
```

`list` 返回名称、描述、来源、真实目录/文件路径、SHA-256 和发现诊断；`load` 返回对应摘要及 Markdown 正文。工具不接受任意路径、URL、命令或权限字段。未知名称失败并阻断依赖它的 DAG 后继。

所有结果沿用工具历史、Replay Case、脱敏和输出长度限制；大结果可能被标记截断，不能假装已读完全文。目录摘要会进入主模型请求，加载正文也会发送给当前配置的模型服务并保存在本机会话材料中，因此不要在技能中保存密钥。诊断代码包括 `root_unavailable`（不可读取、非普通目录、链接越界或枚举超限）、`invalid_skill`（格式/名称/文件/链接无效）、`shadowed`（被高优先级同名技能覆盖）、`catalog_limit`。

## 安全与执行位置

- 自动发现和加载只允许上述固定根及已发现名称，不单独请求审批；这不是任意宿主文件读取接口。
- Skill 是不可信参考，不能覆盖当前用户要求、项目规则、系统约束或工具权限；不把技能安装者写入的授权声明当成用户批准。
- 根/技能目录的直接符号链接或 junction、跨锚点的祖先链接、文件符号链接和硬链接均拒绝。加载前后复核真实路径、普通文件、大小和版本；这是应用层检查，不宣称能抵御恶意宿主并发文件系统竞争或提供 OS 隔离。
- 宿主任务与 Sandbox Runtime 都由 Broker 的任务级 `TaskSkills` 读取；Runtime 经认证 IPC v8 的 `skill_execute` 只传名称/操作/调用 ID，不自行读取宿主 home。结果归因为 `broker-skill/host-process`。
- `skills.discover/list/load` trace 记录开始、终态、耗时、调用 ID 和条目数量；日志只记录计数和诊断数量，不记录路径、技能名称、描述或正文。模型/工具历史与 trace 分开管理。

没有技能安装市场、网络下载、自定义扫描根配置、自动脚本入口、热更新 watcher 或管理 UI。本版只向主 agent 提供 Skill，不扩大尚未开放的只读 subagent 工具集。

升级安装版 Windows Runtime 后需重新构建并管理员 Repair，旧 IPC 版本拒绝握手。普通 Node 子进程 harness 和静态构建不替代固定账户安装态验证；跨平台实测范围以 [验证记录](verification.md) 为准。
