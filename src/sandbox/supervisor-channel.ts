/**
 * 在 Broker 已建立的私有输入/输出 handle 上实现 supervisor 的有界 JSONL 请求通道。
 * SupervisorProtocolClient 负责业务 schema；本类只负责 framing、requestId 路由、取消和传输故障扩散。
 *
 * 1. request 在写入前限制 UTF-8 帧大小，同一 requestId 不得并发复用。
 * 2. consume 按换行分帧，允许响应乱序返回，但拒绝超限、非 JSON、缺 requestId 和真正未请求响应。
 * 3. 请求取消只停止 Broker 等待，已取消 requestId 的首个迟到响应会被丢弃；真实 Runtime 终止必须另发 terminate_runtime。
 * 4. 任一帧或 stream 故障会使全部 pending 请求失败，上层将已启动实例按 unknown/orphaned 处理。
 *
 * 创建子进程、校验二进制与父进程、设置 handle 继承列表是后续 Windows launcher 的职责。
 * 不得用公开 Named Pipe 或 TCP 端口直接替换本通道的私有 handle 假设。
 */

import type { Readable, Writable } from "node:stream";
import type {
  SupervisorControlChannel,
  SupervisorRequest,
} from "./supervisor-protocol.js";
import { SupervisorProtocolError } from "./supervisor-protocol.js";

export const DEFAULT_SUPERVISOR_FRAME_BYTES = 64 * 1024;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  removeAbortListener: () => void;
}

export class JsonLineSupervisorChannel implements SupervisorControlChannel {
  private buffer = "";
  private failure?: SupervisorProtocolError;
  private pending = new Map<string, PendingRequest>();
  private ignoredResponses = new Set<string>();

  constructor(
    private input: Readable,
    private output: Writable,
    private maxFrameBytes = DEFAULT_SUPERVISOR_FRAME_BYTES,
  ) {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.consume(chunk));
    input.once("error", () => this.fail("Supervisor 输出通道失败。"));
    input.once("end", () => this.fail("Supervisor 输出通道已关闭。"));
    output.once("error", () => this.fail("Supervisor 输入通道失败。"));
  }

  request(request: SupervisorRequest, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (this.failure) {
      return Promise.reject(this.failure);
    }

    if (
      this.pending.has(request.requestId) ||
      this.ignoredResponses.has(request.requestId)
    ) {
      return Promise.reject(
        new SupervisorProtocolError("Supervisor requestId 正在使用。"),
      );
    }

    const frame = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(frame, "utf8") > this.maxFrameBytes) {
      return Promise.reject(
        new SupervisorProtocolError("Supervisor 请求超过帧大小限制。"),
      );
    }

    return new Promise((resolve, reject) => {
      const aborted = () => {
        this.pending.delete(request.requestId);
        this.ignoredResponses.add(request.requestId);
        reject(signal.reason ?? new Error("任务已取消"));
      };

      const removeAbortListener = () =>
        signal.removeEventListener("abort", aborted);

      this.pending.set(request.requestId, {
        resolve,
        reject,
        removeAbortListener,
      });
      signal.addEventListener("abort", aborted, { once: true });
      this.output.write(frame, "utf8", (error) => {
        if (error) {
          this.fail("Supervisor 请求写入失败。");
        }
      });
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
        this.fail("Supervisor 响应超过帧大小限制。");

        return;
      }

      let response: unknown;
      try {
        response = JSON.parse(frame);
      } catch {
        this.fail("Supervisor 返回了非法 JSON 帧。");

        return;
      }

      const requestId =
        response && typeof response === "object"
          ? Reflect.get(response, "requestId")
          : undefined;
      if (typeof requestId !== "string") {
        this.fail("Supervisor 响应缺少 requestId。");

        return;
      }

      const pending = this.pending.get(requestId);
      if (!pending) {
        if (this.ignoredResponses.delete(requestId)) {
          continue;
        }

        this.fail("Supervisor 返回了未请求的响应。");

        return;
      }

      this.pending.delete(requestId);
      pending.removeAbortListener();
      pending.resolve(response);
    }

    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) {
      this.fail("Supervisor 响应超过帧大小限制。");
    }
  }

  private fail(message: string) {
    if (this.failure) {
      return;
    }

    this.failure = new SupervisorProtocolError(message);
    for (const pending of this.pending.values()) {
      pending.removeAbortListener();
      pending.reject(this.failure);
    }

    this.pending.clear();
    this.ignoredResponses.clear();
  }
}
