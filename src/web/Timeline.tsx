/**
 * 将 Snapshot 中的历史事件和待审批操作显示为对话时间线，并通过 api 提交审批决定。
 * 请求失败时交给传入的错误回调处理。
 *
 * 1. labels 和 textResult 处理工具名称及结果的显示格式。
 * 2. 按任务、步骤和尝试次数合并流式文本；已有完整 assistant 事件时，去掉对应的临时文本。
 * 3. 合并同一编辑批次的逐文件最新状态；按调用 ID 聚合 run_command、git 的流式输出和最终结果，再显示其余工具、diff、预算和用量通知。
 * 4. 显示仍在接收的文本和待审批按钮，把用户选择发给后端。
 *
 * 失败尝试的半截文本不能拼进重试后的回复。命令有输出不代表成功，退出码和错误信息要保留。
 */

import type { Snapshot, Event } from "../shared/types";
import { api } from "./api";
import s from "./app.module.css";

const labels: Record<string, string> = {
  list_files: "浏览目录",
  read_file: "读取文件",
  // 已移除的 search 工具仅用于展示旧会话记录。
  search: "搜索代码（旧记录）",
  // 旧会话的 edit_file 仅用于历史展示；新版模型契约只公开 edit_files。
  edit_file: "精确修改（旧记录）",
  edit_files: "精确修改文件",
  write_file: "写入文件",
  run_command: "执行命令",
  git: "Git 操作",
  // 保留旧会话事件的中文标签；旧调用只展示，不会被新版 ToolRunner 执行。
  git_status: "Git 状态（旧记录）",
  git_diff: "Git 差异（旧记录）",
  git_commit: "Git 提交（旧记录）",
  git_push: "Git 推送（旧记录）",
};

function textResult(event: Event) {
  return typeof event.data.result === "string"
    ? event.data.result
    : JSON.stringify(event.data.result, null, 2);
}

const streamedToolOutputTypes: Record<string, string> = {
  run_command: "command_output",
  git: "git_output",
};

interface ToolOutputCardState {
  output: string;
  result?: Event;
}

function outputTypeForTool(name: string) {
  return streamedToolOutputTypes[name];
}

function toolForOutputType(type: string) {
  return Object.entries(streamedToolOutputTypes).find(
    ([, outputType]) => outputType === type,
  )?.[0];
}

/** 将有流式 stdout/stderr 的工具开始、输出和最终状态聚合；旧历史缺少 callId 时按工具顺序兼容。 */
function toolOutputCards(events: Event[]) {
  const cards = new Map<number, ToolOutputCardState>();
  const calls = new Map<string, number>();
  const outputEventIds = new Set<number>();
  const resultEventIds = new Set<number>();
  const activeCards = new Map<string, number>();

  for (const event of events) {
    const outputType =
      event.type === "tool_start"
        ? outputTypeForTool(event.data.name)
        : undefined;

    if (outputType) {
      cards.set(event.id, { output: "" });
      calls.set(event.taskId + ":" + event.data.callId, event.id);
      activeCards.set(outputType, event.id);
      continue;
    }

    const tool = toolForOutputType(event.type);
    if (tool) {
      const cardId = event.data.callId
        ? calls.get(event.taskId + ":" + event.data.callId)
        : activeCards.get(event.type);
      const card = cardId === undefined ? undefined : cards.get(cardId);

      if (card) {
        card.output += event.data.text;
        outputEventIds.add(event.id);
      }

      continue;
    }

    if (event.type === "tool_result" && outputTypeForTool(event.data.name)) {
      const cardId = calls.get(event.taskId + ":" + event.data.callId);
      const card = cardId === undefined ? undefined : cards.get(cardId);

      if (card) {
        card.result = event;
        resultEventIds.add(event.id);
        activeCards.delete(outputTypeForTool(event.data.name));
      }
    }
  }

  return { cards, outputEventIds, resultEventIds };
}

function ToolOutputCard({
  start,
  state,
}: {
  start: Event;
  state: ToolOutputCardState;
}) {
  const result = state.result?.data.result;
  const output =
    state.output || (typeof result?.output === "string" ? result.output : "");
  const status = result?.error
    ? "操作未完成"
    : result
      ? result.exitCode === 0
        ? "已完成"
        : "退出码：" + (result.exitCode ?? "未知")
      : "执行中";
  const target =
    start.data.args?.command ||
    start.data.args?.action ||
    start.data.args?.path ||
    "";

  return (
    <details open className={s.outputCard}>
      <summary>
        <span className={s.toolDot} />
        {labels[start.data.name] || start.data.name} <code>{target}</code>
        <span className={s.outputStatus}>{status}</span>
      </summary>
      {output && <pre className={s.outputText}>{output}</pre>}
      {result && (
        <div className={s.outputResult}>
          {result.error
            ? "错误：" + result.error
            : "退出码：" + (result.exitCode ?? "未知")}
          {result.truncated ? "；输出已截断" : ""}
          <span>{state.result?.data.durationMs} ms</span>
        </div>
      )}
    </details>
  );
}

export function Timeline({
  data,
  onError,
}: {
  data: Snapshot;
  onError: (s: string) => void;
}) {
  const active = data.tasks.find(
    (t) => t.status === "running" || t.status === "waiting",
  );
  // 分别保留每次尝试的文本，避免将失败前的半截回复拼进成功结果。
  const streaming = new Map<string, string>();

  for (const e of data.events) {
    if (e.type === "delta") {
      const key = e.taskId + ":" + e.data.step + ":" + (e.data.attempt || 1);

      streaming.set(key, (streaming.get(key) || "") + e.data.text);
    }
  }

  for (const e of data.events) {
    if (e.type === "assistant") {
      streaming.delete(
        e.taskId + ":" + e.data.step + ":" + (e.data.attempt || 1),
      );
    }
  }

  const editBatches = new Map<
    string,
    { lastId: number; files: Map<string, { status: string; error?: string }> }
  >();
  for (const event of data.events) {
    if (event.type !== "edit_progress") {
      continue;
    }

    const batch = editBatches.get(event.data.batchId) ?? {
      lastId: event.id,
      files: new Map<string, { status: string; error?: string }>(),
    };
    for (const file of event.data.files ?? [event.data]) {
      batch.files.set(file.path, { status: file.status, error: file.error });
    }

    batch.lastId = event.id;
    editBatches.set(event.data.batchId, batch);
  }

  const outputEvents = toolOutputCards(data.events);

  return (
    <div className={s.timeline}>
      {data.events.map((e) => {
        if (e.type === "user" || e.type === "assistant") {
          return (
            <article
              key={e.id}
              className={e.type === "user" ? s.userMessage : s.assistantMessage}
            >
              <div className={s.messageLabel}>
                {e.type === "user" ? "你" : "✳ CodeAtelier"}
                <time>
                  {new Date(e.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <div className={s.prose}>{e.data.text}</div>
            </article>
          );
        }

        if (e.type === "tool_start") {
          if (outputTypeForTool(e.data.name)) {
            const card = outputEvents.cards.get(e.id);

            return card ? (
              <ToolOutputCard key={e.id} start={e} state={card} />
            ) : null;
          }

          return (
            <details className={s.tool} key={e.id}>
              <summary>
                <span className={s.toolDot} />
                {labels[e.data.name] || e.data.name}
                <code>
                  {e.data.args?.path ||
                    e.data.args?.command ||
                    e.data.args?.message ||
                    ""}
                </code>
              </summary>
              <pre>{JSON.stringify(e.data.args, null, 2)}</pre>
            </details>
          );
        }

        if (e.type === "tool_result") {
          if (outputEvents.resultEventIds.has(e.id)) {
            return null;
          }

          return (
            <details className={s.toolResult} key={e.id}>
              <summary>
                {e.data.result?.error ? "⚠ 操作未完成" : "✓ 工具结果"}
                <span>{e.data.durationMs} ms</span>
              </summary>
              <pre>{textResult(e)}</pre>
            </details>
          );
        }

        if (e.type === "edit_progress") {
          const batch = editBatches.get(e.data.batchId);
          if (!batch || batch.lastId !== e.id) {
            return null;
          }

          const statuses: Record<string, string> = {
            not_attempted: "尚未执行",
            failed: "未写入",
            unknown: "写入中或结果未知，请核实文件",
            written: "已写入",
          };

          return (
            <details open className={s.toolResult} key={e.id}>
              <summary>文件编辑进度</summary>
              {Array.from(batch.files, ([file, state]) => (
                <div key={file}>
                  <code>{file}</code>：{statuses[state.status] || state.status}
                  {state.error && `；错误：${state.error}`}
                </div>
              ))}
            </details>
          );
        }

        if (e.type === "diff") {
          return (
            <details open className={s.diff} key={e.id}>
              <summary>
                修改预览 <code>{e.data.path}</code>
              </summary>
              <pre>
                {e.data.diff.split("\n").map((line: string, i: number) => (
                  <div
                    key={i}
                    className={
                      line.startsWith("+")
                        ? s.added
                        : line.startsWith("-")
                          ? s.removed
                          : ""
                    }
                  >
                    {line || " "}
                  </div>
                ))}
              </pre>
            </details>
          );
        }

        if (outputEvents.outputEventIds.has(e.id)) {
          return null;
        }

        if (e.type === "command_output" || e.type === "git_output") {
          return (
            <pre className={s.toolResult} key={e.id}>
              {e.data.text}
            </pre>
          );
        }

        if (e.type === "context_budget") {
          return (
            <details className={s.toolResult} key={e.id}>
              <summary>
                上下文预算：
                {e.data.unit === "tokens" ? "token 模式" : "字符备用模式"}
              </summary>
              <p>
                {e.data.contextWindowTokens
                  ? "服务公布窗口：" + e.data.contextWindowTokens + " token"
                  : "服务未提供窗口容量"}
              </p>
              <p>输入预算：{e.data.inputLimit}</p>
              {e.data.outputTokens && (
                <p>
                  输出预留：{e.data.outputTokens} token；安全余量：
                  {e.data.safetyTokens} token
                </p>
              )}
            </details>
          );
        }

        if (e.type === "model_usage") {
          return (
            <details className={s.toolResult} key={e.id}>
              <summary>
                模型用量（服务实报）：输入 {e.data.input_tokens} / 输出{" "}
                {e.data.output_tokens} token
              </summary>
              <p>
                用途：
                {e.data.purpose === "compaction" ? "上下文摘要" : "任务执行"}
                ；本次合计：{e.data.total_tokens} token
              </p>
              <p>
                缓存输入：
                {e.data.input_tokens_details?.cached_tokens ?? "未提供"}
                ；推理输出：
                {e.data.output_tokens_details?.reasoning_tokens ?? "未提供"}
              </p>
            </details>
          );
        }

        if (e.type === "notice") {
          return (
            <div role="status" key={e.id} className={s.notice}>
              {e.data.text}
            </div>
          );
        }

        return null;
      })}
      {[...streaming].map(([key, text]) => (
        <article key={key} className={s.assistantMessage}>
          <div className={s.messageLabel}>
            ✳ CodeAtelier{" "}
            <span className={s.pulse}>
              {active &&
              key.startsWith(active.id + ":") &&
              !data.events.some(
                (e) =>
                  e.type === "notice" &&
                  key ===
                    e.taskId + ":" + e.data.step + ":" + (e.data.attempt || 1),
              )
                ? "生成中"
                : "未完成的回复"}
            </span>
          </div>
          <div className={s.prose}>{text}</div>
        </article>
      ))}
      {data.approvals.map((a) => (
        <section className={s.approval} key={a.id}>
          <small>需要你的确认</small>
          <h3>允许这次操作？</h3>
          <pre>{a.description}</pre>
          <p>命令将以本机用户权限执行。请确认目标与参数。</p>
          <div className={s.actions}>
            {(
              ["once", ...(a.repeatable ? ["session"] : []), "deny"] as const
            ).map((d) => (
              <button
                key={d}
                className={d === "once" ? s.primary : ""}
                onClick={() =>
                  api("/approvals/" + a.id, { decision: d }).catch((e) =>
                    onError(e.message),
                  )
                }
              >
                {d === "once"
                  ? "允许一次"
                  : d === "session"
                    ? "本次会话允许"
                    : "拒绝"}
              </button>
            ))}
          </div>
        </section>
      ))}
      {data.tasks
        .filter((t) => t.status === "interrupted")
        .map((t) => (
          <div className={s.notice} key={t.id}>
            上次任务因服务重启而中断。可继续提问；不会自动重放命令。
          </div>
        ))}
    </div>
  );
}
