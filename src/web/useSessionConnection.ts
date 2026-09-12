/**
 * 文件作用：管理当前会话的快照同步与 SSE 连接生命周期。
 * 代码结构：Hook 初始化快照和连接状态，再在 effect 内合并刷新、更新凭据及重连，切换会话或停止服务时清理连接并丢弃过期响应。
 */

import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Settings, Snapshot } from "../shared/types";
import { bootstrap, snapshot } from "./api";

/** 会话快照与 SSE 生命周期独立于页面布局，停止服务时禁用连接。 */
export function useSessionConnection(
  selected: string,
  enabled: boolean,
  setSettings: Dispatch<SetStateAction<Settings | undefined>>,
  setHasKey: Dispatch<SetStateAction<boolean>>,
  setError: Dispatch<SetStateAction<string>>,
) {
  const [data, setData] = useState<Snapshot>();
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    if (!selected || !enabled) {
      setData(undefined);

      return;
    }

    // 合并连续刷新通知，并在切换会话或关闭服务时丢弃过期响应。
    let disposed = false;
    let refreshInProgress = false;
    let refreshQueued = false;
    const refresh = async () => {
      if (refreshInProgress) {
        refreshQueued = true;

        return;
      }

      refreshInProgress = true;
      try {
        const v = await snapshot(selected);

        if (!disposed) {
          setData(v);
        }
      } catch (e) {
        if (!disposed) {
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

    void refresh();
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
        await refresh();
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
      clearTimeout(reconnect);
      stream?.close();
    };
  }, [selected, enabled, setSettings, setHasKey, setError]);

  return { data, setData, connected };
}
