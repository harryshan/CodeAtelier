/**
 * 为 Timeline 提供与 React、DOM 无关的虚拟列表布局计算。
 * Timeline 根据已测得或预估的条目高度调用本文件，得到当前滚动窗口应显示的连续索引及前后占位高度；
 * 测量、滚动监听和实际 JSX 渲染仍留在 Timeline.tsx，因而这里可以由普通 Vitest 单元测试覆盖。
 *
 * 1. VirtualTimelineRange 描述可渲染索引区间和两端空白的准确高度。
 * 2. calculateVirtualTimelineRange 规范化滚动参数，累积每项高度，找到包含视口与 overscan 的最小连续区间。
 *
 * 该函数不读写 DOM、滚动状态或会话数据。高度由调用方维护；非有限或非正高度会安全地视为零，
 * 避免一次异常测量使占位尺寸变成 NaN。
 */

export interface VirtualTimelineRange {
  startIndex: number;
  endIndex: number;
  beforeHeight: number;
  afterHeight: number;
  totalHeight: number;
}

function validHeight(height: number) {
  return Number.isFinite(height) && height > 0 ? height : 0;
}

/**
 * 返回与扩展后的可视区域相交的最小连续条目范围。endIndex 是排他索引，
 * 因此调用方可直接使用 entries.slice(startIndex, endIndex)。
 */
export function calculateVirtualTimelineRange(
  itemHeights: number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): VirtualTimelineRange {
  const heights = itemHeights.map(validHeight);
  const totalHeight = heights.reduce((total, height) => total + height, 0);
  const normalizedScrollTop = Math.max(0, Math.min(scrollTop, totalHeight));
  const normalizedViewportHeight = Math.max(0, viewportHeight);
  const normalizedOverscan = Math.max(0, overscan);
  const startBoundary = Math.max(0, normalizedScrollTop - normalizedOverscan);
  const endBoundary = Math.min(
    totalHeight,
    normalizedScrollTop + normalizedViewportHeight + normalizedOverscan,
  );
  let startIndex = 0;
  let beforeHeight = 0;

  while (
    startIndex < heights.length &&
    beforeHeight + heights[startIndex] <= startBoundary
  ) {
    beforeHeight += heights[startIndex];
    startIndex += 1;
  }

  let endIndex = startIndex;
  let renderedHeight = beforeHeight;

  while (endIndex < heights.length && renderedHeight < endBoundary) {
    renderedHeight += heights[endIndex];
    endIndex += 1;
  }

  if (startIndex === endIndex && startIndex < heights.length) {
    renderedHeight += heights[endIndex];
    endIndex += 1;
  }

  return {
    startIndex,
    endIndex,
    beforeHeight,
    afterHeight: Math.max(0, totalHeight - renderedHeight),
    totalHeight,
  };
}
