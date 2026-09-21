/**
 * 在 Agent Runtime 内提供最小 session adapter，使恢复和 agent loop 不需要打开宿主 SQLite。
 * 所有数据都通过已认证 RuntimeIpcPeer 请求 Broker；此类不缓存跨任务状态，也不接受任意数据库语句。
 *
 * 1. contextAsync/eventsAsync 读取当前 session 的模型上下文和历史事件，由 Broker 绑定的 identity 决定 session。
 * 2. saveContext 原子请求 Broker 保存完整上下文；失败会传播给 loop，工具副作用后不得假定持久化成功。
 * 3. appendEvent 只接受固定事件名和结构化 data，最终清洗与持久化仍由 Broker handler 负责。
 */

import type { RuntimeIpcPeer } from "./runtime-ipc-peer.js";
import type { Event } from "../shared/types.js";
import type { ContextSnapshot } from "../context/types.js";

export class RuntimeSessionClient {
  constructor(
    private peer: RuntimeIpcPeer,
    private signal: AbortSignal,
  ) {}

  async contextAsync() {
    return (await this.peer.request(
      "session_read_context",
      {},
      this.signal,
    )) as any[];
  }

  async eventsAsync() {
    return (await this.peer.request(
      "session_read_events",
      {},
      this.signal,
    )) as Event[];
  }

  async saveContext(_sessionId: string, input: any[]) {
    await this.peer.request("session_save_context", { input }, this.signal);
  }

  async appendEvent(eventType: string, data: unknown) {
    await this.peer.request(
      "session_append_event",
      { eventType, data },
      this.signal,
    );
  }

  async latestContextSnapshotAsync(_sessionId: string) {
    void _sessionId;

    return (await this.peer.request(
      "session_latest_snapshot",
      {},
      this.signal,
    )) as ContextSnapshot | undefined;
  }

  async contextSnapshotAsync(_sessionId: string, snapshotId: string) {
    return (await this.peer.request(
      "session_read_snapshot",
      { snapshotId },
      this.signal,
    )) as ContextSnapshot | undefined;
  }

  async compactContextAsync(snapshot: ContextSnapshot, input: any[]) {
    await this.peer.request(
      "session_compact",
      { snapshot, input },
      this.signal,
    );
  }
}
