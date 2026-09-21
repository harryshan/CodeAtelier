/**
 * 把一条已经由 Windows transport 认证的 Agent Runtime IPC 连接接到 Broker capability 与 session adapter。
 * 创建方必须提供该连接的权威 RuntimeExecutionIdentity；本类不读取或相信 Runtime 自报 PID/SID，也不创建 Named Pipe。
 *
 * 1. model_capabilities/model_run 委托 RuntimeBrokerGateway，使模型 endpoint/key 永远留在 Broker Host。
 * 2. model_run 把 provider delta 作为关联原 requestId 的事件回传，再返回完整 ModelResult。
 * 3. approval、结构化 Git push 和 session 操作只调用显式 handlers，不暴露 Store、任意方法名或宿主文件能力。
 * 4. git_push 在同一请求上等待独立 Push Runner；请求取消只中止该 Runner，不结束健康的 Agent Runtime。
 * 5. runtime_complete 是 Runtime 的完成报告；Broker 仍须结合进程退出、Job 和 cleanup 账本决定可信终态。
 */

import type {
  RuntimeBrokerGateway,
  RuntimeExecutionIdentity,
} from "./runtime-capability-core.js";
import type { Readable, Writable } from "node:stream";
import { RuntimeIpcPeer } from "./runtime-ipc-peer.js";
import type { RuntimeIpcRequest } from "./runtime-ipc-protocol.js";
import { RUNTIME_IPC_PROTOCOL_VERSION } from "./runtime-ipc-protocol.js";
import type { RuntimeTaskSettings } from "./runtime-ipc-protocol.js";
import type { GitPushSpec, GitProcessResult } from "../tools/git.js";

export interface RuntimeIpcBrokerHandlers {
  requestApproval(
    identity: RuntimeExecutionIdentity,
    input: { tool: string; description: string; grantKey?: string },
    signal: AbortSignal,
  ): Promise<{ approved: boolean }>;
  executeGitPush(
    identity: RuntimeExecutionIdentity,
    spec: GitPushSpec,
    signal: AbortSignal,
  ): Promise<GitProcessResult>;
  applyMemory(
    identity: RuntimeExecutionIdentity,
    request: unknown,
  ): Promise<unknown>;
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
  readEvents(identity: RuntimeExecutionIdentity): Promise<unknown[]>;
  latestContextSnapshot(identity: RuntimeExecutionIdentity): Promise<unknown>;
  readContextSnapshot(
    identity: RuntimeExecutionIdentity,
    snapshotId: string,
  ): Promise<unknown>;
  compactContext(
    identity: RuntimeExecutionIdentity,
    snapshot: unknown,
    input: unknown[],
  ): Promise<void>;
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
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private runtimeReady: Promise<void>;
  private resolveRuntimeReady!: () => void;
  private rejectRuntimeReady!: (error: Error) => void;

  constructor(
    streams: { input: Readable; output: Writable },
    private identity: RuntimeExecutionIdentity,
    private nonce: string,
    private gateway: RuntimeBrokerGateway,
    private handlers: RuntimeIpcBrokerHandlers,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.runtimeReady = new Promise((resolve, reject) => {
      this.resolveRuntimeReady = resolve;
      this.rejectRuntimeReady = reject;
    });
    void this.ready.catch(() => undefined);
    void this.runtimeReady.catch(() => undefined);
    this.peer = new RuntimeIpcPeer({
      ...streams,
      onClose: (error) => {
        if (!this.authenticated) {
          this.rejectReady(error);
        }

        this.rejectRuntimeReady(error);
      },
      onEvent: (event) => {
        if (event.event === "runtime_state" && event.state === "ready") {
          this.resolveRuntimeReady();
        }
      },
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
        this.resolveReady();
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

  async startTask(
    input: {
      workspace: string;
      prompt: string;
      settings: RuntimeTaskSettings;
      memoryText?: string;
    },
    signal: AbortSignal,
  ) {
    await this.waitFor(this.ready, signal);
    await this.waitFor(this.runtimeReady, signal);

    return this.peer.request("start_task", input, signal);
  }

  private waitFor(ready: Promise<void>, signal: AbortSignal) {
    signal.throwIfAborted();

    return new Promise<void>((resolve, reject) => {
      const aborted = () => {
        cleanup();
        reject(signal.reason ?? new Error("任务已取消"));
      };

      const cleanup = () => signal.removeEventListener("abort", aborted);
      signal.addEventListener("abort", aborted, { once: true });
      ready.then(
        () => {
          cleanup();
          resolve();
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  private async handle(request: RuntimeIpcRequest, signal: AbortSignal) {
    if (!this.authenticated) {
      throw new Error("Runtime IPC 尚未完成握手。");
    }

    switch (request.operation) {
      case "start_task":
        throw new Error("Broker Host 不接受 start_task 请求。");
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
      case "git_push":
        return this.handlers.executeGitPush(
          this.identity,
          request.body.spec,
          signal,
        );
      case "memory_apply":
        return this.handlers.applyMemory(this.identity, request.body.request);
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
      case "session_read_events":
        return this.handlers.readEvents(this.identity);
      case "session_latest_snapshot":
        return this.handlers.latestContextSnapshot(this.identity);
      case "session_read_snapshot":
        return this.handlers.readContextSnapshot(
          this.identity,
          request.body.snapshotId,
        );
      case "session_compact":
        await this.handlers.compactContext(
          this.identity,
          request.body.snapshot,
          request.body.input,
        );

        return { saved: true };
      case "runtime_complete":
        await this.handlers.runtimeCompleted(this.identity, request.body);

        return { recorded: true };
    }
  }
}
