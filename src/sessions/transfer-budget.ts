/**
 * 为 Store 请求计算保守的结构化克隆预算，供主线程队列在发送前实施背压。
 * 1. 遍历对象结构但不 JSON.stringify 正文；字符串以 UTF-8 最坏上界计费。
 * 2. 共享引用只遍历一次，避免循环输入卡住预算；真正 JSON 可保存性由写事务检查。
 * 3. 达到预算即停止并显式拒绝，未发送请求没有未知提交，也不自动重试。
 * 这是队列保留内存的保守估算，不声称等于 V8 堆占用或磁盘大小。
 */
export function transferBytes(value: unknown, limit: number): number {
  const pending: unknown[] = [value];
  const visited = new Set<object>();
  let bytes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") {
      bytes += 16 + item.length * 3;
    } else if (item && typeof item === "object") {
      if (visited.has(item)) {
        bytes += 8;
      } else {
        visited.add(item);
        bytes += 48;
        for (const [key, child] of Object.entries(item)) {
          bytes += 24 + key.length * 3;
          if (bytes > limit) {
            throw new Error("Store 队列数据预算已满；请求尚未发送。");
          }

          pending.push(child);
        }
      }
    } else {
      bytes += 8;
    }

    if (bytes > limit) {
      throw new Error("Store 队列数据预算已满；请求尚未发送。");
    }
  }

  return bytes;
}
