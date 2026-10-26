/**
 * 同一 LocalOverlayService 内的逐清单 I/O 排队，避免 Windows 读句柄阻止原子替换。
 * 1. run 接收已验证的视图 ID 和单次 read/save 回调；同 ID 串行，不同 ID 并行。
 * 2. 前次成功或失败都释放队列，调用方收到原始结果；尾项排空后移除映射。
 * 3. 不重试 rename、不删除磁盘锁，不延长到挂载/验证/发布事务；不得在回调中重入同 ID。
 * 这只是本进程内部短 I/O 协调，跨进程未知状态仍由原服务锁/原生租约拒绝。
 */
export class ManifestQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    const work = previous.then(operation);
    const tail = work.then(
      () => {},
      () => {},
    );
    this.tails.set(id, tail);
    void tail.then(() => {
      if (this.tails.get(id) === tail) {
        this.tails.delete(id);
      }
    });

    return work;
  }
}
