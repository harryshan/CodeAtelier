/**
 * 在 Agent Runtime 内实现 ToolRunner 所需的审批和项目记忆窄接口。
 * 审批 UI、分类模型和平台数据目录都留在 Broker Host；Runtime 只发送当前任务绑定的固定 schema 请求。
 *
 * 1. RuntimeApprovalClient 忽略调用方提供的 session/task 路由字段，Broker 使用已认证 identity 归属请求。
 * 2. grantKey 原样绑定审批语义，但不能改变 operation；Broker ApprovalManager 决定是否允许复用。
 * 3. RuntimeMemoryClient 不接收宿主路径，Broker handler 固定使用 identity 对应工作区和项目记忆服务。
 */

import type { Approval } from "../shared/types.js";
import type { RuntimeIpcPeer } from "./runtime-ipc-peer.js";

export class RuntimeApprovalClient {
  constructor(private peer: RuntimeIpcPeer) {}

  async request(
    data: Omit<Approval, "id" | "repeatable">,
    signal: AbortSignal,
    grantKey?: string,
  ) {
    const result = (await this.peer.request(
      "approval_request",
      {
        tool: data.tool,
        description: data.description,
        grantKey,
      },
      signal,
    )) as { approved?: boolean };

    return result.approved === true;
  }
}

export class RuntimeMemoryClient {
  constructor(
    private peer: RuntimeIpcPeer,
    private signal: AbortSignal,
  ) {}

  async apply(
    _scope: { workspace: string; sessionId: string; taskId: string },
    request: unknown,
  ) {
    return this.peer.request("memory_apply", { request }, this.signal);
  }
}
