/**
 * 将 Perfetto JSON 的异步事件还原为带耗时的测试视图，供 tracing/Runtime 回归检查实际区间。
 * 1. traceSlices 按进程和 id2.local 配对 b/e，拒绝重复、缺失、名称错配或先结束后开始的记录。
 * 2. 返回 begin 的参数、逻辑轨道和以微秒表示的 dur；instant/flow/metadata 不冒充业务 span。
 * 此函数只解析测试取得的导出数据，不调用 Recorder，也不修改事件或替代 Perfetto 导入验证。
 */

export function traceSlices(events: any[]) {
  const open = new Map<string, any>();
  const slices: any[] = [];

  for (const event of events) {
    if (event.ph !== "b" && event.ph !== "e") {
      continue;
    }

    const key = `${event.pid}:${event.id2?.local}`;
    if (event.id2?.local === undefined) {
      throw new Error("异步 span 缺少进程内 ID。");
    }

    if (event.ph === "b") {
      if (open.has(key)) {
        throw new Error("异步 span 重复开始。");
      }

      open.set(key, event);
      continue;
    }

    const begin = open.get(key);
    if (
      !begin ||
      begin.name !== event.name ||
      begin.cat !== event.cat ||
      event.ts < begin.ts
    ) {
      throw new Error("异步 span 终态无法匹配开始事件。");
    }

    slices.push({ ...begin, dur: event.ts - begin.ts });
    open.delete(key);
  }

  if (open.size) {
    throw new Error("异步 span 未结束。");
  }

  return slices.sort((left, right) => left.ts - right.ts);
}
