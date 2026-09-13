/**
 * 保存待审批请求，并把用户的批准或拒绝交回等待中的工具。
 * Engine 持有实例，ToolRunner 发起请求，HTTP 接口提交决定；changed 回调通知任务和界面更新。
 *
 * 1. list 列出待审批项，可按会话筛选；内存中另存可以在当前会话复用的授权。
 * 2. request 先检查取消和已有授权，没有可用授权就创建请求，等待决定或取消。
 * 3. decide 处理一次批准、会话批准和拒绝；不支持复用的请求不能授予会话权限。
 *
 * 复用授权必须同时匹配会话和完整 grant key。这里负责等待与传递决定，
 * 命令是否允许、磁盘内容是否变化仍由工具执行前检查。
 */

import { randomUUID } from "node:crypto";
import type { Approval } from "../shared/types.js";

/** 授权只保存在内存中，复用时必须匹配会话和内容指纹，模型不能自行批准。 */
export class ApprovalManager {
  private pending = new Map<
    string,
    {
      approval: Approval;
      resolve: (v: boolean) => void;
      cleanup: () => void;
      grantKey?: string;
    }
  >();

  private grants = new Set<string>();
  constructor(private changed: () => void) {}
  list(sessionId?: string) {
    return [...this.pending.values()]
      .map((p) => p.approval)
      .filter((a) => !sessionId || a.sessionId === sessionId);
  }

  async request(
    data: Omit<Approval, "id" | "repeatable">,
    signal: AbortSignal,
    grantKey?: string,
  ): Promise<boolean> {
    signal.throwIfAborted();
    const key = grantKey ? data.sessionId + ":" + grantKey : undefined;

    if (key && this.grants.has(key)) {
      return true;
    }

    return new Promise<boolean>((resolve, reject) => {
      const id = randomUUID();
      const abort = () => {
        this.pending.delete(id);
        this.changed();
        reject(new Error("任务已取消"));
      };

      const cleanup = () => signal.removeEventListener("abort", abort);

      this.pending.set(id, {
        approval: { ...data, id, repeatable: !!key },
        resolve,
        cleanup,
        grantKey: key,
      });
      signal.addEventListener("abort", abort, { once: true });
      this.changed();
    });
  }

  decide(id: string, decision: "once" | "session" | "deny") {
    const p = this.pending.get(id);

    if (!p) {
      throw new Error("审批已失效");
    }

    if (decision === "session" && !p.grantKey) {
      throw new Error("此操作不支持会话授权");
    }

    this.pending.delete(id);
    p.cleanup();
    if (decision === "session") {
      this.grants.add(p.grantKey!);
    }

    p.resolve(decision !== "deny");
    this.changed();
  }
}
