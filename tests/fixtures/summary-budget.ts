/**
 * 为上下文单元测试提供显式的模型容量与真实 tokenizer，不把字符预算冒充摘要预算。
 * 1. summaryCapabilities 是离线模拟服务元数据，较小窗口用于覆盖多块完整材料。
 * 2. summaryBudget 为 ContextManager 的摘要选项构造独立 token 预算，不更改主任务计量。
 * 本夹具不访问网络或用户设置；需要缺失能力的测试应显式省略它。
 */
import { createBudget } from "../../src/context/token-budget.js";

export const summaryCapabilities = {
  tokenizer: "o200k_base",
  limits: { max_context_window_tokens: 4096, max_output_tokens: 1000 },
};

export async function summaryBudget() {
  return createBudget(summaryCapabilities, 0, 1000);
}
