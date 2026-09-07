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
  const streaming = new Map<string, string>();
  for (const e of data.events)
    if (e.type === "delta") {
      const key = e.taskId + ":" + e.data.step;
      streaming.set(key, (streaming.get(key) || "") + e.data.text);
    }
  for (const e of data.events)
    if (e.type === "assistant") streaming.delete(e.taskId + ":" + e.data.step);
  return (
    <div className={s.timeline}>
      {data.events.map((e) => {
        if (e.type === "user" || e.type === "assistant")
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
        if (e.type === "tool_start")
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
        if (e.type === "tool_result")
          return (
            <details className={s.toolResult} key={e.id}>
              <summary>
                {e.data.result?.error ? "⚠ 操作未完成" : "✓ 工具结果"}
                <span>{e.data.durationMs} ms</span>
              </summary>
              <pre>{textResult(e)}</pre>
            </details>
          );
        if (e.type === "diff")
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
        if (e.type === "command_output" && e.taskId === active?.id)
          return (
            <pre className={s.toolResult} key={e.id}>
              {e.data.text}
            </pre>
          );
        if (e.type === "notice")
          return (
            <div role="status" key={e.id} className={s.notice}>
              {e.data.text}
            </div>
          );
        return null;
      })}
      {[...streaming].map(([key, text]) => (
        <article key={key} className={s.assistantMessage}>
          <div className={s.messageLabel}>
            ✳ CodeAtelier{" "}
            <span className={s.pulse}>
              {active ? "生成中" : "未完成的回复"}
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
