/*
 * Agent Runtime 中的任务绑定 subagent 存储与全局租约适配器，供 SubagentCoordinator 使用。
 *
 * 1. Storage 的固定 action 只能经认证 Runtime IPC 访问本任务子状态及有界问题事件；Runtime 不打开宿主 SQLite。
 * 2. acquire 向 Broker 申请全服务共享的租约，Worker 退出后确认释放；取消中的释放使用独立短超时。
 * 3. 调用者先停止 Worker 再等待 release 回执，断连未知时由 Broker 在执行实例清理确认后对账。
 *
 * 子 Worker 只通过协调器提出模型或只读请求，不持有本 adapter/IPC peer。
 */

import type { RuntimeIpcPeer } from "./runtime-ipc-peer.js";
import type { SubagentStorage } from "../agent/subagent-coordinator.js";
import type { SubtaskPlan } from "../agent/subagent-contracts.js";
import type { SubagentRecord, SubagentStatus } from "../shared/types.js";

export class RuntimeSubagentClient implements SubagentStorage {
  constructor(
    private readonly peer: RuntimeIpcPeer,
    private readonly taskId: string,
    private readonly signal: AbortSignal,
  ) {}

  private assertTask(taskId: string) {
    if (taskId !== this.taskId) {
      throw new Error("Runtime subagent 操作不属于当前任务。");
    }
  }

  async planSubagents(taskId: string, subtasks: SubtaskPlan[]) {
    this.assertTask(taskId);

    return (await this.peer.request(
      "subagent_store",
      { action: "plan", subtasks },
      this.signal,
    )) as SubagentRecord[];
  }

  async subagents(taskId: string) {
    this.assertTask(taskId);

    return (await this.peer.request(
      "subagent_store",
      { action: "list" },
      this.signal,
    )) as SubagentRecord[];
  }

  async updateSubagent(
    taskId: string,
    subagentId: string,
    status: SubagentStatus,
    context: unknown[],
    report?: string,
  ) {
    this.assertTask(taskId);

    return this.peer.request(
      "subagent_store",
      { action: "update", subagentId, status, context, report },
      AbortSignal.timeout(10_000),
    );
  }

  async startSubagentRequest(
    taskId: string,
    subagentId: string,
    requestId: string,
    kind: string,
  ) {
    this.assertTask(taskId);

    return this.peer.request(
      "subagent_store",
      { action: "request_start", subagentId, requestId, kind },
      this.signal,
    );
  }

  async finishSubagentRequest(
    taskId: string,
    subagentId: string,
    requestId: string,
    result: unknown,
  ) {
    this.assertTask(taskId);

    return this.peer.request(
      "subagent_store",
      { action: "request_finish", subagentId, requestId, result },
      AbortSignal.timeout(10_000),
    );
  }

  async recordSubagentQuestion(
    taskId: string,
    subagentId: string,
    requestId: string,
    question: string,
  ) {
    this.assertTask(taskId);

    return (await this.peer.request(
      "subagent_store",
      { action: "question", subagentId, requestId, question },
      this.signal,
    )) as Awaited<ReturnType<SubagentStorage["recordSubagentQuestion"]>>;
  }

  async collectSubagents(taskId: string, ids: string[]) {
    this.assertTask(taskId);

    return (await this.peer.request(
      "subagent_store",
      { action: "collect", ids },
      this.signal,
    )) as Awaited<ReturnType<SubagentStorage["collectSubagents"]>>;
  }

  async acquire(
    taskId: string,
    signal: AbortSignal,
    subagentId?: string,
  ): Promise<() => Promise<void>> {
    this.assertTask(taskId);
    if (!subagentId) {
      throw new Error("子任务租约需要已登记的 subagent ID。");
    }

    const { leaseId } = (await this.peer.request(
      "subagent_lease_acquire",
      { subagentId },
      signal,
    )) as { leaseId: string };

    return async () => {
      await this.peer.request(
        "subagent_lease_release",
        { leaseId },
        AbortSignal.timeout(10_000),
      );
    };
  }
}
