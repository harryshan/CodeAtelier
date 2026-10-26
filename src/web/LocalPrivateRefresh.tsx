/**
 * 已发布批次的私有刷新入口，由 LocalOverlayStatus 在存在排空凭据时显示。
 * 1. 用户明确请求空参数恢复；后端绑定会话和批次，不提交任务或重新发布来源。
 * 2. 成功或失败均重新读取会话状态，避免丢失响应后 UI 继续展示旧失败状态。
 * 3. 卸载取消请求并忽略晚到结果；草稿不改动，来源事故解锁保持独立操作。
 */
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

export function LocalPrivateRefresh({
  sessionId,
  onUpdated,
}: {
  sessionId: string;
  onUpdated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => pending.current?.abort(), []);

  const recover = async () => {
    const abort = new AbortController();
    pending.current = abort;
    setBusy(true);
    setError("");
    try {
      await api(
        `/sessions/${sessionId}/local-refresh`,
        {},
        "POST",
        false,
        abort.signal,
      );
    } catch (failure) {
      if (!abort.signal.aborted) {
        setError((failure as Error).message);
      }
    } finally {
      if (!abort.signal.aborted) {
        setBusy(false);
        onUpdated();
      }
    }
  };

  return (
    <section aria-label="恢复私有刷新">
      <p>
        源码已发布，但私有视图尚未确认刷新。恢复只确认该批次并保留未选修改，不重新执行任务或写回源码。若来源仍被锁定，请先核查发布现场。
      </p>
      <button type="button" disabled={busy} onClick={() => void recover()}>
        恢复已发布批次的私有视图
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
