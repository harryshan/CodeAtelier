/**
 * Local 会话的批量内容检查面板，由状态组件挂载，不触发任务或发布。
 * 1. 用户按行输入最多 100 个相对路径后请求整组已封存 B/O/T；请求期间禁用重复提交。
 * 2. 编辑路径、切换会话/代次/状态或卸载均取消请求并丢弃晚到响应，不持久保存正文。
 * 3. 各文件按需展开为纯文本，展示原文、私有结果、来源现状和合并预览；二进制只报大小，长文本明确截断。
 * 预览不是测试或发布结果，没有自动重试、执行源码或写回入口。
 * 4. 用户可固定 UUID 创建新对话携带参考；成功交给 App，不自动提交任务，失败重试同一请求，卸载后不切换回旧操作。
 * 5. displayLocalContent 也供发布事故检查使用，统一纯文本、二进制与截断显示，不执行内容。
 * 6. interrupted 模式只显示 B/中断私有字节和部分写入提示；显式请求携带状态，不提供合并预览或自动应用。
 */
import { useEffect, useRef, useState } from "react";
import type {
  LocalFileReview as Review,
  LocalReviewBatch,
} from "../local-overlays/publication/review";
import type { InterruptedReview } from "../local-overlays/interrupted-review";
import { api } from "./api";
import type { Session } from "../shared/types";
import { requestId } from "./WorktreeDialog";
import s from "./app.module.css";

export function displayLocalContent(content: string | null) {
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

function FileContents({
  review,
  initialOpen,
}: {
  review: Review | InterruptedReview["files"][number];
  initialOpen: boolean;
}) {
  const [expanded, setExpanded] = useState(initialOpen);
  const interrupted = "private" in review;

  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>{review.path}</summary>
      {expanded && (
        <>
          <p role="status">
            {interrupted
              ? "中断参考可能包含部分写入或未完成的删除，不代表完整修改、成功任务或已发布结果。"
              : review.preview.state === "conflict"
                ? "内容存在冲突或无法自动合并，私有修改保持不变。"
                : "内容可合并；尚未进行依赖检查和候选测试，不表示可以发布。"}
          </p>
          {[
            ["编辑前原文", review.base.content],
            ...(interrupted
              ? [["中断私有内容", review.private.content]]
              : [
                  ["私有修改", review.ours.content],
                  ["主目录当前内容", review.current.content],
                  ...(review.preview.state === "merged"
                    ? [["合并预览", review.preview.content]]
                    : []),
                ]),
          ].map(([label, content]) => (
            <section key={label} aria-label={label ?? undefined}>
              <h3>{label}</h3>
              <pre>{displayLocalContent(content ?? null)}</pre>
            </section>
          ))}
        </>
      )}
    </details>
  );
}

export function LocalFileReview({
  sessionId,
  onCreated,
  interrupted = false,
}: {
  sessionId: string;
  onCreated: (session: Session) => void;
  interrupted?: boolean;
}) {
  const [pathsText, setPathsText] = useState("");
  const [review, setReview] = useState<LocalReviewBatch | InterruptedReview>();
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
          paths: review.files.map((file) => file.path),
          version: review.version,
          ...(interrupted ? { state: "interrupted" } : {}),
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
      const result = await api<LocalReviewBatch | InterruptedReview>(
        `/sessions/${sessionId}/local-review`,
        {
          paths: pathsText.split(/\r?\n/).filter((file) => file.length > 0),
          ...(interrupted ? { state: "interrupted" } : {}),
        },
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
      <summary>{interrupted ? "检查中断参考" : "检查私有修改"}</summary>
      {interrupted && (
        <p>
          仅在旧执行退出证明可确认后读取。材料可能不完整；检查和创建参考会话都不解锁、重挂载或发布原卷，也不解除来源发布事故。
        </p>
      )}
      <p>
        输入已修改文件的相对路径（目录分隔符使用 /），每行一个，最多 100
        个。内容与预览合计最多 16 MiB，检查不会发布修改。
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void inspect();
        }}
      >
        <label>
          相对文件路径
          <textarea
            value={pathsText}
            maxLength={16384}
            rows={3}
            required
            disabled={creating}
            onChange={(event) => {
              request.current?.abort();
              setBusy(false);
              setReview(undefined);
              continuation.current = undefined;
              setError("");
              setPathsText(event.target.value);
            }}
          />
        </label>
        <button type="submit" disabled={busy || creating || !pathsText.trim()}>
          {busy ? "检查中…" : interrupted ? "查看中断内容" : "查看三方内容"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {review && (
        <section aria-label="文件检查结果">
          <p>已检查 {review.files.length} 个文件；主目录之后仍可能改变。</p>
          <p>
            可在新对话中重新解决所选文件：从最新主目录开始，旧修改仅附为参考；原对话及其它私有修改完整保留，不会自动运行或发布。任何选定材料变化都需重新检查整组。
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
          {review.files.map((file, index) => (
            <FileContents
              key={`${review.version}:${file.path}`}
              review={file}
              initialOpen={index === 0}
            />
          ))}
        </section>
      )}
    </details>
  );
}
