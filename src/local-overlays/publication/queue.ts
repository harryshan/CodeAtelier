/**
 * 同一 Broker 进程内的来源发布队列，供 Publisher 在获取磁盘锁前使用。
 * 1. publicationTurn 按规范化协调锁路径排队，普通候选命令不受残留锁探测的短期限影响。
 * 2. 取消等待者立即返回且不运行其操作；仍保留前驱屏障，后续调用不能越过正在写入的发布。
 * 3. 当前操作确认结束后释放下一项，最后一项结束删除队列；失败不重试或删除磁盘锁。
 * 这里只序列化合作进程内调用；跨进程与崩溃残留继续由原生租约和持久锁协议约束。
 */
const turns = new Map<string, Promise<void>>();

export async function publicationTurn<T>(
  file: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const key = process.platform === "win32" ? file.toLowerCase() : file;
  const previous = turns.get(key) ?? Promise.resolve();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => barrier);
  turns.set(key, current);
  let abort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () =>
        reject(signal?.reason ?? new Error("Publication queue cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      void previous.then(resolve);
      if (signal?.aborted) {
        abort();
      }
    });
    signal?.throwIfAborted();

    return await operation();
  } finally {
    if (abort) {
      signal?.removeEventListener("abort", abort);
    }

    release();
    void current.then(() => {
      if (turns.get(key) === current) {
        turns.delete(key);
      }
    });
  }
}
