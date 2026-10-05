/**
 * Web 阅读器页面：在 AccessGate 通过后，默认经同源 API 浏览当前数据库的对话和 Task。
 * 依赖共享 DOM 阅读器及 web/api 的会话凭据处理；只请求目录和用户选中的任务，不直接连接 SQLite。
 *
 * 1. selectionFromUrl/remember 只在 URL 保存数据源和记录 ID，不保存正文或凭据。
 * 2. 挂载 effect 管理 DOM 控制器与标题；切换来源时销毁旧内容，本地文件模式不请求数据库。
 * 3. 查询 effect 按会话目录、任务目录、单任务详情顺序读取；取消信号阻止旧请求覆盖新选择。
 * 4. 控件显示工作区、对话、Task 时间/状态和 ID，提供过滤与手动刷新；错误或空记录明确显示。
 *
 * 运行中任务展示已落库材料，不订阅或重放执行。URL 中不存在的 ID 不静默替换成其他记录。
 * 数据仅保留在页面内存，数据库选择可刷新恢复；可选 JSON 导入仍不上传，刷新丢弃文件内容。
 */

import { useEffect, useRef, useState } from "react";
import type { Session, Task } from "../shared/types.js";
import { api } from "../web/api.js";
import { mountViewer } from "./browser.js";
import "./viewer.css";

type Selection = { sessionId: string; taskId: string };

function selectionFromUrl(): Selection {
  const query = new URLSearchParams(location.search);

  return {
    sessionId: query.get("session") ?? "",
    taskId: query.get("task") ?? "",
  };
}

function remember(mode: string, selection: Selection) {
  const url = new URL(location.href);
  url.searchParams.set("view", "replay");
  url.searchParams.set("source", mode);
  for (const [key, value] of [
    ["session", selection.sessionId],
    ["task", selection.taskId],
  ]) {
    if (mode === "database" && value) {
      url.searchParams.set(key, value);
    } else {
      url.searchParams.delete(key);
    }
  }

  history.replaceState(null, "", url);
}

export default function ReplayViewer() {
  const container = useRef<HTMLDivElement>(null);
  const renderer = useRef<ReturnType<typeof mountViewer> | null>(null);
  const [mode, setMode] = useState(() =>
    new URLSearchParams(location.search).get("source") === "file"
      ? "file"
      : "database",
  );
  const [selection, setSelection] = useState(selectionFromUrl);
  const [resolved, setResolved] = useState(selection);
  const [conversations, setConversations] = useState<Session[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "CodeAtelier · 对话阅读器";
    const view = mountViewer(container.current!, null, mode === "file");
    renderer.current = view;

    return () => {
      renderer.current = null;
      view.dispose();
      document.title = previousTitle;
    };
  }, [mode]);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    const view = renderer.current!;
    view.clear();
    setError("");
    setMessage("");
    setTasks([]);
    setLoading(mode === "database");
    if (mode === "file") {
      remember(mode, selection);

      return () => controller.abort();
    }

    async function load() {
      try {
        const list = await api<Session[]>(
          "/sessions",
          undefined,
          "GET",
          false,
          signal,
        );
        if (signal.aborted) {
          return;
        }

        setConversations(list);
        const sessionId = selection.sessionId || list[0]?.id || "";
        if (!sessionId) {
          setMessage("数据库中还没有对话。");
          setResolved({ sessionId: "", taskId: "" });
          remember(mode, { sessionId: "", taskId: "" });

          return;
        }

        if (!list.some((session) => session.id === sessionId)) {
          throw new Error("所选对话不存在，请重新选择。");
        }

        const base = `/sessions/${encodeURIComponent(sessionId)}/tasks`;
        const taskList = await api<Task[]>(
          base,
          undefined,
          "GET",
          false,
          signal,
        );
        if (signal.aborted) {
          return;
        }

        setTasks(taskList);
        const taskId = selection.taskId || taskList.at(-1)?.id || "";
        const current = { sessionId, taskId };
        setResolved(current);
        remember(mode, current);
        if (!taskId) {
          setMessage("这个对话还没有 Task。");

          return;
        }

        if (!taskList.some((task) => task.id === taskId)) {
          throw new Error("所选 Task 不属于这个对话或已不存在，请重新选择。");
        }

        const value = await api<unknown>(
          `${base}/${encodeURIComponent(taskId)}/replay`,
          undefined,
          "GET",
          false,
          signal,
        );
        if (signal.aborted) {
          return;
        }

        view.load(value, "数据库记录");
        setMessage(
          "已读取当前已保存记录；运行中 Task 可手动刷新，不会重新执行。",
        );
      } catch (cause) {
        if (!signal.aborted) {
          setError(
            cause instanceof Error ? cause.message : "读取数据库记录失败。",
          );
        }
      } finally {
        if (!signal.aborted) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => controller.abort();
  }, [mode, selection, revision]);

  const visibleConversations = conversations.filter(
    (session) =>
      session.id === resolved.sessionId ||
      `${session.title} ${session.workspace} ${session.id}`
        .toLocaleLowerCase()
        .includes(filter.toLocaleLowerCase()),
  );

  return (
    <main id="app">
      <a className="viewer-home" href="/">
        ← 返回 CodeAtelier
      </a>
      <div className="toolbar">
        <button
          type="button"
          aria-pressed={mode === "database"}
          onClick={() => setMode("database")}
        >
          数据库记录
        </button>
        <button
          type="button"
          aria-pressed={mode === "file"}
          onClick={() => setMode("file")}
        >
          本地 JSON
        </button>
      </div>
      {mode === "database" && (
        <section aria-label="数据库记录选择">
          <p>直接浏览当前服务数据库中的对话与 Task，无需导出文件。</p>
          <div className="toolbar">
            <input
              aria-label="筛选对话"
              placeholder="对话标题、工作区或 ID"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <select
              aria-label="选择对话"
              value={resolved.sessionId}
              onChange={(event) => {
                const next = { sessionId: event.target.value, taskId: "" };
                setResolved(next);
                setSelection(next);
              }}
            >
              <option value="" disabled>
                选择对话
              </option>
              {visibleConversations.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.title} · {session.workspace} · {session.id}
                </option>
              ))}
            </select>
            <select
              aria-label="选择 Task"
              value={resolved.taskId}
              disabled={!tasks.length}
              onChange={(event) => {
                const next = { ...resolved, taskId: event.target.value };
                setResolved(next);
                setSelection(next);
              }}
            >
              <option value="" disabled>
                选择 Task
              </option>
              {tasks.map((task, index) => (
                <option key={task.id} value={task.id}>
                  #{index + 1} · {task.createdAt} · {task.status} · {task.id}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                setSelection(resolved);
                setRevision((value) => value + 1);
              }}
            >
              刷新记录
            </button>
          </div>
          <p role="status">{loading ? "正在读取数据库记录…" : message}</p>
          {error && <p role="alert">{error}</p>}
        </section>
      )}
      <div ref={container} />
    </main>
  );
}
