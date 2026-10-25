/**
 * Local 会话的单文件内容检查面板，由状态组件挂载，不触发任务或发布。
 * 1. 用户输入相对路径后请求已封存 B/O/T；请求期间禁用重复提交。
 * 2. 编辑路径、切换会话/代次/状态或卸载均取消请求并丢弃晚到响应，不持久保存正文。
 * 3. 纯文本展示原文、私有结果、来源现状和合并预览；二进制只报大小，长文本明确截断。
 * 预览不是测试或发布结果，没有自动重试、执行源码或写回入口。
 * 4. 用户可固定 UUID 创建新对话携带参考；成功交给 App，不自动提交任务，失败重试同一请求，卸载后不切换回旧操作。
 */
import { useEffect, useRef, useState } from "react";
import type { LocalFileReview as Review } from "../local-overlays/publication/review";
import { api } from "./api";
import type { Session } from "../shared/types";
import { requestId } from "./WorktreeDialog";
import s from "./app.module.css";

function display(content: string | null) {
  if (content === null) {
    return "（文件不存在）";
  }

  const bytes = Uint8Array.from(atob(content), (value) => value.charCodeAt(0));
  try {
    if (bytes.includes(0)) {
      throw new Error("binary");
    }

    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);

    return text.length > 65536
      ? text.slice(0, 65536) + "\n（显示已截断，仅展示前 65536 个字符）"
      : text || "（空文件）";
  } catch {
    return `（二进制内容，${bytes.length} 字节）`;
  }
}

export function LocalFileReview({
  sessionId,
  onCreated,
}: {
  sessionId: string;
  onCreated: (session: Session) => void;
}) {
  const [path, setPath] = useState("");
  const [review, setReview] = useState<Review>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const continuation = useRef<string | undefined>(undefined);
  const alive = useRef(true);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    alive.current = true;

    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);

  const continueResolution = async () => {
    if (!review) {
      return;
    }

    continuation.current ??= requestId();
    setCreating(true);
    setError("");
    try {
      const session = await api<Session>(
        `/sessions/${sessionId}/local-resolution`,
        {
          id: continuation.current,
          path: review.path,
          version: review.version,
        },
      );
      if (alive.current) {
        onCreated(session);
      }
    } catch (failure) {
      if (alive.current) {
        setError((failure as Error).message);
      }
    } finally {
      if (alive.current) {
        setCreating(false);
      }
    }
  };

  const inspect = async () => {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setError("");
    setReview(undefined);
    continuation.current = undefined;
    try {
      const result = await api<Review>(
        `/sessions/${sessionId}/local-review`,
        { path },
        "POST",
        false,
        abort.signal,
      );
      if (!abort.signal.aborted) {
        setReview(result);
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

  return (
    <details className={s.localReview}>
      <summary>检查私有修改</summary>
      <p>
        输入已修改文件的相对路径（目录分隔符使用
        /）。检查只读取一个文件，不会发布修改。
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void inspect();
        }}
      >
        <label>
          相对文件路径
          <input
            value={path}
            maxLength={1024}
            required
            disabled={creating}
            onChange={(event) => {
              request.current?.abort();
              setBusy(false);
              setReview(undefined);
              continuation.current = undefined;
              setError("");
              setPath(event.target.value);
            }}
          />
        </label>
        <button type="submit" disabled={busy || creating || !path.trim()}>
          {busy ? "检查中…" : "查看三方内容"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {review && (
        <section aria-label="文件检查结果">
          <p>{review.path}：检查时的内容快照；主目录之后仍可能改变。</p>
          <p>
            可在新对话中重新解决此文件：从最新主目录开始，旧修改仅附为参考；原对话及其它私有修改完整保留，不会自动运行或发布。
          </p>
          <button
            type="button"
            disabled={creating}
            onClick={() => void continueResolution()}
          >
            {creating
              ? "正在创建…"
              : continuation.current
                ? "重试同一创建请求"
                : "在新对话中解决"}
          </button>
          <p role="status">
            {review.preview.state === "conflict"
              ? "内容存在冲突或无法自动合并，私有修改保持不变。"
              : "内容可合并；尚未进行依赖检查和候选测试，不表示可以发布。"}
          </p>
          {[
            ["编辑前原文", review.base.content],
            ["私有修改", review.ours.content],
            ["主目录当前内容", review.current.content],
            ...(review.preview.state === "merged"
              ? [["合并预览", review.preview.content]]
              : []),
          ].map(([label, content]) => (
            <section key={label} aria-label={label ?? undefined}>
              <h3>{label}</h3>
              <pre>{display(content ?? null)}</pre>
            </section>
          ))}
        </section>
      )}
    </details>
  );
}
