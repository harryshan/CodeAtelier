/**
 * 为 Timeline 提供与 React、DOM 无关的虚拟列表布局计算。
 * Timeline 根据已测得或预估的条目高度调用本文件，得到当前滚动窗口应显示的连续索引及前后占位高度；
 * 测量、滚动监听和实际 JSX 渲染仍留在 Timeline.tsx，因而这里可以由普通 Vitest 单元测试覆盖。
 *
 * 1. VirtualTimelineRange 描述可渲染索引区间和两端空白的准确高度。
 * 2. calculateVirtualTimelineRange 保留全量入口；createTimelineLayout 在高度变化时构建前缀和。
 * 3. timelineRange 在滚动时复用前缀和，二分定位视口和 overscan，复杂度 O(log N)。
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
  return timelineRange(
    createTimelineLayout(itemHeights),
    scrollTop,
    viewportHeight,
    overscan,
  );
}

/** 条目或测量变化时重建一次；offsets[i] 是第 i 项顶部，末项是总高度。 */
export function createTimelineLayout(itemHeights: number[]): number[] {
  const offsets = [0];
  for (const height of itemHeights) {
    offsets.push(offsets[offsets.length - 1] + validHeight(height));
  }

  return offsets;
}

/** 二分寻找第一个 >= 或 > 边界的偏移，重复高度对应零高度项。 */
function boundaryIndex(offsets: number[], boundary: number, strict: boolean) {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (
      offsets[middle] < boundary ||
      (strict && offsets[middle] === boundary)
    ) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

/** 滚动只执行两次二分查询，不遍历完整条目列表。 */
export function timelineRange(
  offsets: number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): VirtualTimelineRange {
  const count = offsets.length - 1;
  const totalHeight = offsets[count];
  const top = Math.max(0, Math.min(scrollTop, totalHeight));
  const start = Math.max(0, top - Math.max(0, overscan));
  const end = Math.min(
    totalHeight,
    top + Math.max(0, viewportHeight) + Math.max(0, overscan),
  );
  const startIndex = Math.min(
    count,
    Math.max(0, boundaryIndex(offsets, start, true) - 1),
  );
  const endIndex = Math.min(
    count,
    Math.max(startIndex + 1, boundaryIndex(offsets, end, false)),
  );

  return {
    startIndex,
    endIndex,
    beforeHeight: offsets[startIndex],
    afterHeight: Math.max(0, totalHeight - offsets[endIndex]),
    totalHeight,
  };
}
