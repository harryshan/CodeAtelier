/**
 * 验证前端 Timeline 的虚拟列表布局计算，不依赖浏览器或 React 渲染器。
 * Timeline.tsx 将滚动容器测得的位置和每项实际/预估高度交给被测纯函数，再只挂载返回范围内的条目；
 * 本文件确认两端的占位高度仍能保持完整历史的滚动尺寸。
 *
 * 1. 第一组用等高条目检查视口与 overscan 只选择连续的局部窗口。
 * 2. 第二组用不等高条目检查累计高度、边界位置和尾部占位不会因条目高度不同而漂移。
 * 3. 最后一组检查空列表及无效测量值的安全降级。
 *
 * 测试只验证纯布局输出，不创建 DOM、滚动事件或真实会话数据；浏览器中的 ResizeObserver 和事件监听
 * 由 Timeline.tsx 负责把实际高度与滚动状态输入该函数。
 */

import { describe, expect, it } from "vitest";
import { calculateVirtualTimelineRange } from "../src/web/timeline-virtualization";

describe("calculateVirtualTimelineRange", () => {
  it("renders only the scrolled window with overscan and preserves both placeholders", () => {
    const range = calculateVirtualTimelineRange(
      Array.from({ length: 10 }, () => 100),
      350,
      100,
      100,
    );

    expect(range).toEqual({
      startIndex: 2,
      endIndex: 6,
      beforeHeight: 200,
      afterHeight: 400,
      totalHeight: 1000,
    });
  });

  it("uses actual variable heights for item boundaries and the trailing placeholder", () => {
    const range = calculateVirtualTimelineRange([40, 90, 30, 70], 95, 60, 10);

    expect(range).toEqual({
      startIndex: 1,
      endIndex: 4,
      beforeHeight: 40,
      afterHeight: 0,
      totalHeight: 230,
    });
  });

  it("keeps empty and invalid measurements from producing invalid spacer dimensions", () => {
    expect(calculateVirtualTimelineRange([], 20, 100, 50)).toEqual({
      startIndex: 0,
      endIndex: 0,
      beforeHeight: 0,
      afterHeight: 0,
      totalHeight: 0,
    });
    expect(
      calculateVirtualTimelineRange([100, Number.NaN, -5], -10, 40, -1),
    ).toEqual({
      startIndex: 0,
      endIndex: 1,
      beforeHeight: 0,
      afterHeight: 0,
      totalHeight: 100,
    });
  });
});
