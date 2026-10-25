/**
 * Windows 发布会话的有界 stdin/stdout 客户端，供 Publisher 与未知恢复持有执行租约。
 * 1. start 启动固定 helper，等待匹配 generation 的 ready；inspection 只取排他，不允许来源写入。
 * 2. replace/create/delete/cleanup 串行发出有界参数并验证收据；没有独立短命令后代。
 * 3. 协议/超时/进程退出取消 signal；不能据此推断操作无副作用，调用方保留 journal/锁。
 * 4. close 显式 finish 并等待进程 close，证明 native 执行已排空；失败绝不伪造 closed。
 * 5. releaseLock 仅供检查会话，在 native 排他内按哈希/句柄删除固定协调锁，避免 check/unlink 竞争。
 * 6. 新发布可绑定协调锁 ID 作为 generation；检查收据暴露原生写入标记，旧 helper 缺少证明时不默认 false。
 * 路径仅编码进私有管道，不进日志/trace；来源级 tracing 与 generation 持久化由调用方负责。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { overlayHelperPath } from "../../src/worktrees/overlay.js";
import { PublishError } from "./merge.js";

const replySchema = z.object({
  version: z.literal(1),
  state: z.string().optional(),
  generation: z.uuid().optional(),
  mutated: z.boolean().optional(),
  backupIdentity: z
    .string()
    .regex(/^\d{1,10}:\d{1,20}$/)
    .optional(),
  error: z.string().optional(),
  status: z.number().optional(),
});
type Reply = z.infer<typeof replySchema>;

function encoded(value: string) {
  if (!value || value.includes("\0") || Buffer.byteLength(value) > 16384) {
    throw new PublishError("PUBLICATION_PARAMETER_LIMIT");
  }

  return Buffer.from(value).toString("hex");
}

export class PublicationLease {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<number | null>;
  private pending?: {
    resolve: (value: Reply) => void;
    reject: (error: Error) => void;
  };

  private buffer = "";
  private terminal = false;
  private finishRequested = false;
  private closedReceipt = false;
  private observedMutation?: boolean;
  private closing?: Promise<void>;

  private constructor(
    readonly gate: string,
    readonly generation: string,
    inspection: boolean,
  ) {
    this.child = spawn(
      overlayHelperPath(),
      [
        inspection ? "inspect-publication" : "publish-session",
        gate,
        generation,
        String(process.pid),
      ],
      { windowsHide: true, stdio: "pipe" },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (text: string) => this.receive(text));
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.fail());
    this.child.on("error", () => this.fail());
    this.exited = new Promise((resolve) => {
      this.child.once("close", (code) => {
        this.terminal = true;
        if (!this.closedReceipt || code !== 0) {
          this.fail();
        }

        resolve(code);
      });
    });
  }

  static async start(
    gate: string,
    inspectionGeneration?: string,
    publicationGeneration?: string,
  ) {
    if (process.platform !== "win32") {
      throw new PublishError("WINDOWS_REQUIRED");
    }

    const generation = inspectionGeneration
      ? z.uuid().parse(inspectionGeneration)
      : publicationGeneration
        ? z.uuid().parse(publicationGeneration)
        : randomUUID();
    const lease = new PublicationLease(
      gate,
      generation,
      !!inspectionGeneration,
    );
    try {
      const ready = await lease.request();
      if (
        ready.state !== "publication-ready" ||
        ready.generation !== generation
      ) {
        throw new PublishError("PUBLICATION_PROTOCOL");
      }

      lease.observedMutation = ready.mutated;

      return lease;
    } catch (error) {
      lease.child.kill();
      await lease.exited;
      throw error;
    }
  }

  private fail() {
    const error = new PublishError("PUBLICATION_EXECUTION_UNCONFIRMED");
    this.controller.abort(error);
    this.pending?.reject(error);
    this.pending = undefined;
  }

  /** Inspection receipt only; undefined means an older helper cannot prove absence of writes. */
  get sourceMutationStarted() {
    return this.observedMutation;
  }

  private receive(text: string) {
    this.buffer += text;
    if (this.buffer.length > 8192) {
      this.fail();
      this.child.kill();

      return;
    }

    const end = this.buffer.indexOf("\n");
    if (end < 0) {
      return;
    }

    try {
      const reply = replySchema.parse(JSON.parse(this.buffer.slice(0, end)));
      this.buffer = this.buffer.slice(end + 1);
      if (!this.pending || this.buffer.length) {
        throw new Error("Unexpected reply");
      }

      const pending = this.pending;
      this.pending = undefined;
      if (reply.error) {
        pending.reject(
          new PublishError("NATIVE_PUBLISH_UNCONFIRMED", {
            cause: { nativeStatus: reply.status },
          }),
        );
      } else {
        if (this.finishRequested && reply.state === "publication-closed") {
          this.closedReceipt = true;
        }

        pending.resolve(reply);
      }
    } catch {
      this.fail();
      this.child.kill();
    }
  }

  private async request(command?: string): Promise<Reply> {
    if (this.pending || this.terminal || this.signal.aborted) {
      throw new PublishError("PUBLICATION_EXECUTION_UNAVAILABLE");
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Reply>((resolve, reject) => {
        this.pending = { resolve, reject };
        timer = setTimeout(() => {
          this.fail();
          this.child.kill();
        }, 15_000);
        if (command) {
          this.child.stdin.write(command + "\n");
        }
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async operation(command: string, state: string) {
    if (this.closing) {
      throw new PublishError("PUBLICATION_EXECUTION_UNAVAILABLE");
    }

    const result = await this.request(command);
    if (result.state !== state) {
      this.fail();
      this.child.kill();
      throw new PublishError("PUBLICATION_PROTOCOL");
    }

    return result;
  }

  async replace(
    target: string,
    temporary: string,
    beforeHash: string,
    afterHash: string,
  ) {
    const result = await this.operation(
      `replace ${encoded(target)} ${encoded(temporary)} ${beforeHash} ${afterHash}`,
      "published",
    );
    if (!result.backupIdentity) {
      throw new PublishError("PUBLICATION_PROTOCOL");
    }

    return result.backupIdentity;
  }

  async create(target: string, temporary: string, afterHash: string) {
    await this.operation(
      `create ${encoded(target)} ${encoded(temporary)} ${afterHash}`,
      "created",
    );
  }

  async delete(target: string, beforeHash: string) {
    await this.operation(`delete ${encoded(target)} ${beforeHash}`, "deleted");
  }

  async cleanup(backup: string, identity: string, hash: string) {
    await this.operation(
      `cleanup ${encoded(backup)} ${identity} ${hash}`,
      "cleaned",
    );
  }

  /** Inspection-only: deletes the fixed sibling coordination lock by verified handle. */
  async releaseLock(expectedHash: string) {
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new PublishError("PUBLICATION_PARAMETER_LIMIT");
    }

    await this.operation(`release-lock ${expectedHash}`, "lock-released");
  }

  close() {
    this.closing ??= this.finish();

    return this.closing;
  }

  private async finish() {
    try {
      this.finishRequested = true;
      const result = await this.request("finish");
      if (result.state !== "publication-closed") {
        throw new PublishError("PUBLICATION_PROTOCOL");
      }

      this.child.stdin.end();
      if ((await this.exited) !== 0) {
        throw new PublishError("PUBLICATION_EXECUTION_UNCONFIRMED");
      }
    } catch (error) {
      this.fail();
      this.child.kill();
      await this.exited;
      throw error;
    }
  }
}
