/**
 * 文件作用：把持久化事件和待审批操作展示为会话时间线。
 * 代码结构：先定义工具标签及结果文本转换，再在 Timeline 中整理流式与完成消息，渲染工具、diff、通知、用量和审批操作。
 */

import type { Snapshot, Event } from "../shared/types";
import { api } from "./api";
import s from "./app.module.css";

const labels: Record<string, string> = {
  list_files: "浏览目录",
  read_file: "读取文件",
  search: "搜索代码",
  edit_file: "精确修改",
  write_file: "写入文件",
  run_command: "执行命令",
};

function textResult(event: Event) {
  return typeof event.data.result === "string"
    ? event.data.result
    : JSON.stringify(event.data.result, null, 2);
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
  // 按任务、步骤和尝试次数隔离部分回复，避免把失败重试拼进成功文本。
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
          return (
            <details className={s.tool} key={e.id}>
              <summary>
                <span className={s.toolDot} />
                {labels[e.data.name] || e.data.name}
                <code>{e.data.args?.path || e.data.args?.command || ""}</code>
              </summary>
              <pre>{JSON.stringify(e.data.args, null, 2)}</pre>
            </details>
          );
        }

        if (e.type === "tool_result") {
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

        if (e.type === "command_output" && e.taskId === active?.id) {
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
              <p>
                输入预算：{e.data.inputLimit}{" "}
                {e.data.unit === "tokens" ? "token（本地估算）" : "字符"}
              </p>
              {e.data.outputTokens && (
                <p>
                  输出预留：{e.data.outputTokens} token；安全余量：
                  {e.data.safetyTokens} token
                </p>
              )}
            </details>
          );
        }

        if (e.type === "context_estimate") {
          return (
            <details className={s.toolResult} key={e.id}>
              <summary>
                输入{e.data.unit === "tokens" ? "估算" : "字符数"}：
                {e.data.input} / {e.data.limit}
              </summary>
              <p>
                {e.data.unit === "tokens"
                  ? "本地 tokenizer 估算，包含指令和工具定义，不是服务实报值。"
                  : "模型容量或 tokenizer 不可用，使用备用字符限制。"}
              </p>
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
