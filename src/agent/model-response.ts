/**
 * Engine 与 AgentRuntimeService 共用的完整模型响应接收流程；不创建模型连接或访问 Store/IPC。
 *
 * 1. ModelResponseOperations 接收当前历史、请求视图、校准器和环境提供的持久化/事件回调。
 * 2. acceptModelResponse 先基于请求视图校准并记录 usage，再追加输出、等待正文和锚点保存，最后发布非空回复。
 * 3. 任一步失败直接向外传播，不重试、不回滚已追加的历史；调用方继续负责取消检查、事件 flush、日志和 tracing。
 *    保留原有同步事件回调，正文保存前不会人为增加异步让出点；共享层不新增 trace 或记录敏感正文。
 */

import type { SessionTokenCalibration } from "../context/session-token-calibration.js";
import type { ModelResult } from "../providers/model-provider.js";
import type { ModelUsage } from "../providers/model-metadata.js";

interface ModelResponseOperations {
  input: any[];
  requestInput: any[];
  instructions: string;
  tools: any[];
  calibration: Pick<SessionTokenCalibration, "observe" | "save">;
  recordUsage(usage: ModelUsage): void;
  appendContext(output: any[]): Promise<void>;
  emitAssistant(text: string): void;
}

export async function acceptModelResponse(
  response: ModelResult,
  operations: ModelResponseOperations,
) {
  const anchor = operations.calibration.observe(
    response.usage?.input_tokens,
    operations.requestInput,
    operations.instructions,
    operations.tools,
  );
  if (response.usage) {
    operations.recordUsage(response.usage);
  }

  operations.input.push(...response.output);
  await operations.appendContext(response.output);
  await operations.calibration.save(anchor);
  if (response.text) {
    operations.emitAssistant(response.text);
  }
}
