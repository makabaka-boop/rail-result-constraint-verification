import { describe, expect, it, beforeEach } from 'vitest';
import {
  restoreSession,
  persistWorkspace,
  persistSnapshot,
  resultMatchesWorkspace,
  resultIsDeliverable,
  resultHasOptimalBenefit,
  selectionRespectsConstraints,
  snapshotMatchesWorkspace,
  snapshotBelongsToWorkspace,
  buildResultJson,
  type StoredSnapshot,
} from '../src/core/persistence';
import { createWorkspace } from '../src/core/workspace';
import { solve } from '../src/core/solver';
import type { Capacity, CapacityCalendarSegment, Workspace } from '../src/core/types';

const SNAP_KEY = 'rail-possession-scheduler:snapshot:v1';

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

function makeWorkspace(
  jobs: { id: string; start: number; end: number; benefit: number }[],
  capacity: Capacity = 2,
  calendar: CapacityCalendarSegment[] = [],
): Workspace {
  return createWorkspace({ capacity, jobs, capacityCalendar: calendar });
}

/** 用求解器为工作区计算一份真实结果，构造同身份配套快照 */
function snapshotFor(workspace: Workspace, version = workspace.version): StoredSnapshot {
  const result = solve(workspace.jobs, workspace.capacity, workspace.capacityCalendar);
  return {
    workspaceDataId: workspace.dataId,
    workspaceVersion: version,
    capacity: workspace.capacity,
    capacityCalendar: workspace.capacityCalendar,
    solvedAt: '2026-09-27T08:00:00.000Z',
    result,
  };
}

/** 伪造一份自称当前版本的快照：身份/版本/容量/日历全部照抄工作区，仅结果体被替换 */
function forgedCurrentSnapshot(
  workspace: Workspace,
  result: StoredSnapshot['result'],
): StoredSnapshot {
  return {
    workspaceDataId: workspace.dataId,
    workspaceVersion: workspace.version,
    capacity: workspace.capacity,
    capacityCalendar: workspace.capacityCalendar,
    solvedAt: '2026-09-27T09:00:00.000Z',
    result,
  };
}

function persistPair(workspace: Workspace, snapshot: StoredSnapshot): void {
  persistWorkspace(workspace);
  persistSnapshot(snapshot);
}

describe('交付校验：自称当前版本的结果必须满足必选/排除/最优收益', () => {
  it('遗漏必选作业的同版本快照：身份版本全对也被整体拒绝并清除', () => {
    const w = makeWorkspace([
      { id: 'must', start: 0, end: 10, benefit: 5 },
      { id: 'opt', start: 10, end: 20, benefit: 6 },
    ]);
    w.jobs[0].status = 'required';
    // 伪造：只选了普通作业，必选 “must” 被遗漏；收益/峰值内部自洽
    const forged = forgedCurrentSnapshot(w, {
      selectedIds: ['opt'],
      totalBenefit: 6,
      peakOccupancy: 1,
      peakCellLimit: 2,
      capacity: 2,
      selectedCount: 1,
    });
    // 结构一致性核对确实通过——漏洞就在这一层
    expect(resultMatchesWorkspace(w, forged.result)).toBe(true);
    expect(selectionRespectsConstraints(w, forged.result.selectedIds)).toBe(false);
    expect(resultIsDeliverable(w, forged.result)).toBe(false);

    persistPair(w, forged);
    const session = restoreSession();
    expect(session.workspace).not.toBeNull();
    expect(session.snapshot).toBeNull(); // 不得作为当前排程交付
    expect(storage.has(SNAP_KEY)).toBe(false);
  });

  it('纳入排除作业的同版本快照：即使收益恰好等于最优也被拒绝', () => {
    // capacity=1；e 被排除、f 普通，二者完全重叠且收益相同：
    // 伪造结果选 e（收益 3 = 最优值 3），只有排除合规检查能拦下
    const w = makeWorkspace(
      [
        { id: 'e', start: 0, end: 10, benefit: 3 },
        { id: 'f', start: 0, end: 10, benefit: 3 },
      ],
      1,
    );
    w.jobs[0].status = 'excluded';
    const forged = forgedCurrentSnapshot(w, {
      selectedIds: ['e'],
      totalBenefit: 3,
      peakOccupancy: 1,
      peakCellLimit: 1,
      capacity: 1,
      selectedCount: 1,
    });
    expect(resultMatchesWorkspace(w, forged.result)).toBe(true);
    expect(resultHasOptimalBenefit(w, forged.result)).toBe(true); // 收益确实是最优值
    expect(selectionRespectsConstraints(w, forged.result.selectedIds)).toBe(false);
    expect(resultIsDeliverable(w, forged.result)).toBe(false);

    persistPair(w, forged);
    const session = restoreSession();
    expect(session.snapshot).toBeNull();
    expect(storage.has(SNAP_KEY)).toBe(false);
  });

  it('收益次优但内部自洽的同版本快照：不得继续显示为最优', () => {
    // capacity=1 下 a/b 完全重叠：最优选 b（6），伪造选 a（5），自洽但次优
    const w = makeWorkspace(
      [
        { id: 'a', start: 0, end: 10, benefit: 5 },
        { id: 'b', start: 0, end: 10, benefit: 6 },
      ],
      1,
    );
    const forged = forgedCurrentSnapshot(w, {
      selectedIds: ['a'],
      totalBenefit: 5,
      peakOccupancy: 1,
      peakCellLimit: 1,
      capacity: 1,
      selectedCount: 1,
    });
    expect(resultMatchesWorkspace(w, forged.result)).toBe(true);
    expect(selectionRespectsConstraints(w, forged.result.selectedIds)).toBe(true); // 无必选/排除
    expect(resultHasOptimalBenefit(w, forged.result)).toBe(false);
    expect(resultIsDeliverable(w, forged.result)).toBe(false);

    persistPair(w, forged);
    const session = restoreSession();
    expect(session.snapshot).toBeNull();
    expect(storage.has(SNAP_KEY)).toBe(false);
  });

  it('容量日历压容下的次优快照：同样被拒绝', () => {
    // capacity=2，[0,10) 压到 1：a/b 只能选一个（最优选 b=6），c 必入选
    const calendar: CapacityCalendarSegment[] = [{ start: 0, end: 10, available: 1 }];
    const w = makeWorkspace(
      [
        { id: 'a', start: 0, end: 10, benefit: 5 },
        { id: 'b', start: 0, end: 10, benefit: 6 },
        { id: 'c', start: 10, end: 20, benefit: 7 },
      ],
      2,
      calendar,
    );
    const forged = forgedCurrentSnapshot(w, {
      selectedIds: ['a', 'c'],
      totalBenefit: 12,
      peakOccupancy: 1,
      peakCellLimit: 1,
      capacity: 2,
      selectedCount: 2,
    });
    expect(resultMatchesWorkspace(w, forged.result)).toBe(true);
    expect(resultIsDeliverable(w, forged.result)).toBe(false); // 最优是 b+c=13

    persistPair(w, forged);
    expect(restoreSession().snapshot).toBeNull();
    expect(storage.has(SNAP_KEY)).toBe(false);
  });

  it('必选不可行的工作区：任何自称当前结果的快照都不存在（求解抛错路径）', () => {
    const w = makeWorkspace(
      [
        { id: 'a', start: 0, end: 10, benefit: 5 },
        { id: 'b', start: 0, end: 10, benefit: 6 },
      ],
      1,
    );
    w.jobs[0].status = 'required';
    w.jobs[1].status = 'required'; // capacity=1 下两个必选完全重叠：不可行
    const forged = forgedCurrentSnapshot(w, {
      selectedIds: ['a'],
      totalBenefit: 5,
      peakOccupancy: 1,
      peakCellLimit: 1,
      capacity: 1,
      selectedCount: 1,
    });
    expect(resultMatchesWorkspace(w, forged.result)).toBe(true);
    expect(resultIsDeliverable(w, forged.result)).toBe(false);

    persistPair(w, forged);
    expect(restoreSession().snapshot).toBeNull();
    expect(storage.has(SNAP_KEY)).toBe(false);
  });

  it('伪造当前快照被弃后，重新求解的真实结果正常落地（端到端回归）', () => {
    const w = makeWorkspace(
      [
        { id: 'a', start: 0, end: 10, benefit: 5 },
        { id: 'b', start: 0, end: 10, benefit: 6 },
      ],
      1,
    );
    persistPair(
      w,
      forgedCurrentSnapshot(w, {
        selectedIds: ['a'],
        totalBenefit: 5,
        peakOccupancy: 1,
        peakCellLimit: 1,
        capacity: 1,
        selectedCount: 1,
      }),
    );
    expect(restoreSession().snapshot).toBeNull();

    // 调度员重新计算：真实最优结果（选 b，收益 6）正常恢复、可下载
    persistSnapshot(snapshotFor(w));
    const session = restoreSession();
    expect(session.snapshot).not.toBeNull();
    const json = buildResultJson(session.snapshot!);
    expect(json.selectedIds).toEqual(['b']);
    expect(json.totalBenefit).toBe(6);
  });
});

describe('合法既有排程：正常恢复与查看不受影响', () => {
  it('真实求解的当前版本快照通过交付校验并随会话恢复', () => {
    const w = makeWorkspace(
      [
        { id: 'a', start: 0, end: 10, benefit: 5 },
        { id: 'b', start: 0, end: 10, benefit: 6 },
        { id: 'c', start: 10, end: 20, benefit: 7 },
      ],
      2,
    );
    w.jobs[2].status = 'required';
    const snap = snapshotFor(w);
    expect(resultIsDeliverable(w, snap.result)).toBe(true);
    expect(snapshotMatchesWorkspace(snap, w)).toBe(true);

    persistPair(w, snap);
    const session = restoreSession();
    expect(session.snapshot).not.toBeNull();
    expect(session.snapshot!.workspaceVersion).toBe(w.version);
    expect(session.snapshot!.result.selectedIds).toEqual(snap.result.selectedIds);
  });

  it('同身份旧版本快照不满足当前必选/排除：仍恢复为“已过期”（不冒充当前）', () => {
    // v1 时全部普通，最优选 x+y；随后 x 被排除、y 被设为必选（v2）
    const w = makeWorkspace([
      { id: 'x', start: 0, end: 10, benefit: 5 },
      { id: 'y', start: 20, end: 30, benefit: 4 },
    ]);
    const staleSnap = snapshotFor(w, 1); // 含 x（现已被排除）
    w.jobs[0].status = 'excluded';
    w.jobs[1].status = 'required';
    w.version = 2;
    persistPair(w, staleSnap);

    const session = restoreSession();
    expect(session.snapshot).not.toBeNull(); // 合法既有排程仍正常恢复
    expect(session.snapshot!.workspaceVersion).toBe(1);
    expect(session.workspace!.version).toBe(2);
    // 属于本工作区（过期展示），但不是可交付的当前结果
    expect(snapshotBelongsToWorkspace(session.snapshot!, session.workspace!)).toBe(true);
    expect(snapshotMatchesWorkspace(session.snapshot!, session.workspace!)).toBe(false);
  });

  it('空排程（全部排除）是合法的当前结果：可恢复可交付', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    w.jobs[0].status = 'excluded';
    const snap = snapshotFor(w); // selectedIds=[]，totalBenefit=0
    expect(snap.result.selectedCount).toBe(0);
    expect(resultIsDeliverable(w, snap.result)).toBe(true);

    persistPair(w, snap);
    const session = restoreSession();
    expect(session.snapshot).not.toBeNull();
    expect(session.snapshot!.result.totalBenefit).toBe(0);
  });
});

describe('交付校验单元行为', () => {
  it('selectionRespectsConstraints：必选遗漏/排除纳入/幽灵 id 的判定', () => {
    const w = makeWorkspace([
      { id: 'r', start: 0, end: 10, benefit: 5 },
      { id: 'x', start: 0, end: 10, benefit: 5 },
      { id: 'n', start: 20, end: 30, benefit: 5 },
    ]);
    w.jobs[0].status = 'required';
    w.jobs[1].status = 'excluded';
    expect(selectionRespectsConstraints(w, ['r', 'n'])).toBe(true);
    expect(selectionRespectsConstraints(w, ['n'])).toBe(false); // 漏必选
    expect(selectionRespectsConstraints(w, ['r', 'x'])).toBe(false); // 纳入排除
    expect(selectionRespectsConstraints(w, ['r', 'n', 'ghost'])).toBe(true); // 幽灵 id 由存在性核对负责
  });

  it('resultHasOptimalBenefit：等于最优值放行，偏高/偏低都拒绝', () => {
    const w = makeWorkspace(
      [
        { id: 'a', start: 0, end: 10, benefit: 5 },
        { id: 'b', start: 0, end: 10, benefit: 6 },
      ],
      1,
    );
    expect(resultHasOptimalBenefit(w, { totalBenefit: 6 })).toBe(true);
    expect(resultHasOptimalBenefit(w, { totalBenefit: 5 })).toBe(false);
    expect(resultHasOptimalBenefit(w, { totalBenefit: 7 })).toBe(false); // 虚报同样拒绝
  });

  it('snapshotMatchesWorkspace 升级为交付级配对：版本相等但次优即不配套', () => {
    const w = makeWorkspace(
      [
        { id: 'a', start: 0, end: 10, benefit: 5 },
        { id: 'b', start: 0, end: 10, benefit: 6 },
      ],
      1,
    );
    const good = snapshotFor(w);
    expect(snapshotMatchesWorkspace(good, w)).toBe(true);

    const suboptimal = forgedCurrentSnapshot(w, {
      selectedIds: ['a'],
      totalBenefit: 5,
      peakOccupancy: 1,
      peakCellLimit: 1,
      capacity: 1,
      selectedCount: 1,
    });
    expect(snapshotMatchesWorkspace(suboptimal, w)).toBe(false);
    // 但仍是本批数据的一份自洽结果（过期归属判定不受影响）
    expect(snapshotBelongsToWorkspace(suboptimal, w)).toBe(true);
  });
});
