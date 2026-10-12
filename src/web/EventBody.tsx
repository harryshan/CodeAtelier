/**
 * 展示历史事件的分段原始正文，由 Timeline 对延迟正文或调用详情按需挂载。
 * 1. 每次只读取 16K 字符片段，前后翻页替换文本，不在浏览器累积整个大结果。
 * 2. 会话/事件切换和卸载中止请求，晚到响应不能覆盖当前片段；正文作为文本渲染。
 * 3. 不运行历史工具，不把缺少正文的结果显示成成功，也不把片段当作完整 JSON 解析。
 */
import { useEffect, useState } from "react";
import type { Event } from "../shared/types.js";
import { api } from "./api.js";

export function EventBody({ event }: { event: Event }) {
  const [offset, setOffset] = useState<number>();
  const [part, setPart] = useState<{ text: string; next: number | null }>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (offset === undefined) {
      return;
    }

    const controller = new AbortController();
    setPart(undefined);
    setError("");
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
          setError(reason.message);
        }
      },
    );

    return () => controller.abort();
  }, [event.sessionId, event.id, offset]);

  return (
    <section>
      <span>
        {event.type} · {event.data?.name ?? "历史正文"}
      </span>
      {offset === undefined ? (
        <button onClick={() => setOffset(0)}>
          分段查看完整记录{event.bodyBytes ? `（${event.bodyBytes} 字节）` : ""}
        </button>
      ) : (
        <>
          <button onClick={() => setOffset(undefined)}>收起正文</button>
          <button
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 16384))}
          >
            上一段
          </button>
          <button
            disabled={!part || part.next === null}
            onClick={() => setOffset(part!.next!)}
          >
            下一段
          </button>
          <span>起始字符 {offset + 1}</span>
          <pre>{error || part?.text || "正在读取…"}</pre>
        </>
      )}
    </section>
  );
}
