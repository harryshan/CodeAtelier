/**
 * 在 Agent Runtime 内实现 ToolRunner 所需的审批、项目记忆、Broker 宿主 Git push 和宿主命令窄接口。
 * 审批 UI、分类模型和平台数据目录都留在 Broker Host；Runtime 只发送当前任务绑定的固定 schema 请求。
 *
 * 1. RuntimeApprovalClient 忽略调用方提供的 session/task 路由字段，Broker 使用已认证 identity 归属请求。
 * 2. grantKey 原样绑定审批语义，但不能改变 operation；Broker ApprovalManager 决定是否允许复用。
 * 3. RuntimeMemoryClient 不接收宿主路径，Broker handler 固定使用 identity 对应工作区和项目记忆服务。
 * 4. RuntimeGitPushClient 只发送当前 toolCallId；Broker 完成 Git 预检、审批和宿主推送。
 * 5. RuntimeCapabilityClient 先发送命令、理由和 toolCallId 完成 Broker 审批；调用方取得
 *    Tool worker 槽后才用一次性 authorizationId 启动 Broker 宿主命令，审批等待不会占用执行槽。
 */

import type { Approval } from "../shared/types.js";
import type { RuntimeIpcPeer } from "./runtime-ipc-peer.js";
import { runtimeGitPushResultSchema } from "./runtime-ipc-protocol.js";
import {
  capabilityCommandResultSchema,
  type CapabilityCommandRequest,
} from "./capability-request.js";

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

export class RuntimeGitPushClient {
  constructor(private peer: RuntimeIpcPeer) {}

  async execute(toolCallId: string, signal: AbortSignal) {
    const result = await this.peer.request("git_push", { toolCallId }, signal);

    return runtimeGitPushResultSchema.parse(result);
  }
}

export class RuntimeCapabilityClient {
  constructor(private peer: RuntimeIpcPeer) {}

  async prepare(
    request: CapabilityCommandRequest,
    toolCallId: string,
    signal: AbortSignal,
  ) {
    const prepared = (await this.peer.request(
      "prepare_run_with_permissions",
      { toolCallId, request },
      signal,
    )) as { authorizationId?: unknown };
    if (
      typeof prepared.authorizationId !== "string" ||
      !prepared.authorizationId
    ) {
      throw new Error("Broker 未返回有效的扩展权限授权标识。");
    }

    return async () => {
      const result = await this.peer.request(
        "run_with_permissions",
        { toolCallId, authorizationId: prepared.authorizationId },
        signal,
      );

      return capabilityCommandResultSchema.parse(result);
    };
  }
}
