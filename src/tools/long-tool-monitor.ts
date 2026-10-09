/**
 * 为进程执行器和 MCP 操作提供无总时限的运行监视；模型调用由 Engine/Runtime 注入。
 * 1. ToolReview 接收运行时长和持续更新的有界输出尾部，只返回 continue/stop，不获得工具权限。
 * 2. monitorTool 只启动一次执行，每五分钟检查；单调用的检查不重叠，慢检查不会积累请求。
 * 3. stop 只 abort 本次执行并等待原执行 Promise 清理；父任务取消同样传入执行和检查。
 * 4. 完成后停止计时并取消在途模型请求，忽略晚到决定；模型故障不误杀工具，不重放副作用。
 * 输出只在内存保留尾部。历史、脱敏、usage 和 tracing 由注入的 review 负责。
 */
export const TOOL_REVIEW_INTERVAL_MS = 5 * 60 * 1000;
const LATEST_OUTPUT_CHARS = 12000;

export interface ToolRunStatus {
  elapsedMs: number;
  latestOutput: string;
  outputChars: number;
  outputTruncated: boolean;
  silentMs: number;
}

export interface ToolReviewDecision {
  action: "continue" | "stop";
  reason: string;
}

export type ToolReview = (
  status: ToolRunStatus,
  signal: AbortSignal,
) => Promise<ToolReviewDecision>;

export interface ToolReviewSubject {
  name: string;
  arguments: unknown;
  callId?: string;
}

export type ReviewTool = (
  subject: ToolReviewSubject,
  status: ToolRunStatus,
  signal: AbortSignal,
) => Promise<ToolReviewDecision>;

export async function monitorTool<T>(
  parentSignal: AbortSignal,
  review: ToolReview,
  execute: (signal: AbortSignal, append: (text: string) => void) => Promise<T>,
): Promise<T> {
  parentSignal.throwIfAborted();
  const execution = new AbortController();
  const reviewLifetime = new AbortController();
  const signal = AbortSignal.any([parentSignal, execution.signal]);
  const reviewSignal = AbortSignal.any([signal, reviewLifetime.signal]);
  const startedAt = Date.now();
  let lastOutputAt = startedAt;
  let latestOutput = "";
  let outputChars = 0;
  let checking = false;
  let finished = false;
  let interruption: Error | undefined;

  const check = async () => {
    if (checking || finished || signal.aborted) {
      return;
    }

    checking = true;
    try {
      const decision = await review(
        {
          elapsedMs: Date.now() - startedAt,
          latestOutput,
          outputChars,
          outputTruncated: outputChars > latestOutput.length,
          silentMs: Date.now() - lastOutputAt,
        },
        reviewSignal,
      );
      if (!finished && !signal.aborted && decision.action === "stop") {
        interruption = new Error(
          `模型中断长时间工具：${decision.reason}。执行可能已有副作用，禁止盲目重放。`,
        );
        execution.abort(interruption);
      }
    } catch {
      // review 适配器记录故障；单次模型失败不是取消工具的依据。
    } finally {
      checking = false;
    }
  };

  const timer = setInterval(() => void check(), TOOL_REVIEW_INTERVAL_MS);
  try {
    const result = await execute(signal, (text) => {
      if (text) {
        outputChars += text.length;
        latestOutput = (latestOutput + text.slice(-LATEST_OUTPUT_CHARS)).slice(
          -LATEST_OUTPUT_CHARS,
        );
        lastOutputAt = Date.now();
      }
    });
    if (interruption) {
      throw interruption;
    }

    return result;
  } catch (error) {
    // 保留执行器的清理失败/未知状态；正常取消用模型理由解释，不把它写成整任务被用户取消。
    if (
      interruption &&
      (error === signal.reason ||
        (error instanceof Error && error.message === "任务已取消"))
    ) {
      throw interruption;
    }

    throw error;
  } finally {
    finished = true;
    clearInterval(timer);
    reviewLifetime.abort(new Error("工具已结束，停止状态检查。"));
  }
}
