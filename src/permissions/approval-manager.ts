/**
 * 文件作用：管理待审批操作和限定会话及内容指纹的授权。
 *
 * 模块协作与输入输出：
 * 由 Engine 持有，ToolRunner 请求批准，HTTP 接口提交决定；changed 回调驱动等待状态与 UI 刷新。
 *
 * 代码结构与执行顺序：
 * 1. 内部保存待决请求和可复用会话授权，list 可按会话过滤。
 * 2. request 检查取消与已有授权，为新请求生成 ID，等待决定并在取消后移除。
 * 3. decide 区分 once、session 和 deny，只有带可复用键的请求才能授予会话授权。
 *
 * 关键约束：
 * 授权绑定会话及完整 grant key；这里只协调批准，不负责推导命令是否安全或核对磁盘变化。
 */

import { randomUUID } from "node:crypto";
import type { Approval } from "../shared/types.js";

/** 授权仅驻留内存，按会话与内容指纹隔离；模型不能自行授予权限。 */
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
