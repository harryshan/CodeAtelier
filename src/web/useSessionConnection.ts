/**
 * 为 App 同步当前会话快照，并管理 SSE 连接和断线重试。
 * 接收会话 ID、连接开关及状态回调，返回有界快照、分页动作及连接状态。
 *
 * 1. effect 切换会话时清理旧状态；首个 refresh 只读取最近 100 条，之后按游标读取新增事件。
 * 2. older/newer 按页双向移动固定大小的浏览器窗口；旧页浏览时 SSE 只更新任务状态和最新游标，不将远端事件混入不相邻的窗口。
 * 3. connect 先 bootstrap 更新凭据和配置，再建立 EventSource；连续 refresh 合并处理，断线后重试。
 * 4. 清理时取消正在进行的历史请求并关闭连接；晚到响应不能覆盖切换后的会话。
 *
 * 重连只恢复状态同步，不重发任务。服务停止后通过 enabled 关闭连接和重试。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { SandboxStatus, Settings, Snapshot } from "../shared/types";
import { bootstrap, snapshot } from "./api";

/** 管理快照和 SSE 连接；enabled 为 false 时断开，供关闭服务时使用。 */
export function useSessionConnection(
  selected: string,
  enabled: boolean,
  setSettings: Dispatch<SetStateAction<Settings | undefined>>,
  setHasKey: Dispatch<SetStateAction<boolean>>,
  setSandbox: Dispatch<SetStateAction<SandboxStatus | undefined>>,
  setError: Dispatch<SetStateAction<string>>,
) {
  const [data, setData] = useState<Snapshot>();
  const [connected, setConnected] = useState(true);
  const [loading, setLoading] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [hasNewer, setHasNewer] = useState(false);
  const [atLatest, setAtLatest] = useState(true);
  const pager = useRef<{
    older: () => Promise<boolean>;
    newer: () => Promise<boolean>;
  } | null>(null);
  const loadOlder = useCallback(
    () => pager.current?.older() ?? Promise.resolve(false),
    [],
  );
  const loadNewer = useCallback(
    () => pager.current?.newer() ?? Promise.resolve(false),
    [],
  );

  useEffect(() => {
    if (!selected || !enabled) {
      setData(undefined);
      setLoading(false);
      setHasOlder(false);
      setHasNewer(false);
      pager.current = null;

      return;
    }

    // 不能在新快照抵达前继续展示旧会话；否则侧栏已切换但主区域看似卡住。
    setData(undefined);
    setLoading(true);
    setHasOlder(false);
    setHasNewer(false);
    setAtLatest(true);
    // 合并连续刷新通知，并在切换会话或关闭服务时取消过期的历史读取。
    let disposed = false;
    const snapshotRequest = new AbortController();
    let refreshInProgress = false;
    let refreshQueued = false;
    let lastEventId = 0;
    let windowData: Snapshot | undefined;
    let browsingLatest = true;
    let paging = false;

    const readPage = async (direction: "older" | "newer") => {
      if (disposed || paging || !windowData?.events.length) {
        return false;
      }

      paging = true;
      try {
        const before = direction === "older" ? windowData.events[0].id : 0;
        const after = direction === "newer" ? windowData.events.at(-1)!.id : 0;
        // 保留半页重叠，向上/向下滚动时不会整屏替换内容。
        const page = await snapshot(
          selected,
          snapshotRequest.signal,
          after,
          before,
          50,
        );
        if (disposed || page.events.length === 0) {
          return false;
        }

        const combined =
          direction === "older"
            ? [...page.events, ...windowData.events]
            : [...windowData.events, ...page.events];
        const events =
          direction === "older" ? combined.slice(0, 100) : combined.slice(-100);
        const hasOlderEvents =
          direction === "older"
            ? (page.hasOlderEvents ?? false)
            : combined.length > 100 || windowData.hasOlderEvents;
        const newerTaskId =
          combined.length > 100 && direction === "older"
            ? combined[100].taskId
            : page.newerTaskId;
        lastEventId = Math.max(lastEventId, page.events.at(-1)!.id);
        browsingLatest =
          !page.hasNewerEvents && events.at(-1)!.id >= lastEventId;
        windowData = {
          ...page,
          events,
          hasOlderEvents,
          hasNewerEvents: !browsingLatest,
          newerTaskId: browsingLatest ? undefined : newerTaskId,
        };
        setData(windowData);
        setHasOlder(Boolean(hasOlderEvents));
        setHasNewer(!browsingLatest);
        setAtLatest(browsingLatest);

        return true;
      } catch (error) {
        if (!disposed && (error as Error).name !== "AbortError") {
          setError((error as Error).message);
        }

        return false;
      } finally {
        paging = false;
      }
    };

    pager.current = {
      older: () => readPage("older"),
      newer: () => readPage("newer"),
    };
    const refresh = async () => {
      if (refreshInProgress) {
        refreshQueued = true;

        return;
      }

      refreshInProgress = true;
      try {
        const cursor = lastEventId;
        const v = await snapshot(selected, snapshotRequest.signal, cursor);
        if (disposed) {
          return;
        }

        lastEventId = v.events.at(-1)?.id ?? lastEventId;
        if (!windowData) {
          windowData = v;
          setHasOlder(Boolean(v.hasOlderEvents));
        } else if (browsingLatest) {
          const events = [...windowData.events, ...v.events];
          windowData = {
            ...v,
            events: events.slice(-100),
            hasOlderEvents: events.length > 100 || windowData.hasOlderEvents,
          };
          setHasOlder(Boolean(windowData.hasOlderEvents));
        } else {
          windowData = {
            ...v,
            events: windowData.events,
            hasOlderEvents: windowData.hasOlderEvents,
            hasNewerEvents: true,
            newerTaskId: windowData.newerTaskId,
          };
          setHasNewer(lastEventId > (windowData.events.at(-1)?.id ?? 0));
        }

        setData(windowData);
        setLoading(false);
        // 大于单页的断线积压需继续读取；不能跳过中间事件或无限增加内存。
        if (v.hasNewerEvents && v.events.length) {
          refreshQueued = true;
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
      snapshotRequest.abort();
      clearTimeout(reconnect);
      stream?.close();
      pager.current = null;
    };
  }, [selected, enabled, setSettings, setHasKey, setSandbox, setError]);

  return {
    data,
    connected,
    loading,
    hasOlder,
    hasNewer,
    atLatest,
    loadOlder,
    loadNewer,
  };
}
