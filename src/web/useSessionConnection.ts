/**
 * 为 App 同步当前会话快照，并管理 SSE 连接和断线重试。
 * 接收会话 ID、连接开关及状态回调，返回快照 data、refreshSession 和连接状态 connected。
 *
 * 1. effect 在选中会话后先清除旧快照并标记 loading；refresh 合并连续 SSE 通知，读取最新快照。
 * 2. connect 先 bootstrap 更新凭据、配置和 sandbox 启动初始状态，再建立当前会话的 EventSource；服务建立流时的首个 refresh
 *    是唯一初始快照请求，避免切换时重复下载同一段历史。
 * 3. 收到后续 refresh 或恢复后的 refreshSession 都通过同一游标读取，由 SessionViewModel 增量聚合；连接失败则重试。
 * 4. 清理时标记 disposed、取消进行中的快照、清除定时器并关闭连接；晚到响应不会覆盖新会话。
 *
 * 重连只恢复状态同步，不重发任务。服务停止后通过 enabled 关闭连接和重试。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { SandboxStatus, Settings } from "../shared/types";
import { bootstrap, snapshot } from "./api";
import { SessionViewModel, type SessionView } from "./session-view";

/** 管理快照和 SSE 连接；enabled 为 false 时断开，供关闭服务时使用。 */
export function useSessionConnection(
  selected: string,
  enabled: boolean,
  setSettings: Dispatch<SetStateAction<Settings | undefined>>,
  setHasKey: Dispatch<SetStateAction<boolean>>,
  setSandbox: Dispatch<SetStateAction<SandboxStatus | undefined>>,
  setError: Dispatch<SetStateAction<string>>,
) {
  const [data, setData] = useState<SessionView>();
  const [connected, setConnected] = useState(true);
  const [loading, setLoading] = useState(false);

  const refreshRef = useRef<
    { sessionId: string; refresh: () => Promise<void> } | undefined
  >(undefined);
  const refreshSession = useCallback(async (sessionId: string) => {
    if (refreshRef.current?.sessionId === sessionId) {
      await refreshRef.current.refresh();
    }
  }, []);

  useEffect(() => {
    if (!selected || !enabled) {
      setData(undefined);
      setLoading(false);

      return;
    }

    // 不能在新快照抵达前继续展示旧会话；否则侧栏已切换但主区域看似卡住。
    setData(undefined);
    setLoading(true);
    // 合并连续刷新通知，并在切换会话或关闭服务时取消过期的历史读取。
    let disposed = false;
    const snapshotRequest = new AbortController();
    let refreshInProgress = false;
    let refreshQueued = false;
    const model = new SessionViewModel(selected);
    const refresh = async () => {
      if (refreshInProgress) {
        refreshQueued = true;

        return;
      }

      refreshInProgress = true;
      try {
        const v = await snapshot(
          selected,
          snapshotRequest.signal,
          model.cursor,
        );
        if (!disposed) {
          // 可变索引属于连接回调，不在 render 或 React updater 内修改。
          setData(model.update(v));
          setLoading(false);
        }
      } catch (e) {
        if (!disposed && (e as Error).name !== "AbortError") {
          setLoading(false);
          setError((e as Error).message);
        }
      } finally {
        refreshInProgress = false;
        if (refreshQueued && !disposed) {
          refreshQueued = false;
          void refresh();
        }
      }
    };

    refreshRef.current = { sessionId: selected, refresh };

    let stream: EventSource | undefined;
    let reconnect: ReturnType<typeof setTimeout>;
    const retryConnection = () => {
      if (disposed) {
        return;
      }

      setConnected(false);
      stream?.close();
      clearTimeout(reconnect);
      reconnect = setTimeout(() => void connect(), 2000);
    };

    // 后端重启会更换会话凭据，重连前重新获取，而不是反复使用旧 token。
    const connect = async () => {
      try {
        const v = await bootstrap();

        if (disposed) {
          return;
        }

        setSettings(v.settings);
        setHasKey(v.hasApiKey);
        setSandbox(v.sandbox);
        if (disposed) {
          return;
        }

        stream = new EventSource("/api/sessions/" + selected + "/events");
        stream.addEventListener("refresh", () => void refresh());
        stream.onopen = () => setConnected(true);
        stream.onerror = retryConnection;
      } catch {
        retryConnection();
      }
    };

    void connect();

    return () => {
      disposed = true;
      if (refreshRef.current?.refresh === refresh) {
        refreshRef.current = undefined;
      }

      snapshotRequest.abort();
      clearTimeout(reconnect);
      stream?.close();
    };
  }, [selected, enabled, setSettings, setHasKey, setSandbox, setError]);

  return { data, refreshSession, connected, loading };
}
