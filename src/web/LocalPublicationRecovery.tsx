/**
 * 来源发布事故的审核与明确接受界面，由 LocalOverlayStatus 在可核查会话中展示。
 * 1. 显式请求后按文件展开发布前/拟发布/当前内容；不自动检查、接受或执行源码。
 * 2. 接受始终使用原检查 token，未知结果可重试；已记录决定只提供继续解锁，不重新定义现场。
 * 3. 成功只说明该次来源阻塞已处理，原私有视图仍需核查；complete 不伪装成可接受的 unknown。
 * 4. 卸载取消在途请求且丢弃晚到响应；正文不进 URL/本地存储，不自动启动任务或刷新私有层。
 */
import { useEffect, useRef, useState } from "react";
import type { LocalOverlayService } from "../local-overlays/service";
import type { UnknownReview } from "../local-overlays/publication/unknown-recovery";
import { api } from "./api";
import { displayLocalContent } from "./LocalFileReview";
import s from "./app.module.css";

type Result = Awaited<ReturnType<LocalOverlayService["publicationRecovery"]>>;

function IncidentFile({ file }: { file: UnknownReview["files"][number] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        {file.path}：
        {file.observed === "after"
          ? "当前内容与拟发布结果相同"
          : file.observed === "before"
            ? "仍是发布前版本"
            : "当前现场已变化"}
      </summary>
      {expanded &&
        [
          ["发布前内容", file.before.content],
          ["拟发布内容", file.proposed],
          ["主目录当前内容", file.current.content],
        ].map(([label, content]) => (
          <section key={label} aria-label={label ?? undefined}>
            <h3>{label}</h3>
            <pre>{displayLocalContent(content ?? null)}</pre>
          </section>
        ))}
    </details>
  );
}

export function LocalPublicationRecovery({ sessionId }: { sessionId: string }) {
  const [result, setResult] = useState<Result>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);

  const run = async (token?: string) => {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setError("");
    try {
      const response = await api<Result>(
        `/sessions/${sessionId}/local-publication-${token ? "accept" : "review"}`,
        token ? { token } : {},
        "POST",
        false,
        abort.signal,
      );
      if (!abort.signal.aborted) {
        setResult(response);
      }
    } catch (failure) {
      if (!abort.signal.aborted) {
        setError((failure as Error).message);
      }
    } finally {
      if (!abort.signal.aborted) {
        setBusy(false);
      }
    }
  };

  const token =
    result?.kind === "review" || result?.kind === "decision"
      ? result.token
      : undefined;

  return (
    <details className={s.localReview}>
      <summary>核查来源发布事故</summary>
      <p>来源可能只完成了部分修改。检查不会补写、回滚或恢复此私有视图。</p>
      <button type="button" disabled={busy} onClick={() => void run()}>
        检查发布现场
      </button>
      {error && <p role="alert">{error}</p>}
      {result?.kind === "review" && (
        <section aria-label="发布现场检查">
          {result.files.map((file) => (
            <IncidentFile key={`${result.token}:${file.path}`} file={file} />
          ))}
        </section>
      )}
      {result?.kind === "complete" && (
        <p role="status">
          日志已记录来源发布完成，私有视图确认
          {result.refresh === "confirmed" ? "已记录" : "尚未确认"}
          。此入口不恢复私有视图，请保留现场。
        </p>
      )}
      {result?.kind === "decision" && (
        <p>
          已记录接受当前现场的决定，可以重试完成该次解锁；之后的来源修改仍保留。
        </p>
      )}
      {token && (
        <>
          <p>
            接受后保留主目录现在的内容，包括部分发布和外部修改；只解除本次发布的来源阻塞。未发布的文件不会补写，原私有修改和备份保留。
          </p>
          <button type="button" disabled={busy} onClick={() => void run(token)}>
            {result?.kind === "decision"
              ? "重试已记录的解锁"
              : "接受当前现场并解除发布阻塞"}
          </button>
        </>
      )}
      {result?.kind === "accepted" && (
        <p role="status">
          本次来源发布阻塞已处理，未补写或回滚文件。原私有视图仍需核查，不能直接继续任务。
        </p>
      )}
    </details>
  );
}
