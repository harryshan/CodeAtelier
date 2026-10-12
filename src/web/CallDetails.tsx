/**
 * 按会话、任务和调用 ID 查找页面外的关联事件，Timeline 工具卡片按需使用。
 * 1. 查询只返回每页 100 条元数据，保留重复调用候选，不猜测唯一结果。
 * 2. EventBody 独立分段读取选中的正文，页面翻页丢弃上页材料。
 * 3. 卸载、收起和翻页取消旧请求，不执行工具，也不改变历史。
 */
import { useEffect, useState } from "react";
import type { Event } from "../shared/types.js";
import { api } from "./api.js";
import { EventBody } from "./EventBody.js";

export function CallDetails({ event }: { event: Event }) {
  const [open, setOpen] = useState(false);
  const [after, setAfter] = useState(0);
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState("");
  const callId = event.data?.callId;
  useEffect(() => {
    if (!open || typeof callId !== "string") {
      return;
    }

    const controller = new AbortController();
    setEvents([]);
    setError("");
    void api<Event[]>(
      `/sessions/${event.sessionId}/call-events?taskId=${encodeURIComponent(event.taskId)}&callId=${encodeURIComponent(callId)}&after=${after}`,
      undefined,
      "GET",
      false,
      controller.signal,
    ).then(
      (value) => {
        if (!controller.signal.aborted) {
          setEvents(value);
        }
      },
      (reason: Error) => {
        if (!controller.signal.aborted) {
          setError(reason.message);
        }
      },
    );

    return () => controller.abort();
  }, [open, after, event.sessionId, event.taskId, callId]);
  if (typeof callId !== "string") {
    return null;
  }

  return (
    <section>
      <button onClick={() => setOpen(!open)}>
        {open ? "收起调用记录" : "查看此调用的全部关联记录"}
      </button>
      {open && (
        <>
          <p>按任务和调用 ID 列出候选记录；重复 ID 的记录均保留。</p>
          {error && <p role="alert">{error}</p>}
          {events.map((item) => (
            <EventBody key={item.id} event={item} />
          ))}
          <button disabled={!after} onClick={() => setAfter(0)}>
            关联记录首页
          </button>
          <button
            disabled={events.length < 100}
            onClick={() => setAfter(events.at(-1)!.id)}
          >
            下一页关联记录
          </button>
        </>
      )}
    </section>
  );
}
