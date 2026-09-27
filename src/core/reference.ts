import type { Job } from './types';

/**
 * 参考方案（不可变参考排程）：
 *
 * 调度员已通知作业队执行一版排程后，可把该次成功结果「采纳」为不可变
 * 参考方案。此后重新求解仍严格按原字典序优化：
 *
 *   1) 满足必选/排除与逐时段（含容量日历）容量约束；
 *   2) 最大化总收益；
 *   3) 仅在总收益相同的最优方案之间，最小化与参考方案的「作业成员差异」；
 *   4) 差异仍并列时沿用求解器既有的确定性裁决。
 *
 * 成员身份由「作业编号 id + 起止时刻 start/end」共同确定：同一 id 的
 * 作业改了时刻，旧时刻成员与新时刻成员是两个不同成员（改期 = 撤下旧的、
 * 加入新的）。
 *
 * 参考方案绑定工作区数据身份 dataId：导入新数据（新 dataId）后旧参考
 * 绝不能作用于新工作区；恢复时身份不配套的本地参考记录直接丢弃。
 */
export interface ReferenceMember {
  /** 作业编号（与 Job.id 对应） */
  id: string;
  /** 开始时刻（含） */
  start: number;
  /** 结束时刻（不含） */
  end: number;
}

export interface ReferencePlan {
  /** 绑定的工作区数据身份；只有 dataId 完全相同才允许生效 */
  workspaceDataId: string;
  /** 采纳时工作区版本（仅展示用；不参与配对裁决） */
  workspaceVersion: number;
  /** 采纳时间（ISO 字符串，仅展示用） */
  adoptedAt: string;
  /** 参考成员（已按规范顺序排序、互不重复） */
  members: ReferenceMember[];
}

/** 成员身份的字符串键：编号 + 起止时刻三者全等才是同一成员。 */
export function memberKey(m: { id: string; start: number; end: number }): string {
  return `${m.id}#${m.start}#${m.end}`;
}

/** 参考成员的规范顺序：先按时刻（start、end），再按编号。 */
function compareMembers(a: ReferenceMember, b: ReferenceMember): number {
  return a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * 规范化一组参考成员：
 *  - 丢弃结构非法项（空 id、非整数端点、end<=start、端点越界）；
 *  - 按成员键去重，首次出现保留；
 *  - 返回规范排序后的新数组。
 *
 * 不校验成员 id 是否仍存在于工作区：已从当前工作区删除的参考成员
 * 合法地保留在参考方案中，只是不参与可避免差异计数。
 */
export function normalizeReferenceMembers(raw: unknown): ReferenceMember[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const members: ReferenceMember[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const m = item as Record<string, unknown>;
    if (typeof m.id !== 'string' || m.id.length === 0) return null;
    if (
      typeof m.start !== 'number' ||
      !Number.isInteger(m.start) ||
      typeof m.end !== 'number' ||
      !Number.isInteger(m.end)
    ) {
      return null;
    }
    if (m.start < 0 || m.end <= m.start || m.end > 1_000_000_000) return null;
    const member: ReferenceMember = { id: m.id, start: m.start, end: m.end };
    const key = memberKey(member);
    if (seen.has(key)) continue;
    seen.add(key);
    members.push(member);
  }
  members.sort(compareMembers);
  return members;
}

/** 由一份求解结果与工作区作业构造参考成员集合（采纳时使用）。 */
export function referenceMembersFromSelection(
  selectedIds: readonly string[],
  jobs: readonly Job[],
): ReferenceMember[] {
  const byId = new Map<string, Job>();
  for (const job of jobs) byId.set(job.id, job);
  const members: ReferenceMember[] = [];
  const seen = new Set<string>();
  for (const id of selectedIds) {
    const job = byId.get(id);
    if (!job) continue; // 采纳来源经过交叉核对，理论上不会发生
    const member = { id: job.id, start: job.start, end: job.end };
    const key = memberKey(member);
    if (seen.has(key)) continue;
    seen.add(key);
    members.push(member);
  }
  members.sort(compareMembers);
  return members;
}

/**
 * 把参考成员拆成两组：
 *  - deleted：当前工作区中已不存在同 id 作业的成员。这些成员不可能被
 *    再次排入，按规则「不参与可避免差异计数」，求解器与差异统计都忽略；
 *  - active：同 id 作业仍在工作区的成员（不论该作业当前是普通/必选/
 *    排除——被排除导致无法保留是「不可避免差异」，仍计入最小化目标）。
 */
export function splitReferenceMembers(
  members: readonly ReferenceMember[],
  jobs: readonly Job[],
): { active: ReferenceMember[]; deleted: ReferenceMember[] } {
  const existingIds = new Set<string>();
  for (const job of jobs) existingIds.add(job.id);
  const active: ReferenceMember[] = [];
  const deleted: ReferenceMember[] = [];
  for (const m of members) {
    if (existingIds.has(m.id)) active.push(m);
    else deleted.push(m);
  }
  return { active, deleted };
}

export interface ReferenceDiffItem extends ReferenceMember {
  /** 该作业编号在当前工作区中的当前时刻（保留项即参考时刻） */
  currentStart: number;
  currentEnd: number;
}

export interface ReferenceDiff {
  /** 选中且仍为参考成员（同编号同时刻） */
  retained: ReferenceDiffItem[];
  /** 参考成员未被选中（含改期旧成员；已删除成员不在此列） */
  removed: ReferenceDiffItem[];
  /** 选中但不是参考成员（含改期后的新成员） */
  added: ReferenceDiffItem[];
  /** 已从工作区删除、不参与差异计数的参考成员（仅透明展示） */
  deletedReference: ReferenceMember[];
  /** 可避免差异数 = removed.length + added.length（删除成员不计） */
  diffCount: number;
}

/**
 * 计算当前入选集合相对参考方案的成员差异。屏幕列表与下载 JSON 共用此
 * 函数，保证「下载与屏幕采用同一结果快照」。
 *
 * 成员按 id+start+end 判定；同编号不同时刻：旧时刻成员记入 removed，
 * 新时刻成员记入 added（即改期视为撤下 + 新增）。
 */
export function computeReferenceDiff(
  selectedIds: readonly string[],
  jobs: readonly Job[],
  reference: ReferencePlan,
): ReferenceDiff {
  const byId = new Map<string, Job>();
  for (const job of jobs) byId.set(job.id, job);

  const { active, deleted } = splitReferenceMembers(reference.members, jobs);
  const activeKeys = new Set(active.map(memberKey));

  const selected: { member: ReferenceMember; job: Job }[] = [];
  const selectedKeys = new Set<string>();
  for (const id of selectedIds) {
    const job = byId.get(id);
    if (!job) continue;
    const member: ReferenceMember = { id: job.id, start: job.start, end: job.end };
    selected.push({ member, job });
    selectedKeys.add(memberKey(member));
  }

  const retained: ReferenceDiffItem[] = [];
  const added: ReferenceDiffItem[] = [];
  for (const { member, job } of selected) {
    const item: ReferenceDiffItem = {
      ...member,
      currentStart: job.start,
      currentEnd: job.end,
    };
    if (activeKeys.has(memberKey(member))) retained.push(item);
    else added.push(item);
  }

  const removed: ReferenceDiffItem[] = [];
  for (const m of active) {
    if (!selectedKeys.has(memberKey(m))) {
      const job = byId.get(m.id)!;
      removed.push({ ...m, currentStart: job.start, currentEnd: job.end });
    }
  }

  retained.sort((a, b) => compareMembers(a, b));
  removed.sort((a, b) => compareMembers(a, b));
  added.sort((a, b) => compareMembers(a, b));
  return {
    retained,
    removed,
    added,
    deletedReference: deleted,
    diffCount: removed.length + added.length,
  };
}

/** 求解器只需活动成员（已删除成员无法再排入，不参与二级目标）。 */
export function activeReferenceMembers(
  reference: ReferencePlan | null | undefined,
  jobs: readonly Job[],
): ReferenceMember[] {
  if (!reference) return [];
  return splitReferenceMembers(reference.members, jobs).active;
}
