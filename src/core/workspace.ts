import { IntervalDepthTree } from './segmentTree';
import { buildCapacityGrid, findRequiredConflict } from './capacityCalendar';
import { newDataId } from './identity';
import type { Capacity, CapacityCalendarSegment, Job, JobStatus, Workspace } from './types';

export interface CreateInput {
  capacity: Capacity;
  jobs: { id: string; start: number; end: number; benefit: number }[];
  capacityCalendar?: CapacityCalendarSegment[];
}

/**
 * 由校验通过的数据构造全新工作区；作业初始状态均为普通。
 * 每次构造代表一批新导入的数据：版本重置为 1，并分配全新数据身份
 * （与既有工作区/快照彻底区分，即便版本号相同也绝不配套）。
 */
export function createWorkspace(input: CreateInput): Workspace {
  const jobs: Job[] = input.jobs.map((j) => ({ ...j, status: 'normal' }));
  return {
    capacity: input.capacity,
    jobs,
    capacityCalendar: input.capacityCalendar ?? [],
    version: 1,
    dataId: newDataId(),
  };
}

/**
 * 构造必选重叠度索引。时间格端点在本工作区生命周期内不变（作业端点 +
 * 容量日历端点），所以坐标压缩只做一次；必选集合变化时只做区间加/减。
 *
 * 树中存储「必选深度 - 该小格有效容量」，rangeMax >= 0 即存在超限小格。
 */
export function createDepthIndex(workspace: Workspace): {
  coords: number[];
  index: Map<number, number>;
  tree: IntervalDepthTree;
  cellCapacity: Int32Array;
} {
  const grid = buildCapacityGrid(workspace.jobs, workspace.capacity, workspace.capacityCalendar);
  const tree = new IntervalDepthTree(grid.coords, grid.cellCapacity);
  for (const job of workspace.jobs) {
    if (job.status === 'required') {
      // 半开区间：作业覆盖小格 [li, ri)，相接端点不属于同一小格
      tree.rangeAdd(grid.index.get(job.start)!, grid.index.get(job.end)!, +1);
    }
  }
  return { coords: grid.coords, index: grid.index, tree, cellCapacity: grid.cellCapacity };
}

export interface ToggleResult {
  /** 拒绝原因；存在时表示约束与结果均未改变 */
  rejected?: string;
}

/**
 * 修改单个作业状态。
 *
 * 规则：
 *  - 设为必选时，若该作业覆盖的任一时间格上「必选重叠数 +1」超过该格
 *    有效容量（受容量日历影响，可能小于 capacity），则拒绝，
 *    且不改动任何既有约束（调用方应整体放弃本次状态更新）。
 *  - 必选 -> 其它状态、排除相关切换永远合法。
 *  - 必选与排除互斥：切换直接覆盖旧状态。
 */
export function applyStatusChange(
  workspace: Workspace,
  tree: IntervalDepthTree,
  index: Map<number, number>,
  jobIndex: number,
  next: JobStatus,
): ToggleResult {
  const job = workspace.jobs[jobIndex];
  if (!job) return { rejected: `作业下标 ${jobIndex} 不存在` };
  if (job.status === next) return {};

  if (next === 'required' && job.status !== 'required') {
    // 作业覆盖的小格是半开区间 [li, ri)；查询右端点传 ri（不含），
    // 否则会把与本作业在 end 处相接的后续作业误计为重叠。
    const li = index.get(job.start)!;
    const ri = index.get(job.end)!;
    // 当前最大值若已 >= 0，则再加 1 必然在某格超过有效容量
    const currentMax = tree.rangeMax(li, ri);
    if (currentMax >= 0) {
      return {
        rejected: `拒绝：作业 "${job.id}" 的时段内必选重叠数已达到有效容量上限（容量日历可能在部分时段下调了 capacity=${workspace.capacity}），设为必选将无可行排程。现有约束与结果保持不变。`,
      };
    }
    tree.rangeAdd(li, ri, +1);
  } else if (job.status === 'required' && next !== 'required') {
    const li = index.get(job.start)!;
    const ri = index.get(job.end)!;
    tree.rangeAdd(li, ri, -1);
  }

  job.status = next;
  workspace.version += 1;
  return {};
}

/**
 * 供工作区整体恢复/求解前使用的必选可行性检查（与树增量维护等价）。
 * 返回冲突作业 id；无冲突返回 undefined。
 */
export function checkRequiredFeasible(workspace: Workspace): string | undefined {
  const grid = buildCapacityGrid(
    workspace.jobs,
    workspace.capacity,
    workspace.capacityCalendar,
  );
  return findRequiredConflict(workspace.jobs.filter((j) => j.status === 'required'), grid);
}
