/**
 * 保存待审批请求，并把用户的批准或拒绝交回等待中的工具。
 * Engine 持有实例，ToolRunner 发起请求，HTTP 接口提交决定；changed 回调通知任务和界面更新。
 *
 * 1. list 列出待审批项，可按会话筛选；内存中另存可以在当前会话复用的授权。
 * 2. request 先检查取消和已有授权，再调用注入的低成本模型分类器；高风险调用可要求跳过分类并强制人工确认。
 * 3. 人工确认请求保存模型理由并等待 decide；决定处理一次批准、会话批准和拒绝。
 *
 * 复用授权必须同时匹配会话和完整 grant key。分类模型只给出建议，工具本身的路径、命令和
 * 并发检查仍在执行前完成；分类器缺失时保守地转为人工确认。
 */

import { randomUUID } from "node:crypto";
import type { Approval } from "../shared/types.js";
import type { ApprovalAssessment, ApprovalSubject } from "./model-approval.js";

/** 授权只保存在内存中，复用时必须匹配会话和内容指纹；强制人工请求不会调用分类模型。 */
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
  constructor(
    private changed: () => void,
    private classify?: (
      subject: ApprovalSubject,
      signal: AbortSignal,
    ) => Promise<ApprovalAssessment>,
    private assessed?: (
      subject: ApprovalSubject,
      assessment: ApprovalAssessment,
    ) => void,
  ) {}

  list(sessionId?: string) {
    return [...this.pending.values()]
      .map((p) => p.approval)
      .filter((a) => !sessionId || a.sessionId === sessionId);
  }

  async request(
    data: Omit<Approval, "id" | "repeatable">,
    signal: AbortSignal,
    grantKey?: string,
    options: { requireHuman?: boolean } = {},
  ): Promise<boolean> {
    signal.throwIfAborted();
    const key = grantKey ? data.sessionId + ":" + grantKey : undefined;

    if (key && this.grants.has(key)) {
      return true;
    }

    const subject = { tool: data.tool, description: data.description };
    const assessment = options.requireHuman
      ? {
          decision: "human review" as const,
          reason: "扩展 Sandbox 权限必须由用户人工确认。",
        }
      : this.classify
        ? await this.classify(subject, signal)
        : {
            decision: "human review" as const,
            reason: "未配置低成本审批模型，需要人工确认。",
          };
    signal.throwIfAborted();
    this.assessed?.(subject, assessment);

    if (assessment.decision === "approve") {
      return true;
    }

    if (assessment.decision === "reject") {
      throw new Error("低成本审批模型拒绝此操作：" + assessment.reason);
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
        approval: {
          ...data,
          id,
          repeatable: !!key,
          reviewReason: assessment.reason,
        },
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
