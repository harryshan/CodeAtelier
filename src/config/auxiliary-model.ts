/**
 * 从主配置中选出辅助任务使用的模型设置，目前用于 Engine 的上下文摘要。
 * 接收 Settings 并返回配置副本，连接地址和执行限制沿用主配置。
 *
 * 1. auxiliarySettings 检查是否设置了辅助模型；留空时直接沿用主模型设置。
 * 2. 设置了辅助模型时，替换模型 ID 和对应的思考等级。
 *
 * 这里只选择配置，不查询模型价格或容量，也不发请求或读写文件。
 */
import type { Settings } from "../shared/types.js";

export function auxiliarySettings(settings: Settings): Settings {
  if (!settings.auxiliaryModel?.trim()) {
    return { ...settings };
  }

  return {
    ...settings,
    model: settings.auxiliaryModel.trim(),
    reasoningEffort: settings.auxiliaryReasoningEffort ?? "low",
  };
}
