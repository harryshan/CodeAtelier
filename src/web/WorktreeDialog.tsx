/**
 * 项目侧栏打开的 Worktree 创建表单，使用现有鉴权 API，不直接运行 Git。
 * 1. 挂载时只读加载本地/远端引用，允许用户选择分支或输入 commit；初始值 HEAD。
 * 2. 首次提交固定请求 UUID 和参数；响应失败后重试同一请求，避免重复创建。
 * 3. 成功交给 App 选择新会话；关闭/失败不清理 checkout，表单说明脏文件与共享 Git 边界。
 * 请求在后端继续完成，不把浏览器关闭视为 Git 已取消；组件不启动模型任务。
 */

import { useEffect, useState } from "react";
import type { Session } from "../shared/types";
import { api } from "./api";
import s from "./app.module.css";

function requestId() {
  // getRandomValues also works on explicitly enabled HTTP LAN deployments.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function WorktreeDialog({
  workspace,
  onClose,
  onCreated,
}: {
  workspace: string;
  onClose: () => void;
  onCreated: (session: Session) => void;
}) {
  const [branches, setBranches] = useState<string[]>([]);
  const [baseRef, setBaseRef] = useState("HEAD");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [id] = useState(requestId);

  useEffect(() => {
    const controller = new AbortController();
    void api<{ branches: string[] }>(
      "/worktrees/inspect",
      { workspace },
      "POST",
      false,
      controller.signal,
    )
      .then((result) => {
        setBranches(result.branches);
        setLoaded(true);
      })
      .catch((failure: Error) => {
        if (!controller.signal.aborted) {
          setError(failure.message);
        }
      });

    return () => controller.abort();
  }, [workspace]);

  const create = async () => {
    setBusy(true);
    setSubmitted(true);
    setError("");
    try {
      const session = await api<Session>("/sessions", {
        workspace,
        worktree: { id, baseRef },
      });
      onCreated(session);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.overlay}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="新建 Worktree 对话"
        className={s.modal}
      >
        <h2>新建 Worktree 对话</h2>
        <p className={s.worktreePath}>{workspace}</p>
        <p>
          从已提交的版本创建独立目录。原目录的未提交改动、依赖和忽略文件不会复制。
        </p>
        <p>
          可用时直接复用原目录的原生 CoW 文件，否则使用普通 Git
          worktree；不创建额外基础副本。
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label className={s.worktreeField}>
            起始分支或 commit
            <input
              autoFocus
              list="worktree-bases"
              value={baseRef}
              onChange={(event) => setBaseRef(event.target.value)}
              disabled={busy || submitted}
              required
              maxLength={1024}
            />
          </label>
          <datalist id="worktree-bases">
            <option value="HEAD" />
            {branches.map((branch) => (
              <option key={branch} value={branch} />
            ))}
          </datalist>
          <p>
            初始为 detached HEAD，可在任务中通过 Git 创建分支。Git 历史和 refs
            与原仓库共享；目录会保留，不会自动清理。
          </p>
          <p>创建由本机后端执行 Git checkout，可能运行仓库配置的过滤器。</p>
          {error && <p role="alert">{error}</p>}
          <div className={s.actions}>
            <button type="button" disabled={busy} onClick={onClose}>
              关闭
            </button>
            <button
              className={s.primary}
              type="submit"
              disabled={!loaded || busy || !baseRef.trim()}
            >
              {busy
                ? "正在创建…"
                : submitted
                  ? "重试同一请求"
                  : "创建 Worktree"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
