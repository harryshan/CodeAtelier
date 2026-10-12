/**
 * 数据库 Replay 按目录和单条记录读取，替代浏览时全任务重建；离线 JSON 阅读器保持独立。
 * 1. 目录每页最多 100 项，选中项只加载一个模型请求或工具记录。
 * 2. 大输入按 20 个协议项分页渲染，切换与卸载取消请求且丢弃旧载荷。
 * 3. 完整任务导出是显式下载动作；legacy/未完成记录按捕获事实展示，不伪造响应。
 */
import { useEffect, useState } from "react";
import { api } from "../web/api.js";

type Entry = {
  seq: number;
  kind: "model" | "tool";
  itemId: string;
  purpose: string | null;
  finished: number;
};
type Directory = {
  captured: boolean;
  metadata: unknown;
  entries: Entry[];
  next: number | null;
};

function Material({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button onClick={() => setOpen(!open)}>
        {open ? "收起材料" : "展开材料"}
      </button>
      {open && <pre>{JSON.stringify(value, null, 2)}</pre>}
    </div>
  );
}

export function DatabaseReplay({
  sessionId,
  taskId,
  revision,
}: {
  sessionId: string;
  taskId: string;
  revision: number;
}) {
  const [after, setAfter] = useState(0);
  const [directory, setDirectory] = useState<Directory>();
  const [selected, setSelected] = useState<Entry>();
  const [detail, setDetail] = useState<Record<string, unknown>>();
  const [inputPage, setInputPage] = useState(0);
  const [error, setError] = useState("");
  const base = `/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}`;
  useEffect(() => {
    const controller = new AbortController();
    setDirectory(undefined);
    setSelected(undefined);
    setDetail(undefined);
    setError("");
    void api<Directory>(
      `${base}/replay-directory?after=${after}`,
      undefined,
      "GET",
      false,
      controller.signal,
    ).then(
      (value) => {
        if (!controller.signal.aborted) {
          setDirectory(value);
        }
      },
      (reason: Error) => {
        if (!controller.signal.aborted) {
          setError(reason.message);
        }
      },
    );

    return () => controller.abort();
  }, [base, after, revision]);
  useEffect(() => {
    setDetail(undefined);
    setInputPage(0);
    if (!selected) {
      return;
    }

    const controller = new AbortController();
    void api<Record<string, unknown>>(
      `${base}/replay-entry?kind=${selected.kind}&itemId=${encodeURIComponent(selected.itemId)}`,
      undefined,
      "GET",
      false,
      controller.signal,
    ).then(
      (value) => {
        if (!controller.signal.aborted) {
          setDetail(value);
        }
      },
      (reason: Error) => {
        if (!controller.signal.aborted) {
          setError(reason.message);
        }
      },
    );

    return () => controller.abort();
  }, [base, selected, revision]);
  const input = Array.isArray(detail?.input) ? detail.input : [];

  return (
    <section aria-label="Replay 请求目录">
      <a href={`/api${base}/replay/export`} download>
        导出完整 Task JSON
      </a>
      {error && <p role="alert">{error}</p>}
      {!directory ? (
        <p>正在读取请求目录…</p>
      ) : (
        <>
          <p aria-label="任务概览">
            任务 {taskId} · {directory.captured ? "captured" : "legacy"}
          </p>
          {!directory.captured && (
            <p>
              legacy：这个任务没有捕获模型请求。历史事件仍可在对话页面查看或显式导出。
            </p>
          )}
          <details>
            <summary>捕获元数据</summary>
            <Material value={directory.metadata} />
          </details>
          <button disabled={!after} onClick={() => setAfter(0)}>
            目录首页
          </button>
          <button
            disabled={directory.next === null}
            onClick={() => setAfter(directory.next!)}
          >
            下一页请求
          </button>
          <ol>
            {directory.entries.map((entry) => (
              <li key={entry.seq}>
                <button onClick={() => setSelected(entry)}>
                  {entry.kind} · {entry.purpose ?? "tool"} · {entry.itemId} ·{" "}
                  {entry.finished ? "已保存结果" : "结果未完成"}
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
      {selected && (
        <section aria-label="选中请求">
          <h2>{selected.itemId}</h2>
          {!detail ? (
            <p>正在重建选中的记录…</p>
          ) : (
            <>
              {Object.entries(detail)
                .filter(([key]) => key !== "input")
                .map(([key, value]) => (
                  <details key={key}>
                    <summary>{key}</summary>
                    <Material value={value} />
                  </details>
                ))}
              {Array.isArray(detail.input) && (
                <>
                  <h3>完整 input · {input.length} 项</h3>
                  <button
                    disabled={!inputPage}
                    onClick={() => setInputPage(inputPage - 1)}
                  >
                    上一页输入
                  </button>
                  <button
                    disabled={(inputPage + 1) * 20 >= input.length}
                    onClick={() => setInputPage(inputPage + 1)}
                  >
                    下一页输入
                  </button>
                  {input
                    .slice(inputPage * 20, inputPage * 20 + 20)
                    .map((item, index) => (
                      <details key={`${selected.itemId}:${inputPage}:${index}`}>
                        <summary>
                          #{inputPage * 20 + index + 1}{" "}
                          {item?.type ?? item?.role ?? "协议项"}
                        </summary>
                        <Material value={item} />
                      </details>
                    ))}
                </>
              )}
            </>
          )}
        </section>
      )}
    </section>
  );
}
