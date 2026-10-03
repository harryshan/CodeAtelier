/**
 * 把一条已经由 Windows transport 认证的 Agent Runtime IPC 连接接到 Broker capability 与 session adapter。
 * 创建方必须提供该连接的权威 RuntimeExecutionIdentity；本类不读取或相信 Runtime 自报 PID/SID，也不创建 Named Pipe。
 *
 * 1. model_capabilities/model_run 委托 RuntimeBrokerGateway，使模型 endpoint/key 永远留在 Broker Host。
 * 2. model_run 把 provider delta 作为关联原 requestId 的事件回传，再返回完整 ModelResult。
 * 3. approval、受限 Git action、扩展权限命令、任务绑定子状态/问题/租约及 session 只调用显式 handlers；子模型严格比对三个只读工具与 ask_main，拒绝写工具。
 * 4. MCP 与越界命令先审批并保存在当前认证连接的一次性表中，Runtime 获得执行槽后才消费 authorizationId；
 *    git_execute 传递受限 action 和调用 ID，旧 git_push 只传调用 ID；push 等待 Broker 宿主 Git 预检、审批和执行。请求取消只中止对应操作，不结束健康的 Agent Runtime。
 * 5. runtime_complete 是 Runtime 的完成报告，stopping 事件表示其已收到完成确认；取消后的 start_task 不再回复，Broker 需等待 stopping，再结合进程退出、Job 和 cleanup 账本决定可信终态。
 */

import type {
  RuntimeBrokerGateway,
  RuntimeExecutionIdentity,
} from "./runtime-capability-core.js";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { RuntimeIpcPeer } from "./runtime-ipc-peer.js";
import type {
  RuntimeIpcEvent,
  RuntimeIpcRequest,
} from "./runtime-ipc-protocol.js";
import { RUNTIME_IPC_PROTOCOL_VERSION } from "./runtime-ipc-protocol.js";
import type { RuntimeSubagentStoreRequest } from "./runtime-ipc-protocol.js";
import { subagentToolDefinitions } from "../agent/subagent-question-contract.js";
import type { RuntimeTaskSettings } from "./runtime-ipc-protocol.js";
import type {
  GitProcessResult,
  GitRequest,
  GitToolResult,
} from "../tools/git.js";
import type {
  CapabilityCommandRequest,
  CapabilityCommandResult,
} from "./capability-request.js";
import type { McpAction, McpResult } from "../mcp/contracts.js";
import type { ContextSnapshot } from "../context/types.js";

export interface RuntimeIpcBrokerHandlers {
  getErrorSecrets?: () => string[];
  prepareMcp?(
    identity: RuntimeExecutionIdentity,
    request: McpAction,
    toolCallId: string,
    signal: AbortSignal,
  ): Promise<(signal: AbortSignal) => Promise<McpResult>>;
  subagentStore?(
    identity: RuntimeExecutionIdentity,
    request: RuntimeSubagentStoreRequest,
    signal: AbortSignal,
  ): Promise<unknown>;
  acquireSubagentLease?(
    identity: RuntimeExecutionIdentity,
    subagentId: string,
    signal: AbortSignal,
  ): Promise<() => void>;
  authorizeSubagentModel?(
    identity: RuntimeExecutionIdentity,
    subagentId: string,
    requestId: string,
  ): Promise<void>;
  commitSubagentCollect?(
    identity: RuntimeExecutionIdentity,
    body: Extract<
      RuntimeIpcRequest,
      { operation: "session_commit_subagent_collect" }
    >["body"],
  ): Promise<void>;
  traceSpan?(
    event: Extract<
      RuntimeIpcEvent,
      { event: "trace_span_start" | "trace_span_end" }
    >,
  ): void;
  requestApproval(
    identity: RuntimeExecutionIdentity,
    input: { tool: string; description: string; grantKey?: string },
    signal: AbortSignal,
  ): Promise<{ approved: boolean }>;
  executeGitPush(
    identity: RuntimeExecutionIdentity,
    toolCallId: string,
    signal: AbortSignal,
  ): Promise<GitProcessResult>;
  executeGit?(
    identity: RuntimeExecutionIdentity,
    request: GitRequest,
    toolCallId: string,
    signal: AbortSignal,
  ): Promise<GitToolResult>;
  prepareCapabilityCommand(
    identity: RuntimeExecutionIdentity,
    request: CapabilityCommandRequest,
    toolCallId: string,
    signal: AbortSignal,
  ): Promise<(signal: AbortSignal) => Promise<CapabilityCommandResult>>;
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
  appendContext?(
    identity: RuntimeExecutionIdentity,
    items: unknown[],
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
    snapshot: ContextSnapshot,
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
  private runtimeStopped: Promise<void>;
  private resolveRuntimeStopped!: () => void;
  private rejectRuntimeStopped!: (error: Error) => void;
  private readonly subagentLeases = new Map<
    string,
    { subagentId: string; release: () => void }
  >();

  private preparedMcp = new Map<
    string,
    {
      toolCallId: string;
      execute: (signal: AbortSignal) => Promise<McpResult>;
    }
  >();

  private preparedCapabilityCommands = new Map<
    string,
    {
      toolCallId: string;
      execute: (signal: AbortSignal) => Promise<CapabilityCommandResult>;
    }
  >();

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
    this.runtimeStopped = new Promise((resolve, reject) => {
      this.resolveRuntimeStopped = resolve;
      this.rejectRuntimeStopped = reject;
    });
    void this.ready.catch(() => undefined);
    void this.runtimeReady.catch(() => undefined);
    void this.runtimeStopped.catch(() => undefined);
    this.peer = new RuntimeIpcPeer({
      ...streams,
      getErrorSecrets: handlers.getErrorSecrets,
      onClose: (error) => {
        this.preparedMcp.clear();
        this.preparedCapabilityCommands.clear();
        if (!this.authenticated) {
          this.rejectReady(error);
        }

        this.rejectRuntimeReady(error);
        this.rejectRuntimeStopped(error);
      },
      onEvent: (event) => {
        if (!this.authenticated) {
          this.peer.end("Runtime IPC 事件早于身份认证。");

          return;
        }

        if (
          event.event === "trace_span_start" ||
          event.event === "trace_span_end"
        ) {
          this.handlers.traceSpan?.(event);
        }

        if (event.event === "runtime_state" && event.state === "ready") {
          this.resolveRuntimeReady();
        }

        if (event.event === "runtime_state" && event.state === "stopping") {
          this.resolveRuntimeStopped();
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
    this.preparedCapabilityCommands.clear();
    this.peer.event({ type: "event", event: "cancel", reason });
  }

  /** 仅在 Supervisor 已确认该 execution instance 退出/清理后对账；断连不能提前释放仍可能运行的 Worker 额度。 */
  releaseSubagentLeases() {
    for (const lease of this.subagentLeases.values()) {
      lease.release();
    }

    this.subagentLeases.clear();
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

  waitForStop(signal: AbortSignal) {
    return this.waitFor(this.runtimeStopped, signal);
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
      this.peer.end("Runtime IPC 请求早于身份认证。");
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
      case "model_run": {
        if (request.body.purpose === "subagent") {
          const id = request.body.subagentId;
          const childRequestId = request.body.subagentRequestId;
          if (
            !id ||
            !childRequestId ||
            ![...this.subagentLeases.values()].some(
              (lease) => lease.subagentId === id,
            ) ||
            JSON.stringify(request.body.tools) !==
              JSON.stringify(subagentToolDefinitions) ||
            !this.handlers.authorizeSubagentModel
          ) {
            throw new Error(
              "subagent 模型请求未获任务绑定授权或工具白名单无效。",
            );
          }

          await this.handlers.authorizeSubagentModel(
            this.identity,
            id,
            childRequestId,
          );
        } else if (request.body.subagentId || request.body.subagentRequestId) {
          throw new Error("主任务模型请求不能冒用 subagent 身份。");
        }

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
      }

      case "prepare_mcp": {
        if (!this.handlers.prepareMcp || this.preparedMcp.size >= 20) {
          throw new Error("MCP handler 不可用或待执行授权已满。");
        }

        const execute = await this.handlers.prepareMcp(
          this.identity,
          request.body.request,
          request.body.toolCallId,
          signal,
        );
        signal.throwIfAborted();
        const authorizationId = randomUUID();
        this.preparedMcp.set(authorizationId, {
          toolCallId: request.body.toolCallId,
          execute,
        });

        return { authorizationId };
      }

      case "execute_mcp": {
        const prepared = this.preparedMcp.get(request.body.authorizationId);
        if (!prepared || prepared.toolCallId !== request.body.toolCallId) {
          throw new Error("MCP 授权不存在、已消费或不属于当前调用。");
        }

        this.preparedMcp.delete(request.body.authorizationId);

        return prepared.execute(signal);
      }

      case "approval_request":
        return this.handlers.requestApproval(
          this.identity,
          request.body,
          signal,
        );
      case "git_push":
        return this.handlers.executeGitPush(
          this.identity,
          request.body.toolCallId,
          signal,
        );
      case "git_execute":
        if (!this.handlers.executeGit) {
          throw new Error("Broker Git handler 未配置。");
        }

        return this.handlers.executeGit(
          this.identity,
          request.body.request,
          request.body.toolCallId,
          signal,
        );
      case "prepare_run_with_permissions": {
        if (this.preparedCapabilityCommands.size >= 20) {
          throw new Error("待执行的扩展权限授权超过单批工具上限。");
        }

        const execute = await this.handlers.prepareCapabilityCommand(
          this.identity,
          request.body.request,
          request.body.toolCallId,
          signal,
        );
        signal.throwIfAborted();
        const authorizationId = randomUUID();
        this.preparedCapabilityCommands.set(authorizationId, {
          toolCallId: request.body.toolCallId,
          execute,
        });

        return { authorizationId };
      }

      case "run_with_permissions": {
        const prepared = this.preparedCapabilityCommands.get(
          request.body.authorizationId,
        );
        if (!prepared || prepared.toolCallId !== request.body.toolCallId) {
          throw new Error("扩展权限授权不存在、已失效或不属于当前工具调用。");
        }

        // 消费发生在启动前；失败、取消或未知结果都不能重放同一授权。
        this.preparedCapabilityCommands.delete(request.body.authorizationId);

        return prepared.execute(signal);
      }

      case "memory_apply":
        return this.handlers.applyMemory(this.identity, request.body.request);
      case "subagent_store":
        if (!this.handlers.subagentStore) {
          throw new Error("Broker 未启用任务绑定的 subagent 状态适配器。");
        }

        return this.handlers.subagentStore(this.identity, request.body, signal);
      case "subagent_lease_acquire": {
        if (!this.handlers.acquireSubagentLease) {
          throw new Error("Broker 未启用 subagent 全局配额。");
        }

        const release = await this.handlers.acquireSubagentLease(
          this.identity,
          request.body.subagentId,
          signal,
        );
        try {
          signal.throwIfAborted();
          const leaseId = randomUUID();
          this.subagentLeases.set(leaseId, {
            subagentId: request.body.subagentId,
            release,
          });

          return { leaseId };
        } catch (error) {
          release();
          throw error;
        }
      }

      case "subagent_lease_release": {
        const lease = this.subagentLeases.get(request.body.leaseId);
        if (!lease) {
          throw new Error("subagent 租约无效或已释放。");
        }

        this.subagentLeases.delete(request.body.leaseId);
        lease.release();

        return { released: true };
      }

      case "session_commit_subagent_collect":
        if (!this.handlers.commitSubagentCollect) {
          throw new Error("Broker 未启用子报告原子保存。");
        }

        await this.handlers.commitSubagentCollect(this.identity, request.body);

        return { saved: true };
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
      case "session_append_context":
        if (this.handlers.appendContext) {
          await this.handlers.appendContext(this.identity, request.body.items);
        } else {
          // 仅用于旧的内存 handler；生产 Broker 总是实现增量写入。
          const current = await this.handlers.readContext(this.identity);
          await this.handlers.saveContext(this.identity, [
            ...current,
            ...request.body.items,
          ]);
        }

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
