/**
 * Broker 到 Linux namespace 挂载控制器的有界私有 IPC；不执行任意 shell 或 mount 参数。
 * 1. constructor 接收父启动器的 Unix socket；首次操作用 hello 核对当前 mount namespace。
 * 2. open/seal/close/release 使用固定请求及 UUID，release 只允许已卸载视图的摘要绑定覆盖；不自动重试。
 *    classify 仅查询正常卸载 upper 的明确选集类型/版本，不读正文或更改状态；只读失败不污染写操作状态。
 * 3. 一次连接只处理一条有界 JSON；超时、断线、坏响应均使客户端失效，避免重放未知挂载。
 * 4. 各操作记录 ID、耗时与终态的 tracing/log，不记录来源路径、正文或 socket 地址。
 * 调用方必须先排空 Runtime 再 close；本层不提供任务退出证明或自动清理 upper。
 * controller 需要显式 namespace 启动器，未启用时拒绝，不静默使用宿主普通目录。
 */
import { randomUUID } from "node:crypto";
import { readlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { z } from "zod";
import type { Logger } from "pino";
import { TraceRecorder } from "../tracing/recorder.js";
import { TraceArchive } from "../tracing/archive.js";

const responseSchema = z.object({ version: z.literal(1), ok: z.boolean() });
const viewSchema = z.object({
  workspace: z.string().min(1),
  control: z.string().min(1),
  upper: z.string().min(1),
  backingIdentity: z.string().min(1).optional(),
  ready: z.object({
    state: z.literal("ready"),
    valid: z.literal(true),
    nodes: z.number().int().nonnegative(),
    objects: z.number().int().nonnegative(),
    copiedBytes: z.number().int().nonnegative(),
    sourceOpens: z.number().int().nonnegative(),
    enumerations: z.number().int().nonnegative(),
  }),
});
export type LinuxOverlayView = z.infer<typeof viewSchema>;
const classificationSchema = z.object({
  source: z.string(),
  sourceIdentity: z.string(),
  upperIdentity: z.string(),
  files: z
    .array(
      z
        .object({
          path: z.string().min(1).max(1024),
          stamp: z.string().regex(/^\d+:\d+:\d+:-?\d+:-?\d+:\d+$/),
          deleted: z.boolean(),
        })
        .strict(),
    )
    .max(100),
});
export type LinuxPrivateClassification = z.infer<typeof classificationSchema>;

export class LinuxOverlayController {
  private poisoned = false;
  private checked = false;

  constructor(
    private readonly socket: string,
    private readonly log: Logger,
    private readonly traces: TraceRecorder,
    private readonly archive: TraceArchive,
    private readonly namespace = () => readlink("/proc/self/ns/mnt"),
    private readonly timeoutMs = 30_000,
  ) {
    if (!socket) {
      throw new Error("Linux Local 需要显式 namespace 启动入口。");
    }
  }

  private exchange(
    request: Record<string, unknown>,
    readOnly = false,
  ): Promise<unknown> {
    if (this.poisoned) {
      return Promise.reject(
        new Error("Linux overlay 控制器结果未知，禁止重试。"),
      );
    }

    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socket);
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const fail = () => {
        if (settled) {
          return;
        }

        settled = true;
        this.poisoned ||= !readOnly;
        socket.destroy();
        reject(new Error("Linux overlay IPC 结果未知；保留私有状态。"));
      };

      socket.setTimeout(this.timeoutMs, fail);
      socket.on("error", fail);
      socket.on("close", () => {
        if (!settled) {
          fail();
        }
      });
      socket.on("connect", () => {
        socket.write(JSON.stringify({ version: 1, ...request }) + "\n");
      });
      socket.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 65_536) {
          fail();

          return;
        }

        chunks.push(chunk);
        if (!chunk.includes(10)) {
          return;
        }

        try {
          const bytes = Buffer.concat(chunks);
          if (bytes.indexOf(10) !== bytes.length - 1) {
            throw new Error("Multiple controller replies");
          }

          const value: unknown = JSON.parse(bytes.toString("utf8"));
          const reply = responseSchema.parse(value);
          settled = true;
          socket.destroy();
          if (!reply.ok) {
            this.poisoned ||= !readOnly;
            reject(new Error("Linux overlay 控制器拒绝操作；不自动重试。"));
          } else {
            resolve(value);
          }
        } catch {
          fail();
        }
      });
    });
  }

  private async execute<T>(
    operation: string,
    id: string,
    request: Record<string, unknown>,
    decode: (value: unknown) => T,
    readOnly = false,
  ): Promise<T> {
    z.uuid().parse(id);
    const operationId = randomUUID();
    this.traces.startTask(operationId, id);
    const span = this.traces.startSpan(operationId, {
      name: `local_overlay.linux.${operation}`,
      category: "worktree",
      track: "Linux overlay controller",
      attributes: { overlayId: id },
    });
    const started = performance.now();
    let outcome: "ok" | "unknown" | "error" = readOnly ? "error" : "unknown";
    this.log.info({
      module: "linux-overlay",
      event: `${operation}.started`,
      overlayId: id,
      operationId,
    });
    try {
      if (!this.checked) {
        const value = z
          .object({ namespace: z.string() })
          .parse(await this.exchange({ operation: "hello" }, readOnly));
        if (value.namespace !== (await this.namespace())) {
          throw new Error("Linux overlay 不在当前应用 mount namespace。");
        }

        this.checked = true;
      }

      const result = decode(
        await this.exchange({ operation, id, ...request }, readOnly),
      );
      outcome = "ok";
      this.log.info({
        module: "linux-overlay",
        event: `${operation}.completed`,
        overlayId: id,
        operationId,
        durationMs: performance.now() - started,
      });

      return result;
    } catch (error) {
      this.poisoned ||= !readOnly;
      this.log.warn({
        module: "linux-overlay",
        event: `${operation}.${readOnly ? "failed" : "unknown"}`,
        overlayId: id,
        operationId,
        durationMs: performance.now() - started,
      });
      throw error;
    } finally {
      this.traces.endSpan(span, outcome);
      this.traces.finishTask(operationId, outcome);
      await this.archive.write(
        id,
        operationId,
        this.traces.exportTask(operationId),
      );
      this.traces.discardTask(operationId);
    }
  }

  open(id: string, source: string, create: boolean) {
    return this.execute("open", id, { source, create }, (value) =>
      viewSchema.parse(value),
    );
  }

  classify(id: string, paths: readonly string[]) {
    return this.execute(
      "classify",
      id,
      { paths },
      (value) => classificationSchema.parse(value),
      true,
    );
  }

  seal(id: string) {
    return this.execute(
      "seal",
      id,
      {},
      (value) => z.object({ sealId: z.uuid() }).parse(value).sealId,
    );
  }

  close(id: string) {
    return this.execute("close", id, {}, () => undefined);
  }

  release(
    id: string,
    remove: { path: string; contentDigest: string | null }[],
  ) {
    return this.execute("release", id, { remove }, (value) => {
      const result = z
        .object({ removed: z.number().int().nonnegative() })
        .parse(value);
      if (result.removed !== remove.length) {
        throw new Error("Linux overlay 覆盖移除数量不匹配。");
      }
    });
  }
}
