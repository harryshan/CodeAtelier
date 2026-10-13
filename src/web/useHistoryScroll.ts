/**
 * 为 App 的历史时间线触发自动旧页读取，不管理数据或执行任务。
 * 1. useHistoryScroll 接收当前视图、加载状态及连接层 loadOlder，监听滚动和视口变化。
 * 2. 接近顶部或内容不足一屏时请求一页；连接层串行保护，失败暂停到用户重试。
 * 3. 每次历史前插后重新检查位置，纯过程页未增加可见高度时仍能继续；卸载取消帧和观察器。
 * 阅读锚点和跟随末尾由 Timeline 的虚拟布局维护，本 hook 不修改 scrollTop。
 */
import { useEffect, type RefObject } from "react";
import type { SessionView } from "./session-view";

export function useHistoryScroll(
  containerRef: RefObject<HTMLDivElement | null>,
  data: SessionView | undefined,
  loadingOlder: boolean,
  olderError: string,
  loadOlder: () => Promise<void> | undefined,
) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !data?.history?.hasOlder || loadingOlder || olderError) {
      return;
    }

    let frame: number | undefined;
    const check = () => {
      frame = undefined;
      if (container.scrollTop <= 240) {
        void loadOlder();
      }
    };

    const schedule = () => {
      frame ??= requestAnimationFrame(check);
    };

    container.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    schedule();

    return () => {
      container.removeEventListener("scroll", schedule);
      observer.disconnect();
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
    };
  }, [containerRef, data, loadingOlder, olderError, loadOlder]);
}
