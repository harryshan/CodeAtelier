/**
 * 为 Timeline 和 EventBody 提供中文标签及保守的结果摘要；只接收历史字段，不读取网络或修改事件。
 * 1. toolLabels 保留现行工具与旧工具的显示名称，toolLabel 对未知名称使用中性兜底。
 * 2. eventLabel 为延迟正文和未关联输出提供标题；内部标识由调用方作为次要信息保留。
 * 3. resultSummary 仅概括已知读取/编辑字段及截断标记，不解析原始字符串，不把结果存在视为成功。
 * 原文由调用方完整保留在折叠区域；摘要不代替执行状态或恢复凭证。
 */
const toolLabels: Record<string, string> = {
  list_files: "浏览目录（旧记录）",
  read_file: "读取文件",
  search: "搜索代码（旧记录）",
  edit_file: "精确修改（旧记录）",
  edit_files: "新建或精确修改文件",
  write_file: "写入文件（旧记录）",
  run_command: "执行命令",
  run_with_permissions: "执行命令（宿主权限）",
  git: "Git 操作（旧记录）",
  subagent: "只读子代理协调",
  git_status: "Git 状态（旧记录）",
  git_diff: "Git 差异（旧记录）",
  git_commit: "Git 提交（旧记录）",
  git_push: "Git 推送（旧记录）",
  mcp: "MCP 服务",
  skill: "技能参考",
  local_publish: "选择发布变更",
  memory_apply: "项目记忆",
  read_context_history: "读取归档上下文",
};

export function toolLabel(name: unknown): string {
  return typeof name === "string" && Object.hasOwn(toolLabels, name)
    ? toolLabels[name]
    : "工具调用";
}

const eventLabels: Record<string, string> = {
  user: "用户消息",
  assistant: "助手消息",
  delta: "回复片段",
  tool_start: "工具调用",
  tool_result: "工具结果",
  command_output: "命令输出",
  capability_output: "宿主命令输出",
  git_output: "Git 输出（旧记录）",
  diff: "修改预览",
  edit_progress: "文件编辑进度",
  notice: "任务通知",
  sandbox_fallback: "Sandbox 回退警告",
  approval_assessed: "审批评估",
  context_budget: "上下文预算",
  model_usage: "模型用量",
  subagent_plan: "子任务计划",
  subagent_state: "子任务状态",
  subagent_question: "子任务提问",
  subagent_collect: "子任务报告",
};

export function eventLabel(type: string): string {
  return Object.hasOwn(eventLabels, type) ? eventLabels[type] : "历史记录";
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function resultSummary(name: unknown, result: unknown): string {
  if (result === undefined || result === null) {
    return "结果未记录";
  }

  if (typeof result === "string") {
    return result.length ? `文本结果 · ${result.length} 字符` : "空文本结果";
  }

  const value = objectRecord(result);
  if (!value) {
    return "原始结果 · 展开查看";
  }

  if (value.error) {
    return typeof value.error === "string"
      ? `错误：${value.error.slice(0, 160)}${value.error.length > 160 ? "…" : ""}`
      : "操作未完成 · 展开查看错误";
  }

  const parts: string[] = [];
  if (name === "read_file") {
    if (typeof value.path === "string") {
      parts.push(value.path);
    }

    if (
      typeof value.totalLines === "number" &&
      Number.isSafeInteger(value.totalLines) &&
      value.totalLines >= 0
    ) {
      parts.push(`共 ${value.totalLines} 行`);
    }

    if (value.hasMore === true) {
      parts.push("还有后续内容");
    }
  } else if (name === "edit_files" && Array.isArray(value.files)) {
    let written = 0;
    let failed = 0;
    let unknown = 0;
    let pending = 0;
    for (const file of value.files) {
      switch (objectRecord(file)?.status) {
        case "written":
          written++;
          break;
        case "failed":
          failed++;
          break;
        case "not_attempted":
          pending++;
          break;
        default:
          unknown++;
          break;
      }
    }

    parts.push(
      `已写入 ${written} · 失败 ${failed} · 未知 ${unknown} · 未执行 ${pending}`,
    );
  }

  if (value.truncated === true) {
    parts.push("结果已截断");
  }

  return parts.length ? parts.join(" · ") : "结构化结果 · 展开查看";
}
