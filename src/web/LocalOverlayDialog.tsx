/**
 * 显式创建隔离 Local 会话的表单，供 App 的项目页与来源项目侧栏调用。
 * 1. 打开时读取当前后端能力；只展示可操作的前提，不探测文件系统或启动任务。
 * 2. 每次打开固定 UUID，失败后重试同一来源/请求；关闭不撤销可能已在后端完成的创建。
 * 3. 返回会话交给 App 按来源归组，说明私有写入、选定发布、无 Git 及失败保留边界。
 * 不修改默认模式、不迁移历史、不自动批准安装/权限或发起模型执行。
 */
import { useEffect, useState } from "react";
import type { LocalOverlayCreation, Session } from "../shared/types";
import { api, bootstrap } from "./api";
import { requestId } from "./WorktreeDialog";
import s from "./app.module.css";

export function LocalOverlayDialog({
  workspace,
  onClose,
  onCreated,
}: {
  workspace: string;
  onClose: () => void;
  onCreated: (session: Session) => void;
}) {
  const [id] = useState(requestId);
  const [capability, setCapability] = useState<LocalOverlayCreation>();
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let closed = false;
    void bootstrap()
      .then((value) => {
        if (!closed) {
          setCapability(
            value.localOverlayCreation ?? {
              enabled: false,
              reason: "当前服务不支持隔离 Local，请更新服务。",
            },
          );
        }
      })
      .catch((failure: Error) => {
        if (!closed) {
          setError(failure.message);
        }
      });

    return () => {
      closed = true;
    };
  }, []);

  const create = async () => {
    setBusy(true);
    setSubmitted(true);
    setError("");
    try {
      const session = await api<Session>("/sessions", {
        workspace,
        localOverlay: { id },
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
        aria-label="新建隔离 Local 对话"
        className={s.modal}
      >
        <h2>新建隔离 Local 对话</h2>
        <p className={s.worktreePath}>{workspace}</p>
        <p>
          按需读取主目录，编辑先保留在本对话的私有视图。无需 Git
          仓库，也不会复制整个项目。
        </p>
        <p>
          任务成功后，只发布模型明确选择并通过验证的源码。冲突、验证失败或取消时保留私有修改；其他产物不会自动发布。
        </p>
        <p>
          视图不提供主目录的仓库元数据。需要已准备好的文件系统后端和
          Sandbox；启动失败不会转为宿主执行。
        </p>
        {capability?.reason && <p role="status">{capability.reason}</p>}
        {error && <p role="alert">{error}</p>}
        <div className={s.actions}>
          <button type="button" autoFocus disabled={busy} onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className={s.primary}
            disabled={busy || !capability?.enabled}
            onClick={() => void create()}
          >
            {busy ? "正在创建…" : submitted ? "重试同一请求" : "创建隔离 Local"}
          </button>
        </div>
      </section>
    </div>
  );
}
