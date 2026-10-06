/**
 * 在宿主和 Runtime 的主模型循环之间共用会话 token 锚点生命周期；不参与摘要模型或子模型用量。
 *
 * 1. 构造器接收任务预算、Broker 生成的 scope、窄存储回调及 tracing/取消信号，不打开数据库。
 * 2. restore 在首次 context.prepare 前加载并校验锚点；失败的内容匹配退回本地计量，I/O 故障则停止。
 * 3. observe 在追加模型输出前校准并冻结本次请求锚点；缺失/非法 usage 不覆盖已有状态。
 * 4. save 在响应正文保存后等待锚点提交；未知写入不自动重试。trace 仅含命中标志与关联阶段，不含指纹或正文。
 */
import type { ContextBudget } from "./token-budget.js";
import type { ContextTrace } from "./context-manager.js";
import type { TokenAnchor } from "./token-anchor.js";

interface Options {
  budget: ContextBudget;
  scope: string;
  read: () => Promise<unknown>;
  write: (anchor: TokenAnchor) => Promise<void>;
  trace: ContextTrace;
  signal: AbortSignal;
}

export class SessionTokenCalibration {
  constructor(private options: Options) {}

  async restore(input: any[], instructions: string, tools: any[]) {
    if (!this.options.budget.restoreAnchor) {
      return;
    }

    await this.traced("context.usage.restore", async () => {
      const anchor = await this.options.read();
      this.options.signal.throwIfAborted();

      return this.options.budget.restoreAnchor!(
        anchor,
        this.options.scope,
        input,
        instructions,
        tools,
      );
    });
  }

  observe(
    actualInput: number | undefined,
    input: any[],
    instructions: string,
    tools: any[],
  ) {
    if (actualInput === undefined) {
      return undefined;
    }

    const budget = this.options.budget;
    budget.observeUsage?.(actualInput, input, instructions, tools);

    return budget.snapshotUsage?.(
      this.options.scope,
      actualInput,
      input,
      instructions,
      tools,
    );
  }

  async save(anchor: TokenAnchor | undefined) {
    if (!anchor) {
      return;
    }

    await this.traced("context.usage.save", async () => {
      await this.options.write(anchor);

      return true;
    });
  }

  private async traced(name: string, operation: () => Promise<boolean>) {
    const { trace, signal } = this.options;
    const span = trace.start(name);
    try {
      signal.throwIfAborted();
      const restored = await operation();
      trace.end(
        span,
        "ok",
        name === "context.usage.restore" ? { restored } : {},
      );
    } catch (error) {
      trace.end(span, signal.aborted ? "cancelled" : "error");
      throw error;
    }
  }
}
