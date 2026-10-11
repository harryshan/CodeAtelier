/**
 * 保存待审批请求，并把用户的批准或拒绝交回等待中的工具。
 * Engine 持有实例，ToolRunner 发起请求，HTTP 接口提交决定；changed 回调通知任务和界面更新。
 *
 * 1. list 列出待审批项，可按会话筛选；内存中另存可以在当前会话复用的授权。
 * 2. request 先检查取消和已有授权，再将可信会话/任务 ID 传给分类器查询工作区；自动通过和拒绝不会创建待审批项。
 * 3. 人工确认请求保存模型理由并等待 decide；决定处理一次批准、会话批准和拒绝。
 *
 * 复用授权必须同时匹配会话和完整 grant key。分类模型只给出建议，工具本身的路径、命令和
 * 并发检查仍在执行前完成；分类器缺失时保守地转为人工确认。
 * 可选 Recorder 记录分类、授权复用、人工等待/决定/取消；从异步上下文关联调用，不保存 subject 或 grant key。
 */

import { randomUUID } from "node:crypto";
import type { Approval } from "../shared/types.js";
import type { ApprovalAssessment, ApprovalSubject } from "./model-approval.js";
import type { TraceRecorder } from "../tracing/recorder.js";
import type { TraceSpan } from "../tracing/types.js";
import { currentTraceContext } from "../tracing/context.js";

/** 授权只保存在内存中，复用时必须匹配会话和内容指纹，模型不能自行改变执行权限。 */
export class ApprovalManager {
  private pending = new Map<
    string,
    {
      approval: Approval;
      resolve: (v: boolean) => void;
      cleanup: () => void;
      grantKey?: string;
      span?: TraceSpan;
    }
  >();

  private grants = new Set<string>();
  constructor(
    private changed: () => void,
    private classify?: (
      subject: ApprovalSubject,
      signal: AbortSignal,
      context: { sessionId: string; taskId: string },
    ) => Promise<ApprovalAssessment>,
    private assessed?: (
      subject: ApprovalSubject,
      assessment: ApprovalAssessment,
    ) => void,
    private traces?: TraceRecorder,
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
  ): Promise<boolean> {
    signal.throwIfAborted();
    const key = grantKey ? data.sessionId + ":" + grantKey : undefined;

    if (key && this.grants.has(key)) {
      this.traces?.instant(
        data.taskId,
        "approval.reused",
        "approval",
        "Approvals",
        {
          tool: data.tool,
          callId: currentTraceContext()?.span.attributes.callId,
        },
      );

      return true;
    }

    const subject = { tool: data.tool, description: data.description };
    const classify = async () =>
      this.classify
        ? this.classify(subject, signal, {
            sessionId: data.sessionId,
            taskId: data.taskId,
          })
        : {
            decision: "human review" as const,
            reason: "未配置低成本审批模型，需要人工确认。",
          };
    const assessment = !this.classify
      ? {
          decision: "human review" as const,
          reason: "未配置低成本审批模型，需要人工确认。",
        }
      : this.traces
        ? await this.traces.measure(
            data.taskId,
            {
              name: "approval.classify",
              category: "approval",
              track: "Approvals",
              attributes: {
                tool: data.tool,
                callId: currentTraceContext()?.span.attributes.callId,
              },
            },
            classify,
            signal,
          )
        : await classify();
    signal.throwIfAborted();
    this.assessed?.(subject, assessment);

    if (assessment.decision === "approve") {
      this.traces?.instant(
        data.taskId,
        "approval.decision",
        "approval",
        "Approvals",
        {
          decision: "approve",
          tool: data.tool,
          callId: currentTraceContext()?.span.attributes.callId,
        },
      );

      return true;
    }

    if (assessment.decision === "reject") {
      this.traces?.instant(
        data.taskId,
        "approval.decision",
        "approval",
        "Approvals",
        {
          decision: "reject",
          tool: data.tool,
          callId: currentTraceContext()?.span.attributes.callId,
        },
      );
      throw new Error("低成本审批模型拒绝此操作：" + assessment.reason);
    }

    return new Promise<boolean>((resolve, reject) => {
      const id = randomUUID();
      const span = this.traces?.startSpan(data.taskId, {
        name: "approval.human_wait",
        category: "approval",
        track: "Approvals",
        attributes: {
          approvalId: id,
          tool: data.tool,
          callId: currentTraceContext()?.span.attributes.callId,
        },
      });
      const abort = () => {
        this.traces?.endSpan(span, "cancelled");
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
        span,
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
    this.traces?.endSpan(p.span, "ok", { decision });
    p.cleanup();
    if (decision === "session") {
      this.grants.add(p.grantKey!);
    }

    p.resolve(decision !== "deny");
    this.changed();
  }
}
