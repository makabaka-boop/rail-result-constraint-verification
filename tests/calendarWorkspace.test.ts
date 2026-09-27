import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyStatusChange,
  checkRequiredFeasible,
  createDepthIndex,
  createWorkspace,
} from '../src/core/workspace';
import { buildResultJson, loadSnapshot, loadWorkspace, persistWorkspace } from '../src/core/persistence';
import type { CapacityCalendarSegment } from '../src/core/types';

/** 每个测试使用独立的内存 localStorage 桩 */
const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});

describe('必选切换与容量日历', () => {
  it('受限时段达到有效容量后拒绝必选，状态与版本不变', () => {
    // capacity=2，但 [0,10) 被压到 1：两个重叠的 [0,10) 作业不能同时必选
    const calendar: CapacityCalendarSegment[] = [{ start: 0, end: 10, available: 1 }];
    const w = createWorkspace({
      capacity: 2,
      jobs: [
        { id: 'a', start: 0, end: 10, benefit: 5 },
        { id: 'b', start: 0, end: 10, benefit: 6 },
      ],
      capacityCalendar: calendar,
    });
    const { tree, index } = createDepthIndex(w);
    expect(applyStatusChange(w, tree, index, 0, 'required').rejected).toBeUndefined();
    const before = { status: w.jobs[1].status, version: w.version };
    const r = applyStatusChange(w, tree, index, 1, 'required');
    expect(r.rejected).toBeDefined();
    // 超限不改状态和版本
    expect(w.jobs[1].status).toBe(before.status);
    expect(w.version).toBe(before.version);
  });

  it('日历之外的重叠作业可同时必选（按各自覆盖的分时上限判定）', () => {
    const calendar: CapacityCalendarSegment[] = [{ start: 0, end: 10, available: 1 }];
    const w = createWorkspace({
      capacity: 2,
      jobs: [
        { id: 'a', start: 0, end: 10, benefit: 5 },
        { id: 'c', start: 10, end: 20, benefit: 5 },
        { id: 'd', start: 10, end: 20, benefit: 6 },
      ],
      capacityCalendar: calendar,
    });
    const { tree, index } = createDepthIndex(w);
    // a 占受限段；c、d 在受限段之后，容量恢复为 2，可与 a 同时必选
    expect(applyStatusChange(w, tree, index, 0, 'required').rejected).toBeUndefined();
    expect(applyStatusChange(w, tree, index, 1, 'required').rejected).toBeUndefined();
    expect(applyStatusChange(w, tree, index, 2, 'required').rejected).toBeUndefined();
    expect(checkRequiredFeasible(w)).toBeUndefined();
  });

  it('跨越 available=0 片段的作业不可设为必选', () => {
    const calendar: CapacityCalendarSegment[] = [{ start: 5, end: 15, available: 0 }];
    const w = createWorkspace({
      capacity: 2,
      jobs: [
        { id: 'span', start: 0, end: 20, benefit: 5 },
        { id: 'before', start: 0, end: 5, benefit: 5 },
        { id: 'after', start: 15, end: 20, benefit: 5 },
      ],
      capacityCalendar: calendar,
    });
    const { tree, index } = createDepthIndex(w);
    expect(applyStatusChange(w, tree, index, 0, 'required').rejected).toBeDefined();
    // 相接作业不受影响
    expect(applyStatusChange(w, tree, index, 1, 'required').rejected).toBeUndefined();
    expect(applyStatusChange(w, tree, index, 2, 'required').rejected).toBeUndefined();
  });

  it('部分跨越受限段的作业按最紧的小格判定', () => {
    // 作业 [0,20) 跨越 [0,10) 限 1 的段：单作业可必选，再来一个重叠即拒
    const calendar: CapacityCalendarSegment[] = [{ start: 0, end: 10, available: 1 }];
    const w = createWorkspace({
      capacity: 2,
      jobs: [
        { id: 'long', start: 0, end: 20, benefit: 5 },
        { id: 'tail', start: 10, end: 20, benefit: 5 },
      ],
      capacityCalendar: calendar,
    });
    const { tree, index } = createDepthIndex(w);
    expect(applyStatusChange(w, tree, index, 0, 'required').rejected).toBeUndefined();
    // tail 只在 [10,20)，与 long 在该段并行（容量 2）=> 允许
    expect(applyStatusChange(w, tree, index, 1, 'required').rejected).toBeUndefined();
  });

  it('checkRequiredFeasible 能识别日历导致的必选冲突', () => {
    const calendar: CapacityCalendarSegment[] = [{ start: 0, end: 10, available: 1 }];
    const w = createWorkspace({
      capacity: 2,
      jobs: [
        { id: 'a', start: 0, end: 10, benefit: 5 },
        { id: 'b', start: 0, end: 10, benefit: 6 },
      ],
      capacityCalendar: calendar,
    });
    w.jobs[0].status = 'required';
    w.jobs[1].status = 'required';
    expect(checkRequiredFeasible(w)).toBeDefined();
  });
});

describe('持久化：日历随工作区/快照存储，旧数据缺字段保持原行为', () => {
  it('日历随工作区往返持久化', () => {
    const calendar: CapacityCalendarSegment[] = [
      { start: 0, end: 10, available: 1 },
      { start: 10, end: 20, available: 0 },
    ];
    const w = createWorkspace({
      capacity: 2,
      jobs: [{ id: 'a', start: 0, end: 20, benefit: 5 }],
      capacityCalendar: calendar,
    });
    persistWorkspace(w);
    const loaded = loadWorkspace();
    expect(loaded).not.toBeNull();
    expect(loaded!.capacityCalendar).toEqual(calendar);
    expect(loaded!.jobs).toHaveLength(1);
  });

  it('旧版本地工作区缺 capacityCalendar 字段：加载为空数组（全程 capacity）', () => {
    // 手工写入旧格式（无日历字段）
    storage.set(
      'rail-possession-scheduler:v1',
      JSON.stringify({
        capacity: 3,
        version: 7,
        jobs: [{ id: 'old', start: 0, end: 10, benefit: 1, status: 'normal' }],
      }),
    );
    const loaded = loadWorkspace();
    expect(loaded).not.toBeNull();
    expect(loaded!.capacity).toBe(3);
    expect(loaded!.version).toBe(7);
    expect(loaded!.capacityCalendar).toEqual([]);
  });

  it('旧快照缺日历/peakCellLimit：加载不报错，日历视为空', () => {
    storage.set(
      'rail-possession-scheduler:snapshot:v1',
      JSON.stringify({
        workspaceVersion: 2,
        capacity: 2,
        solvedAt: '2026-09-20T00:00:00.000Z',
        result: {
          selectedIds: ['x'],
          totalBenefit: 5,
          peakOccupancy: 1,
          capacity: 2,
          selectedCount: 1,
        },
      }),
    );
    const snap = loadSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.capacityCalendar).toEqual([]);
    // 旧结果缺 peakCellLimit：下载回退到全程 capacity
    const json = buildResultJson(snap!);
    expect(json.peakCellLimit).toBe(2);
    expect(json.capacityCalendar).toEqual([]);
    expect(json.selectedIds).toEqual(['x']);
  });

  it('下载结果 JSON 包含同一日历、集合、收益与峰值数据', () => {
    const calendar: CapacityCalendarSegment[] = [{ start: 0, end: 10, available: 1 }];
    const snapshot = {
      workspaceVersion: 3,
      capacity: 2,
      capacityCalendar: calendar,
      solvedAt: '2026-09-22T00:00:00.000Z',
      result: {
        selectedIds: ['b', 'c'],
        totalBenefit: 19,
        peakOccupancy: 2,
        peakCellLimit: 2,
        capacity: 2,
        selectedCount: 2,
      },
    };
    const json = buildResultJson(snapshot);
    expect(json.capacityCalendar).toBe(calendar); // 同一引用/同一数据源
    expect(json.selectedIds).toEqual(['b', 'c']);
    expect(json.totalBenefit).toBe(19);
    expect(json.peakOccupancy).toBe(2);
    expect(json.peakCellLimit).toBe(2);
    expect(json.capacity).toBe(2);
    expect(json.workspaceVersion).toBe(3);
  });
});
