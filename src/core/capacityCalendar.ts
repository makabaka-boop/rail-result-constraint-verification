import type { CapacityCalendarSegment } from './types';

export interface CapacityGrid {
  /** 作业端点与日历端点合并、去重、排序后的坐标 */
  coords: number[];
  /** 坐标 -> 下标 */
  index: Map<number, number>;
  /**
   * 每个小格 p（即 [coords[p], coords[p+1])）的有效容量。
   * 长度为 coords.length - 1；落在日历片段内取 available，否则取 capacity。
   */
  cellCapacity: Int32Array;
}

/**
 * 合并作业端点与容量日历端点，生成统一时间格与每格有效容量。
 * 日历片段已经过导入校验：互不重叠、可相接、位于作业范围内。
 */
export function buildCapacityGrid(
  jobs: { start: number; end: number }[],
  capacity: number,
  calendar: CapacityCalendarSegment[],
): CapacityGrid {
  const set = new Set<number>();
  for (const job of jobs) {
    set.add(job.start);
    set.add(job.end);
  }
  for (const seg of calendar) {
    set.add(seg.start);
    set.add(seg.end);
  }
  const coords = [...set].sort((a, b) => a - b);
  const index = new Map<number, number>();
  coords.forEach((c, i) => index.set(c, i));

  const cellCapacity = new Int32Array(Math.max(0, coords.length - 1));
  cellCapacity.fill(capacity);
  for (const seg of calendar) {
    const li = index.get(seg.start)!;
    const ri = index.get(seg.end)!;
    for (let p = li; p < ri; p++) cellCapacity[p] = seg.available;
  }
  return { coords, index, cellCapacity };
}

/**
 * 半开区间深度扫描：检查必选作业在每个时间格上的重叠数是否超过该格有效容量。
 * 相接端点（同一时刻先结束后开始）不算重叠。
 *
 * @returns 冲突时返回一个触发超限的必选作业 id；全部可行返回 undefined。
 */
export function findRequiredConflict(
  requiredJobs: { id: string; start: number; end: number }[],
  grid: CapacityGrid,
): string | undefined {
  if (requiredJobs.length === 0) return undefined;

  const m = grid.coords.length - 1;
  // 差分：同坐标结束(-1)先于开始(+1)结算 => 相接先降后升
  const startCount = new Int32Array(m + 1);
  const endCount = new Int32Array(m + 1);
  const starterId: (string | undefined)[] = new Array(m + 1).fill(undefined);
  for (const job of requiredJobs) {
    const li = grid.index.get(job.start)!;
    const ri = grid.index.get(job.end)!;
    startCount[li] += 1;
    endCount[ri] += 1;
    if (starterId[li] === undefined) starterId[li] = job.id;
  }

  let depth = 0;
  for (let p = 0; p < m; p++) {
    depth -= endCount[p];
    depth += startCount[p];
    if (depth > grid.cellCapacity[p]) {
      return starterId[p] ?? requiredJobs[0].id;
    }
  }
  return undefined;
}
