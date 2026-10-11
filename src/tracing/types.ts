/**
 * 描述 CodeAtelier 内部 tracing 的稳定数据契约，供 TraceRecorder、模型包装器和 Perfetto 导出使用。
 * Engine 以 task 为根创建 trace；模型、上下文和工具模块只持有轻量 span 句柄，不直接依赖 HTTP 或 SQLite。
 *
 * 1. TraceAttributes 表达受控的 JSON 属性；普通文本限长，tool parameters 保留有界结构但递归遮盖凭据字段。
 * 2. TraceSpanOptions 指定名称、分类、进程/逻辑轨道及可选父 span；TraceSpan 保存生命周期，导出为独立 ID 的异步 b/e，不代表 CPU 调用栈；跨进程时间由采集方提供。
 * 3. TraceLink 表示不同 span 之间的因果关系，导出时由 span 内的 n 端点和整数 bind_id 连接；父 ID 另保留在属性，不强行构造嵌套栈。
 *
 * 高保真请求与结果存档不属于本文件的范围；本增量只输出用于诊断性能和控制流的安全摘要。
 * 参数结构在 Recorder 的深度、节点和字符预算内保留；超限是诊断截断，不影响工具实际参数。
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
