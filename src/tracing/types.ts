/**
 * 描述 CodeAtelier 内部 tracing 的稳定数据契约，供 TraceRecorder、模型包装器和 Perfetto 导出使用。
 * Engine 以 task 为根创建 trace；模型、上下文和工具模块只持有轻量 span 句柄，不直接依赖 HTTP 或 SQLite。
 *
 * 1. TraceAttributes 限制写入 Perfetto 的安全标量，避免把提示词、源码、工具输出或密钥误作事件属性。
 * 2. TraceSpanOptions 指定可视化名称、分类、逻辑轨道及可选父 span；TraceSpan 保存单调时间轴上的生命周期。
 * 3. TraceLink 表示不同 span 之间的因果关系，导出时转换为 Perfetto flow，而不是把并行 DAG 压扁为父子树。
 *
 * 高保真请求与结果存档不属于本文件的范围；本增量只输出用于诊断性能和控制流的安全摘要。
 */

export type TraceAttribute = boolean | number | string | undefined;

export type TraceAttributes = Record<string, TraceAttribute>;

export type TraceStatus = "cancelled" | "error" | "ok" | "unknown";

export interface TraceSpanOptions {
  name: string;
  category: string;
  track: string;
  parentSpanId?: string;
  attributes?: TraceAttributes;
}

export interface TraceSpan {
  id: string;
  taskId: string;
  name: string;
  category: string;
  track: string;
  parentSpanId?: string;
  startedAtUs: number;
  finishedAtUs?: number;
  status?: TraceStatus;
  attributes: TraceAttributes;
}

export interface TraceLink {
  id: string;
  fromSpanId: string;
  toSpanId: string;
  name: string;
}
