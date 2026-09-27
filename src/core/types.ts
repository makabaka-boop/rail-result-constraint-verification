/**
 * 作业状态：
 *  - normal：普通，求解器可自由决定是否入选择
 *  - required：必选，必须排入（受 capacity 重叠约束）
 *  - excluded：排除，任何情况下都不会入选
 */
export type JobStatus = 'normal' | 'required' | 'excluded';

export interface Job {
  /** 唯一非空字符串标识（JSON 中可以是数字/字符串，规范化为字符串） */
  id: string;
  /** 开始时刻（含），整数，>=0 */
  start: number;
  /** 结束时刻（不含），整数，> start，<= 1e9 */
  end: number;
  /** 收益，整数，1..1e9 */
  benefit: number;
  status: JobStatus;
}

export type Capacity = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * 容量日历片段：在左闭右开区间 [start, end) 内有效容量为 available。
 * 片段互不重叠但允许端点相接；未被任何片段覆盖的时间保持全程 capacity。
 * available 取值 0..capacity-1（达到 capacity 的限制没有意义，应直接省略）。
 * 片段范围限于最早作业开始 ~ 最晚作业结束。
 */
export interface CapacityCalendarSegment {
  start: number;
  end: number;
  available: number;
}

export interface Workspace {
  capacity: Capacity;
  jobs: Job[];
  /**
   * 容量日历（已按 start 排序、互不重叠）；空数组表示全程 capacity，
   * 与旧版无该字段的行为完全一致。
   */
  capacityCalendar: CapacityCalendarSegment[];
  /** 单调递增的数据版本：约束修改会使其 +1；导入新数据重置为 1 */
  version: number;
  /**
   * 数据身份：每次成功导入生成的唯一标识，在该批数据的整个生命周期内
   * （含约束修改、版本递增）保持不变；导入另一批数据必定得到新的 dataId。
   * 工作区与求解快照仅在 dataId 与 version 同时相等时才配套——
   * 仅凭版本号相等不能配对（新导入同样从 version=1 起步）。
   * 旧本地数据没有该字段：恢复时由 restoreSession 补登并立即回写。
   */
  dataId: string;
}

/** 用户 JSON 中单个作业的原始形态 */
export interface RawJob {
  id: unknown;
  start: unknown;
  end: unknown;
  benefit: unknown;
}

export interface RawCalendarSegment {
  start: unknown;
  end: unknown;
  available: unknown;
}

export interface ImportPayload {
  capacity: unknown;
  jobs: unknown;
  capacityCalendar?: unknown;
}
