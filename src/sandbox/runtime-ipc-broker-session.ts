/**
 * 把一条已经由 Windows transport 认证的 Agent Runtime IPC 连接接到 Broker capability 与 session adapter。
 * 创建方必须提供该连接的权威 RuntimeExecutionIdentity；本类不读取或相信 Runtime 自报 PID/SID，也不创建 Named Pipe。
 *
 * 1. model_capabilities/model_run 委托 RuntimeBrokerGateway，使模型 endpoint/key 永远留在 Broker Host。
 * 2. model_run 把 provider delta 作为关联原 requestId 的事件回传，再返回完整 ModelResult。
 * 3. approval 和 session 操作只调用显式 handlers，不暴露 Store、任意方法名或宿主文件能力。
 * 4. runtime_complete 是 Runtime 的完成报告；Broker 仍须结合进程退出、Job 和 cleanup 账本决定可信终态。
 */

import type {
  RuntimeBrokerGateway,
  RuntimeExecutionIdentity,
} from "./runtime-capability-core.js";
import type { Readable, Writable } from "node:stream";
import { RuntimeIpcPeer } from "./runtime-ipc-peer.js";
import type { RuntimeIpcRequest } from "./runtime-ipc-protocol.js";
import { RUNTIME_IPC_PROTOCOL_VERSION } from "./runtime-ipc-protocol.js";

export interface RuntimeIpcBrokerHandlers {
  requestApproval(
    identity: RuntimeExecutionIdentity,
    input: { tool: string; description: string },
    signal: AbortSignal,
  ): Promise<{ approved: boolean }>;
  appendSessionEvent(
    identity: RuntimeExecutionIdentity,
    eventType: string,
    data: unknown,
  ): Promise<void>;
  saveContext(
    identity: RuntimeExecutionIdentity,
    input: unknown[],
  ): Promise<void>;
  readContext(identity: RuntimeExecutionIdentity): Promise<unknown[]>;
  runtimeCompleted(
    identity: RuntimeExecutionIdentity,
    result: {
      status: "completed" | "failed" | "cancelled" | "interrupted";
      failure?: string;
    },
  ): Promise<void>;
}

export class RuntimeIpcBrokerSession {
  readonly peer: RuntimeIpcPeer;
  private authenticated = false;

  constructor(
    streams: { input: Readable; output: Writable },
    private identity: RuntimeExecutionIdentity,
    private nonce: string,
    private gateway: RuntimeBrokerGateway,
    private handlers: RuntimeIpcBrokerHandlers,
  ) {
    this.peer = new RuntimeIpcPeer({
      ...streams,
      onHandshake: (message) => {
        if (message.type !== "runtime_hello") {
          this.peer.end("Runtime IPC 握手方向无效。");
          return;
        }
        if (
          this.authenticated ||
          message.sessionId !== this.identity.sessionId ||
          message.taskId !== this.identity.taskId ||
          message.executionInstanceId !== this.identity.executionInstanceId ||
          message.nonce !== this.nonce
        ) {
          this.peer.end("Runtime IPC 握手身份不匹配。");
          return;
        }
        this.authenticated = true;
        this.peer.handshake({
          type: "broker_hello",
          protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
          executionInstanceId: this.identity.executionInstanceId,
        });
      },
      handleRequest: (request, signal) => this.handle(request, signal),
    });
  }

  cancel(reason: string) {
    this.peer.event({ type: "event", event: "cancel", reason });
  }

  private async handle(request: RuntimeIpcRequest, signal: AbortSignal) {
    if (!this.authenticated) {
      throw new Error("Runtime IPC 尚未完成握手。");
    }
    switch (request.operation) {
      case "model_capabilities":
        return this.gateway.requestModelCapabilities(
          this.identity,
          request.body.purpose,
          signal,
        );
      case "model_run":
        return this.gateway.requestModel(
          this.identity,
          { requestId: request.requestId, ...request.body },
          signal,
          (text) =>
            this.peer.event({
              type: "event",
              event: "model_delta",
              requestId: request.requestId,
              text,
            }),
        );
      case "approval_request":
        return this.handlers.requestApproval(
          this.identity,
          request.body,
          signal,
        );
      case "session_append_event":
        await this.handlers.appendSessionEvent(
          this.identity,
          request.body.eventType,
          request.body.data,
        );
        return { saved: true };
      case "session_save_context":
        await this.handlers.saveContext(this.identity, request.body.input);
        return { saved: true };
      case "session_read_context":
        return this.handlers.readContext(this.identity);
      case "runtime_complete":
        await this.handlers.runtimeCompleted(this.identity, request.body);
        return { recorded: true };
    }
  }
}
