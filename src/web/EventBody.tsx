/**
 * 将 Timeline 的延迟正文显示为中文原文卡片，通过 api 按需读取片段。
 * 1. EventBody 按会话和事件键隔离状态，切换记录重新回到折叠入口。
 * 2. EventBodyCard 保留当前 16K 字符片段；翻页替换正文，收起、切换和卸载中止请求，晚到响应忽略。
 * 3. 卡片使用 timeline-presentation 的中文标题，内部类型/工具名作为次要信息；读取失败可重试，空片段不冒充加载中。
 * 片段只作为纯文本，不能解析为完整 JSON 或 Markdown；不运行历史工具，也不根据缺少正文推断成功。
 */
import { useEffect, useState } from "react";
import type { Event } from "../shared/types.js";
import { api } from "./api.js";
import s from "./app.module.css";
import { eventLabel, toolLabel } from "./timeline-presentation";

export function EventBody({ event }: { event: Event }) {
  return <EventBodyCard key={`${event.sessionId}:${event.id}`} event={event} />;
}

function EventBodyCard({ event }: { event: Event }) {
  const [offset, setOffset] = useState<number>();
  const [part, setPart] = useState<{ text: string; next: number | null }>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const name =
    typeof event.data?.name === "string" ? event.data.name : undefined;
  const title = `${eventLabel(event.type)}${name ? ` · ${toolLabel(name)}` : ""}`;

  useEffect(() => {
    if (offset === undefined) {
      return;
    }

    const controller = new AbortController();
    void api<{ text: string; next: number | null }>(
      `/sessions/${event.sessionId}/event-body/${event.id}?offset=${offset}`,
      undefined,
      "GET",
      false,
      controller.signal,
    ).then(
      (value) => {
        if (!controller.signal.aborted) {
          setPart(value);
        }
      },
      (reason: Error) => {
        if (!controller.signal.aborted) {
          setError(reason.message || "正文读取失败。");
        }
      },
    );

    return () => controller.abort();
  }, [event.sessionId, event.id, offset, attempt]);

  function navigate(next: number | undefined) {
    setPart(undefined);
    setError("");
    setOffset(next);
  }

  function retry() {
    setError("");
    setPart(undefined);
    setAttempt((value) => value + 1);
  }

  return (
    <section className={s.recordCard} aria-label={title}>
      <header className={s.recordHeader}>
        <strong>{title}</strong>
        <small>
          原始记录{event.bodyBytes ? ` · ${event.bodyBytes} 字节` : ""}
        </small>
        <code className={s.recordIdentifier}>
          {event.type}
          {name ? ` · ${name}` : ""}
        </code>
      </header>
      <div className={s.recordActions}>
        {offset === undefined ? (
          <button onClick={() => navigate(0)}>分段查看完整记录</button>
        ) : (
          <>
            <button onClick={() => navigate(undefined)}>收起正文</button>
            <button
              disabled={!offset || (!part && !error)}
              onClick={() => navigate(Math.max(0, offset - 16384))}
            >
              上一段
            </button>
            <button
              disabled={!part || part.next === null}
              onClick={() => {
                if (part?.next != null) {
                  navigate(part.next);
                }
              }}
            >
              下一段
            </button>
            <span>起始字符 {offset + 1}</span>
          </>
        )}
      </div>
      {offset !== undefined &&
        (error ? (
          <div role="alert" className={s.recordError}>
            <span>{error}</span>
            <button onClick={retry}>重试读取正文</button>
          </div>
        ) : !part ? (
          <p role="status" className={s.recordMessage}>
            正在读取…
          </p>
        ) : part.text.length === 0 ? (
          <p role="status" className={s.recordMessage}>
            此段没有内容。
          </p>
        ) : (
          <pre className={s.rawRecordText}>{part.text}</pre>
        ))}
    </section>
  );
}
