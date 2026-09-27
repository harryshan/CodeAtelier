/**
 * 描述 CodeAtelier 内部 tracing 的稳定数据契约，供 TraceRecorder、模型包装器和 Perfetto 导出使用。
 * Engine 以 task 为根创建 trace；模型、上下文和工具模块只持有轻量 span 句柄，不直接依赖 HTTP 或 SQLite。
 *
 * 1. TraceAttributes 表达受控的 JSON 属性；普通文本限长，tool parameters 保留完整结构但递归遮盖凭据字段。
 * 2. TraceSpanOptions 指定可视化名称、分类、进程/逻辑轨道及可选父 span；TraceSpan 保存生命周期；跨进程时间由采集方提供。
 * 3. TraceLink 表示不同 span 之间的因果关系，导出时转换为 Perfetto flow，而不是把并行 DAG 压扁为父子树。
 *
 * 高保真请求与结果存档不属于本文件的范围；本增量只输出用于诊断性能和控制流的安全摘要。
 */

export type TraceAttribute =
  | boolean
  | null
  | number
  | string
  | TraceAttribute[]
  | { [key: string]: TraceAttribute }
  | undefined;

export type TraceAttributes = Record<string, TraceAttribute>;

export type TraceStatus = "cancelled" | "error" | "ok" | "unknown";

export interface TraceSpanOptions {
  name: string;
  category: string;
  track: string;
  processId?: number;
  startedAtUs?: number;
  parentSpanId?: string;
  attributes?: TraceAttributes;
}

export interface TraceSpan {
  id: string;
  taskId: string;
  name: string;
  category: string;
  track: string;
  processId?: number;
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
