/**
 * 文件作用：为摘要及后续辅助任务选择模型配置，供 Engine 和其他辅助调用入口复用。
 * 输入输出：接收公开 Settings，返回独立配置副本；共用连接、密钥来源与执行限制。
 * 代码结构：auxiliarySettings 先检查辅助模型，再覆盖模型 ID 与思考等级。
 * 边界：留空完整沿用主模型；不猜测价格或容量，不授予工具权限，不进行网络或磁盘操作。
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
