import { randomUUID } from "node:crypto";
import type { Approval } from "../shared/types.js";
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
    if (key && this.grants.has(key)) return true;
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
    if (!p) throw new Error("审批已失效");
    if (decision === "session" && !p.grantKey)
      throw new Error("此操作不支持会话授权");
    this.pending.delete(id);
    p.cleanup();
    if (decision === "session") this.grants.add(p.grantKey!);
    p.resolve(decision !== "deny");
    this.changed();
  }
}
