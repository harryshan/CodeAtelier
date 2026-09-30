/**
 * 在一对已认证的双向字节流上实现 Agent Runtime IPC 的有界 JSONL request/response/event 路由。
 * Windows 产品 transport 负责先验证连接身份；本类只处理应用协议，不能单独证明 Named Pipe、PID 或 Job 边界。
 *
 * 1. request 生成不可复用 requestId、注册取消监听并等待精确匹配的 response；本地取消发送 request_cancel 以中止远端 handler。
 * 2. consume 逐帧校验 schema 和大小；非法帧、重复/未知 response 或半帧断开会关闭整条连接。
 * 3. 收到 request 后调用固定 handler，返回操作、关联 ID、脱敏原因及错误码；event/handshake observer 抛错时安全关闭通道。
 * 4. 已取消 requestId 使用有界 tombstone 忽略竞态中的迟到响应，其他未知响应仍关闭连接。
 * 5. close 使全部 pending/handling 请求失败并移除监听，避免断连后把未知操作当成成功或继续等待。
 */

import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import {
  ipcErrorText,
  ipcFailureDetails,
  ipcSchemaDetails,
} from "./runtime-ipc-error-details.js";
import {
  MAX_RUNTIME_IPC_FRAME_BYTES,
  runtimeIpcMessageSchema,
  runtimeRequestSchema,
  type RuntimeIpcEvent,
  type RuntimeIpcMessage,
  type RuntimeIpcOperation,
  type RuntimeIpcRequest,
  type RuntimeIpcResponse,
} from "./runtime-ipc-protocol.js";

interface PendingRequest {
  operation: RuntimeIpcOperation;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  removeAbortListener: () => void;
}

export class RuntimeIpcError extends Error {
  constructor(
    message: string,
    readonly code = "SANDBOX_RUNTIME_IPC",
    readonly retryable = false,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly providerRequestId?: string,
  ) {
    super(message);
    this.name = "RuntimeIpcError";
  }
}

export interface RuntimeIpcPeerOptions {
  input: Readable;
  output: Writable;
  handleRequest?: (
    request: RuntimeIpcRequest,
    signal: AbortSignal,
  ) => Promise<unknown>;
  onEvent?: (event: RuntimeIpcEvent) => void;
  onHandshake?: (
    message: Extract<
      RuntimeIpcMessage,
      { type: "runtime_hello" | "broker_hello" }
    >,
  ) => void;
  onClose?: (error: RuntimeIpcError) => void;
  maxFrameBytes?: number;
  /** Broker 提供当前凭据，仅用于错误脱敏，绝不放入协议帧。 */
  getErrorSecrets?: () => string[];
}

export class RuntimeIpcPeer {
  private buffer = "";
  private failure?: RuntimeIpcError;
  private pending = new Map<string, PendingRequest>();
  private handling = new Map<string, AbortController>();
  private cancelledPending = new Set<string>();
  private cancelledPendingOrder: string[] = [];
  private eventListeners = new Set<(event: RuntimeIpcEvent) => void>();
  private maxFrameBytes: number;
  private requestHandler?: RuntimeIpcPeerOptions["handleRequest"];

  constructor(private options: RuntimeIpcPeerOptions) {
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_RUNTIME_IPC_FRAME_BYTES;
    this.requestHandler = options.handleRequest;
    options.input.setEncoding("utf8");
    options.input.on("data", (chunk: string) => this.consume(chunk));
    options.input.once("error", (error) =>
      this.close(`Runtime IPC 输入读取失败：${ipcFailureDetails(error)}`),
    );
    options.input.once("end", () => this.close("Runtime IPC 输入已关闭。"));
    options.output.once("error", (error) =>
      this.close(`Runtime IPC 输出写入失败：${ipcFailureDetails(error)}`),
    );
  }

  request(
    operation: RuntimeIpcOperation,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.startRequest(operation, body, signal).result;
  }

  startRequest(
    operation: RuntimeIpcOperation,
    body: unknown,
    signal: AbortSignal,
  ): { requestId: string; result: Promise<unknown> } {
    signal.throwIfAborted();
    if (this.failure) {
      return { requestId: "", result: Promise.reject(this.failure) };
    }

    const request = {
      type: "request" as const,
      requestId: randomUUID(),
      operation,
      body,
    };
    const parsed = runtimeRequestSchema.safeParse(request);
    if (!parsed.success || parsed.data.type !== "request") {
      return {
        requestId: request.requestId,
        result: Promise.reject(
          new RuntimeIpcError(
            ipcErrorText(
              `Runtime IPC 请求校验失败（operation=${operation}）：${!parsed.success ? ipcSchemaDetails(parsed.error) : "消息类型必须为 request"}`,
              this.options.getErrorSecrets?.(),
            ),
          ),
        ),
      };
    }

    const result = new Promise<unknown>((resolve, reject) => {
      const aborted = () => {
        this.pending.delete(request.requestId);
        this.rememberCancelledRequest(request.requestId);
        try {
          this.event({
            type: "event",
            event: "request_cancel",
            requestId: request.requestId,
            reason: "Runtime IPC 请求已取消。",
          });
        } catch {
          /* send 已经通过 close 记录 transport 失败；保留原始取消原因。 */
        }

        reject(
          signal.reason ?? new RuntimeIpcError("Runtime IPC 请求已取消。"),
        );
      };

      const removeAbortListener = () =>
        signal.removeEventListener("abort", aborted);
      this.pending.set(request.requestId, {
        operation,
        resolve,
        reject,
        removeAbortListener,
      });
      signal.addEventListener("abort", aborted, { once: true });
      try {
        this.send(parsed.data);
      } catch (error) {
        this.pending.delete(request.requestId);
        removeAbortListener();
        reject(error as Error);
      }
    });

    return { requestId: request.requestId, result };
  }

  onEvent(listener: (event: RuntimeIpcEvent) => void) {
    this.eventListeners.add(listener);

    return () => this.eventListeners.delete(listener);
  }

  setRequestHandler(
    handler: NonNullable<RuntimeIpcPeerOptions["handleRequest"]>,
  ) {
    if (this.requestHandler) {
      throw new RuntimeIpcError("Runtime IPC 请求 handler 已设置。");
    }

    this.requestHandler = handler;
  }

  event(event: RuntimeIpcEvent) {
    const parsed = runtimeIpcMessageSchema.parse(event);
    this.send(parsed);
  }

  handshake(
    message: Extract<
      RuntimeIpcMessage,
      { type: "runtime_hello" | "broker_hello" }
    >,
  ) {
    const parsed = runtimeIpcMessageSchema.parse(message);
    this.send(parsed);
  }

  end(message = "Runtime IPC 已关闭。") {
    this.close(message);
    this.options.output.end();
  }

  private send(message: RuntimeIpcMessage) {
    if (this.failure) {
      throw this.failure;
    }

    const frame = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(frame, "utf8") > this.maxFrameBytes) {
      throw new RuntimeIpcError("Runtime IPC 帧超过大小限制。");
    }

    this.options.output.write(frame, "utf8", (error) => {
      if (error) {
        this.close(`Runtime IPC 输出写入失败：${ipcFailureDetails(error)}`);
      }
    });
  }

  private consume(chunk: string) {
    if (this.failure) {
      return;
    }

    this.buffer += chunk;
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) {
        break;
      }

      const frame = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(frame, "utf8") > this.maxFrameBytes) {
        this.close("Runtime IPC 帧超过大小限制。");

        return;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(frame);
      } catch {
        this.close("Runtime IPC 收到非法 JSON。");

        return;
      }

      const parsed = runtimeIpcMessageSchema.safeParse(raw);
      if (!parsed.success) {
        const type =
          raw && typeof raw === "object" ? Reflect.get(raw, "type") : undefined;
        const operation =
          raw && typeof raw === "object"
            ? Reflect.get(raw, "operation")
            : undefined;
        const requestId =
          raw && typeof raw === "object"
            ? Reflect.get(raw, "requestId")
            : undefined;
        const pendingOperation =
          typeof requestId === "string"
            ? this.pending.get(requestId)?.operation
            : undefined;
        this.close(
          `Runtime IPC 收到不符合 schema 的消息（type=${typeof type === "string" ? type.slice(0, 40) : "unknown"}, operation=${typeof operation === "string" ? operation.slice(0, 80) : (pendingOperation ?? "none")}, keys=${raw && typeof raw === "object" ? Object.keys(raw).sort().join(",").slice(0, 200) : "none"}）。`,
        );

        return;
      }

      void this.dispatch(parsed.data).catch((error) => {
        this.close(
          `Runtime IPC 消息分发失败（type=${parsed.data.type}）：${ipcFailureDetails(error)}`,
        );
      });
    }

    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) {
      this.close("Runtime IPC 半帧超过大小限制。");
    }
  }

  private async dispatch(message: RuntimeIpcMessage) {
    if (message.type === "response") {
      this.resolve(message);

      return;
    }

    if (message.type === "event") {
      if (message.event === "cancel") {
        for (const controller of this.handling.values()) {
          controller.abort(new RuntimeIpcError(message.reason));
        }
      }

      if (message.event === "request_cancel") {
        this.handling
          .get(message.requestId)
          ?.abort(new RuntimeIpcError(message.reason));
      }

      this.options.onEvent?.(message);
      for (const listener of this.eventListeners) {
        listener(message);
      }

      return;
    }

    if (message.type === "runtime_hello" || message.type === "broker_hello") {
      this.options.onHandshake?.(message);

      return;
    }

    if (message.type !== "request") {
      this.close("Runtime IPC 收到未知消息。");

      return;
    }

    if (!this.requestHandler || this.handling.has(message.requestId)) {
      this.close(
        `Runtime IPC 拒绝请求（operation=${message.operation}, requestId=${message.requestId}）：${!this.requestHandler ? "未注册请求处理程序" : "请求 ID 重复，已有同 ID 操作执行中"}。`,
      );

      return;
    }

    const controller = new AbortController();
    this.handling.set(message.requestId, controller);
    try {
      const value = await this.requestHandler(message, controller.signal);
      if (!controller.signal.aborted) {
        this.send({
          type: "response",
          requestId: message.requestId,
          ok: true,
          value,
        });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      const retryable = Reflect.get(Object(error), "retryable");
      const status = Reflect.get(Object(error), "status");
      const retryAfterMs = Reflect.get(Object(error), "retryAfterMs");
      const providerRequestId = Reflect.get(Object(error), "requestId");
      const secrets = this.options.getErrorSecrets?.() ?? [];

      this.send({
        type: "response",
        requestId: message.requestId,
        ok: false,
        error: {
          code:
            typeof Reflect.get(Object(error), "code") === "string"
              ? ipcErrorText(
                  String(Reflect.get(Object(error), "code")),
                  secrets,
                  120,
                ) || "RUNTIME_REQUEST_FAILED"
              : "RUNTIME_REQUEST_FAILED",
          message: ipcErrorText(
            `Runtime IPC 操作 ${message.operation} 失败（requestId=${message.requestId}）：${ipcFailureDetails(error)}`,
            secrets,
          ),
          retryable: typeof retryable === "boolean" ? retryable : undefined,
          status:
            Number.isInteger(status) && status >= 100 && status <= 599
              ? status
              : undefined,
          retryAfterMs:
            Number.isInteger(retryAfterMs) &&
            retryAfterMs >= 0 &&
            retryAfterMs <= 30_000
              ? retryAfterMs
              : undefined,
          providerRequestId:
            typeof providerRequestId === "string"
              ? ipcErrorText(providerRequestId, secrets, 128)
              : undefined,
        },
      });
    } finally {
      this.handling.delete(message.requestId);
    }
  }

  private resolve(response: RuntimeIpcResponse) {
    const pending = this.pending.get(response.requestId);
    if (!pending) {
      if (this.cancelledPending.delete(response.requestId)) {
        return;
      }

      this.close("Runtime IPC 收到未知或已取消请求的响应。");

      return;
    }

    this.pending.delete(response.requestId);
    pending.removeAbortListener();
    if (response.ok) {
      pending.resolve(response.value);
    } else {
      pending.reject(
        new RuntimeIpcError(
          response.error.message,
          response.error.code,
          response.error.retryable,
          response.error.status,
          response.error.retryAfterMs,
          response.error.providerRequestId,
        ),
      );
    }
  }

  private rememberCancelledRequest(requestId: string) {
    this.cancelledPending.add(requestId);
    this.cancelledPendingOrder.push(requestId);
    while (this.cancelledPendingOrder.length > 1_024) {
      const expired = this.cancelledPendingOrder.shift();
      if (expired) {
        this.cancelledPending.delete(expired);
      }
    }
  }

  private close(message: string) {
    if (this.failure) {
      return;
    }

    this.failure = new RuntimeIpcError(
      ipcErrorText(message, this.options.getErrorSecrets?.()),
    );
    for (const pending of this.pending.values()) {
      pending.removeAbortListener();
      pending.reject(
        new RuntimeIpcError(
          ipcErrorText(
            `Runtime IPC 操作 ${pending.operation} 未完成：${this.failure.message}`,
            this.options.getErrorSecrets?.(),
          ),
        ),
      );
    }

    for (const controller of this.handling.values()) {
      controller.abort(this.failure);
    }

    this.pending.clear();
    this.handling.clear();
    this.cancelledPending.clear();
    this.cancelledPendingOrder = [];
    this.eventListeners.clear();
    this.options.onClose?.(this.failure);
  }
}
