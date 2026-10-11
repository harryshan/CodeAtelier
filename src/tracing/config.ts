/**
 * 读取仅后端使用的 tracing 容量、检查点和归档保留设置，由 Config 在启动时校验。
 * 1. 四个环境变量均为有界整数；无效值拒绝启动，不进入 UI 可编辑设置或 Runtime 配置。
 * 2. 默认每任务 100000 条/32 MiB 估算保留预算，每 30 秒检查点；保留天数 0 禁用自动删除。
 * 不读取凭据，不执行 I/O；测试可显式传入环境对象。
 */
export function traceConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const integer = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const raw = env[name];
    const value = raw === undefined ? fallback : Number(raw);
    if (
      (!raw?.trim() && raw !== undefined) ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    ) {
      throw new Error(`${name} must be an integer between ${min} and ${max}.`);
    }

    return value;
  };

  return {
    maxRecords: integer("CODEATELIER_TRACE_MAX_RECORDS", 100000, 100, 1000000),
    maxBytes: integer(
      "CODEATELIER_TRACE_MAX_BYTES",
      32 * 1024 * 1024,
      65536,
      256 * 1024 * 1024,
    ),
    checkpointMs: integer(
      "CODEATELIER_TRACE_CHECKPOINT_MS",
      30000,
      5000,
      3600000,
    ),
    retentionDays: integer("CODEATELIER_TRACE_RETENTION_DAYS", 0, 0, 3650),
  };
}
