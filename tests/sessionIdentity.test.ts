import { describe, expect, it, beforeEach } from 'vitest';
import {
  restoreSession,
  persistWorkspace,
  persistSnapshot,
  loadWorkspace,
  resultMatchesWorkspace,
  snapshotBelongsToWorkspace,
  buildResultJson,
  type StoredSnapshot,
} from '../src/core/persistence';
import { createWorkspace } from '../src/core/workspace';
import { newDataId } from '../src/core/identity';
import { decodeSolveResponse } from '../src/ui/messages';
import { solve } from '../src/core/solver';
import type { Capacity, CapacityCalendarSegment, Workspace } from '../src/core/types';

const WS_KEY = 'rail-possession-scheduler:v1';
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

/** 两批不同数据：容量与版本号故意相同（均从 version=1 起步） */
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
    solvedAt: '2026-09-22T08:00:00.000Z',
    result,
  };
}

function persistPair(workspace: Workspace, snapshot: StoredSnapshot): void {
  persistWorkspace(workspace);
  persistSnapshot(snapshot);
}

describe('数据身份：导入另一批数据得到全新 dataId，版本号相同也不配套', () => {
  it('两次导入的工作区 dataId 不同，尽管版本号都从 1 开始', () => {
    const a = makeWorkspace([{ id: 'a1', start: 0, end: 10, benefit: 30 }]);
    const b = makeWorkspace([{ id: 'b1', start: 0, end: 10, benefit: 99 }]);
    expect(a.version).toBe(1);
    expect(b.version).toBe(1);
    expect(a.dataId).not.toBe(b.dataId);
    expect(a.dataId.length).toBeGreaterThan(0);
  });

  it('同版本异数据：存储里是 A 的快照、工作区是 B，恢复结果不展示 A 的快照', () => {
    const a = makeWorkspace([{ id: 'a-only', start: 0, end: 10, benefit: 30 }]);
    const b = makeWorkspace([{ id: 'b-only', start: 0, end: 10, benefit: 99 }]);
    // 模拟昨日：A 工作区 + A 的求解快照（两键都成功）
    persistPair(a, snapshotFor(a));
    // 今日只写入了新工作区 B（单键写入场景的一种：新工作区已写，旧快照还在）
    persistWorkspace(b);

    const session = restoreSession();
    expect(session.workspace).not.toBeNull();
    expect(session.workspace!.dataId).toBe(b.dataId);
    expect(session.workspace!.jobs[0].id).toBe('b-only');
    // 关键断言：A 的 selectedIds/总收益/日历不得在 B 的工作区上冒充当前结果
    expect(session.snapshot).toBeNull();
    // 不配套的快照应被清除，不会再次被恢复
    expect(storage.has(SNAP_KEY)).toBe(false);
  });

  it('反向单键写入：新快照已写但工作区仍是 A，孤儿快照被丢弃、A 保留', () => {
    const a = makeWorkspace([{ id: 'a1', start: 0, end: 10, benefit: 1 }]);
    const b = makeWorkspace([{ id: 'b1', start: 0, end: 10, benefit: 2 }]);
    persistPair(a, snapshotFor(a));
    // 只有快照键被新数据覆盖（工作区键写入失败的情形）
    persistSnapshot(snapshotFor(b));

    const session = restoreSession();
    expect(session.workspace!.dataId).toBe(a.dataId);
    expect(session.snapshot).toBeNull();
    expect(storage.has(SNAP_KEY)).toBe(false);
  });

  it('两键都写入但交错（A 的工作区 + B 的快照）：不配对，快照丢弃', () => {
    const a = makeWorkspace([{ id: 'a1', start: 0, end: 10, benefit: 1 }]);
    const b = makeWorkspace([{ id: 'b1', start: 0, end: 10, benefit: 2 }]);
    persistWorkspace(a);
    persistSnapshot(snapshotFor(b));

    const session = restoreSession();
    expect(session.workspace!.dataId).toBe(a.dataId);
    expect(session.snapshot).toBeNull();
  });
});

describe('单键写入：只有一份记录时永远不混合恢复', () => {
  it('只有工作区键：恢复工作区，无结果', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    persistWorkspace(w);
    const session = restoreSession();
    expect(session.workspace!.dataId).toBe(w.dataId);
    expect(session.snapshot).toBeNull();
  });

  it('只有快照键：无工作区可配对，快照整体丢弃（不下发给下游）', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    persistSnapshot(snapshotFor(w));
    const session = restoreSession();
    expect(session.workspace).toBeNull();
    expect(session.snapshot).toBeNull();
    expect(storage.has(SNAP_KEY)).toBe(false);
  });

  it('空存储：空仓库', () => {
    const session = restoreSession();
    expect(session.workspace).toBeNull();
    expect(session.snapshot).toBeNull();
  });

  it('存储抛异常（禁用/配额）：安全降级为空会话，不抛出', () => {
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as Storage;
    expect(() => restoreSession()).not.toThrow();
    expect(restoreSession()).toEqual({ workspace: null, snapshot: null, reference: null });
  });
});

describe('同身份结果：当前版本可恢复，旧版本标记为过期但仍可下载', () => {
  it('配套快照随会话恢复，下载 JSON 含同一身份与集合', () => {
    const w = makeWorkspace([
      { id: 'a', start: 0, end: 10, benefit: 5 },
      { id: 'b', start: 0, end: 10, benefit: 7 },
    ]);
    const snap = snapshotFor(w);
    persistPair(w, snap);

    const session = restoreSession();
    expect(session.snapshot).not.toBeNull();
    expect(session.snapshot!.workspaceDataId).toBe(w.dataId);
    expect(session.snapshot!.workspaceVersion).toBe(w.version);
    const json = buildResultJson(session.snapshot!);
    expect(json.dataId).toBe(w.dataId);
    expect(json.selectedIds).toEqual(session.snapshot!.result.selectedIds);
    expect(json.totalBenefit).toBe(12);
  });

  it('同身份旧版本快照恢复为“过期”（可展示/下载，但版本不等于当前）', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    const staleSnap = snapshotFor(w, 1);
    w.jobs[0].status = 'required';
    w.version = 2;
    persistPair(w, staleSnap);

    const session = restoreSession();
    expect(session.snapshot).not.toBeNull();
    expect(session.snapshot!.workspaceVersion).toBe(1);
    expect(session.workspace!.version).toBe(2);
    expect(snapshotBelongsToWorkspace(session.snapshot!, session.workspace!)).toBe(true);
  });
});

describe('畸形日历：越界、重叠、字段非法均不得渲染/导出', () => {
  const validWorkspaceJson = (calendar: unknown) =>
    JSON.stringify({
      dataId: newDataId(),
      capacity: 2,
      version: 1,
      jobs: [{ id: 'a', start: 0, end: 20, benefit: 5, status: 'normal' }],
      capacityCalendar: calendar,
    });

  it('日历片段重叠：工作区整体拒绝', () => {
    storage.set(
      WS_KEY,
      validWorkspaceJson([
        { start: 0, end: 12, available: 1 },
        { start: 10, end: 20, available: 0 },
      ]),
    );
    expect(loadWorkspace()).toBeNull();
    expect(restoreSession().workspace).toBeNull();
  });

  it('日历越出作业范围：拒绝', () => {
    storage.set(WS_KEY, validWorkspaceJson([{ start: 0, end: 21, available: 1 }]));
    expect(loadWorkspace()).toBeNull();
  });

  it('available 超过 capacity-1 / 为负数：拒绝', () => {
    storage.set(WS_KEY, validWorkspaceJson([{ start: 0, end: 10, available: 2 }]));
    expect(loadWorkspace()).toBeNull();
    storage.set(WS_KEY, validWorkspaceJson([{ start: 0, end: 10, available: -1 }]));
    expect(loadWorkspace()).toBeNull();
  });

  it('端点非整数 / end<=start / 非数组：拒绝', () => {
    storage.set(WS_KEY, validWorkspaceJson([{ start: 1.5, end: 10, available: 1 }]));
    expect(loadWorkspace()).toBeNull();
    storage.set(WS_KEY, validWorkspaceJson([{ start: 10, end: 10, available: 1 }]));
    expect(loadWorkspace()).toBeNull();
    storage.set(WS_KEY, validWorkspaceJson('nope'));
    expect(loadWorkspace()).toBeNull();
  });

  it('相接端点的合法日历可恢复', () => {
    storage.set(
      WS_KEY,
      validWorkspaceJson([
        { start: 0, end: 10, available: 1 },
        { start: 10, end: 20, available: 0 },
      ]),
    );
    const w = loadWorkspace();
    expect(w).not.toBeNull();
    expect(w!.capacityCalendar).toHaveLength(2);
  });

  it('快照日历与工作区日历不一致（同身份也拒绝配对）', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 20, benefit: 5 }]);
    const snap = snapshotFor(w);
    snap.capacityCalendar = [{ start: 0, end: 10, available: 0 }];
    persistPair(w, snap);
    expect(restoreSession().snapshot).toBeNull();
  });
});

describe('非法作业状态与不完整结果：拒绝恢复/配对', () => {
  it('作业状态非法：工作区拒绝', () => {
    storage.set(
      WS_KEY,
      JSON.stringify({
        dataId: newDataId(),
        capacity: 2,
        version: 1,
        jobs: [{ id: 'a', start: 0, end: 10, benefit: 5, status: 'maybe' }],
      }),
    );
    expect(loadWorkspace()).toBeNull();
  });

  it('id 重复 / start>=end / benefit 越界 / capacity 非法：拒绝', () => {
    const base = {
      dataId: newDataId(),
      capacity: 2,
      version: 1,
      capacityCalendar: [],
    };
    storage.set(
      WS_KEY,
      JSON.stringify({ ...base, jobs: [
        { id: 'a', start: 0, end: 10, benefit: 5, status: 'normal' },
        { id: 'a', start: 1, end: 9, benefit: 5, status: 'normal' },
      ] }),
    );
    expect(loadWorkspace()).toBeNull();
    storage.set(
      WS_KEY,
      JSON.stringify({ ...base, jobs: [{ id: 'a', start: 10, end: 10, benefit: 5, status: 'normal' }] }),
    );
    expect(loadWorkspace()).toBeNull();
    storage.set(
      WS_KEY,
      JSON.stringify({ ...base, jobs: [{ id: 'a', start: 0, end: 10, benefit: 0, status: 'normal' }] }),
    );
    expect(loadWorkspace()).toBeNull();
    storage.set(
      WS_KEY,
      JSON.stringify({ ...base, capacity: 9, jobs: [{ id: 'a', start: 0, end: 10, benefit: 5, status: 'normal' }] }),
    );
    expect(loadWorkspace()).toBeNull();
  });

  it('快照 result 结构不完整：拒绝（不展示不下载）', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    persistWorkspace(w);
    const broken = {
      workspaceDataId: w.dataId,
      workspaceVersion: 1,
      capacity: 2,
      capacityCalendar: [],
      solvedAt: '2026-09-22T00:00:00.000Z',
      result: { selectedIds: ['a'], totalBenefit: 5 }, // 缺峰值/计数等
    };
    storage.set(SNAP_KEY, JSON.stringify(broken));
    expect(restoreSession().snapshot).toBeNull();
  });

  it('selectedIds 指向不存在的作业：交叉核对失败，快照丢弃', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    const snap = snapshotFor(w);
    snap.result = { ...snap.result, selectedIds: ['ghost'], selectedCount: 1, totalBenefit: 5 };
    persistPair(w, snap);
    const session = restoreSession();
    expect(session.snapshot).toBeNull();
    expect(resultMatchesWorkspace(w, snap.result)).toBe(false);
  });

  it('总收益与入选作业不符 / selectedCount 与 id 数不符：拒绝', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    const s1 = snapshotFor(w);
    s1.result = { ...s1.result, totalBenefit: 999 };
    expect(resultMatchesWorkspace(w, s1.result)).toBe(false);
    const s2 = snapshotFor(w);
    s2.result = { ...s2.result, selectedCount: 2 };
    persistPair(w, s2);
    expect(restoreSession().snapshot).toBeNull();
  });

  it('入选集合超过有效容量（伪造峰值）：拒绝', () => {
    const w = makeWorkspace(
      [
        { id: 'a', start: 0, end: 10, benefit: 5 },
        { id: 'b', start: 0, end: 10, benefit: 6 },
      ],
      1,
    );
    const snap = snapshotFor(w);
    // 求解器在 capacity=1 下只会选 b；伪造为两项同时入选
    snap.result = {
      ...snap.result,
      selectedIds: ['a', 'b'],
      selectedCount: 2,
      totalBenefit: 11,
      peakOccupancy: 2,
    };
    expect(resultMatchesWorkspace(w, snap.result)).toBe(false);
  });

  it('容量与工作区不符：拒绝', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    const snap = snapshotFor(w);
    snap.capacity = 1;
    snap.result = { ...snap.result, capacity: 1 };
    expect(resultMatchesWorkspace(w, snap.result)).toBe(false);
  });
});

describe('旧合法存储可恢复（无 dataId、缺日历、缺 peakCellLimit）', () => {
  it('旧工作区缺 dataId/calendar：补登身份、日历缺省为空并回写迁移', () => {
    storage.set(
      WS_KEY,
      JSON.stringify({
        capacity: 3,
        version: 7,
        jobs: [{ id: 'old', start: 0, end: 10, benefit: 1, status: 'normal' }],
      }),
    );
    const session = restoreSession();
    expect(session.workspace).not.toBeNull();
    expect(session.workspace!.capacity).toBe(3);
    expect(session.workspace!.version).toBe(7);
    expect(session.workspace!.capacityCalendar).toEqual([]);
    expect(session.workspace!.dataId.length).toBeGreaterThan(0);
    expect(session.snapshot).toBeNull();
    // 迁移已回写：再次恢复得到同一 dataId
    const again = restoreSession();
    expect(again.workspace!.dataId).toBe(session.workspace!.dataId);
  });

  it('旧工作区 + 旧快照且内容配套：作为一对迁移，结果可恢复可下载', () => {
    storage.set(
      WS_KEY,
      JSON.stringify({
        capacity: 2,
        version: 2,
        jobs: [{ id: 'x', start: 0, end: 10, benefit: 5, status: 'normal' }],
      }),
    );
    storage.set(
      SNAP_KEY,
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
    const session = restoreSession();
    expect(session.workspace).not.toBeNull();
    expect(session.snapshot).not.toBeNull();
    expect(session.snapshot!.workspaceDataId).toBe(session.workspace!.dataId);
    const json = buildResultJson(session.snapshot!);
    expect(json.dataId).toBe(session.workspace!.dataId);
    expect(json.selectedIds).toEqual(['x']);
    expect(json.peakCellLimit).toBe(2); // 旧结果缺峰值格上限：回退为 capacity
    expect(json.capacityCalendar).toEqual([]);
    // 旧下载结构字段保持不变
    expect(json.workspaceVersion).toBe(2);
  });

  it('旧快照但版本对不上旧工作区：只恢复工作区，快照不冒充当前结果', () => {
    storage.set(
      WS_KEY,
      JSON.stringify({
        capacity: 2,
        version: 3,
        jobs: [{ id: 'x', start: 0, end: 10, benefit: 5, status: 'normal' }],
      }),
    );
    storage.set(
      SNAP_KEY,
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
    const session = restoreSession();
    expect(session.workspace).not.toBeNull();
    expect(session.snapshot).toBeNull();
  });

  it('一新一旧（工作区有 dataId、快照无 dataId）：不配对，快照丢弃', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    persistWorkspace(w);
    storage.set(
      SNAP_KEY,
      JSON.stringify({
        workspaceVersion: 1,
        capacity: 2,
        capacityCalendar: [],
        solvedAt: '2026-09-20T00:00:00.000Z',
        result: {
          selectedIds: ['a'],
          totalBenefit: 5,
          peakOccupancy: 1,
          peakCellLimit: 2,
          capacity: 2,
          selectedCount: 1,
        },
      }),
    );
    const session = restoreSession();
    expect(session.workspace!.dataId).toBe(w.dataId);
    expect(session.snapshot).toBeNull();
  });
});

describe('求解异常与消息解码：确定地退出“计算中”，可再次求解', () => {
  it('null/原始类型/数组消息：解码为 null（丢弃，状态机不会据此卡死）', () => {
    expect(decodeSolveResponse(null)).toBeNull();
    expect(decodeSolveResponse(undefined)).toBeNull();
    expect(decodeSolveResponse('boom')).toBeNull();
    expect(decodeSolveResponse(42)).toBeNull();
    expect(decodeSolveResponse([])).toBeNull();
    expect(decodeSolveResponse({})).toBeNull();
  });

  it('成功消息结构损坏：归一化为可关联的错误响应（带 requestId）', () => {
    const r1 = decodeSolveResponse({ type: 'success', requestId: 7 });
    expect(r1).not.toBeNull();
    expect(r1!.type).toBe('error');
    expect(r1 && 'requestId' in r1 && r1.requestId).toBe(7);
    const badResult = decodeSolveResponse({
      type: 'success',
      requestId: 7,
      dataId: 'd1',
      result: { selectedIds: 'nope', totalBenefit: 1 },
      elapsedMs: 3,
    });
    expect(badResult?.type).toBe('error');
    expect(badResult && 'requestId' in badResult && badResult.requestId).toBe(7);
  });

  it('成功消息缺 dataId：归一化为错误响应（不允许无身份结果落地）', () => {
    const msg = decodeSolveResponse({
      type: 'success',
      requestId: 1,
      result: {
        selectedIds: [],
        totalBenefit: 0,
        peakOccupancy: 0,
        peakCellLimit: 2,
        capacity: 2,
        selectedCount: 0,
      },
      elapsedMs: 1,
    });
    expect(msg?.type).toBe('error');
  });

  it('requestId 非法（无法关联）：返回 null；错误消息体缺 message 有兜底文案', () => {
    expect(decodeSolveResponse({ type: 'error', requestId: 'x' })).toBeNull();
    const decoded = decodeSolveResponse({ type: 'error', requestId: 2 });
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe('error');
    expect(decoded && 'requestId' in decoded && decoded.requestId).toBe(2);
    expect(decoded && 'message' in decoded && typeof decoded.message).toBe('string');
    expect(decoded && 'message' in decoded && decoded.message.length).toBeGreaterThan(0);
  });

  it('合法成功消息可解码且 elapsedMs 非法时回退为 0', () => {
    const decoded = decodeSolveResponse({
      type: 'success',
      requestId: 3,
      dataId: 'd3',
      result: {
        selectedIds: ['a'],
        totalBenefit: 5,
        peakOccupancy: 1,
        peakCellLimit: 2,
        capacity: 2,
        selectedCount: 1,
      },
      elapsedMs: -8,
    });
    expect(decoded?.type).toBe('success');
    if (decoded?.type === 'success') expect(decoded.elapsedMs).toBe(0);
  });

  it('求解器对必选不可行数据抛错：异常被捕获并给出明确信息，数据仍可修改后重算', () => {
    // capacity=1 下两个完全重叠的必选作业：求解抛 InfeasibleRequiredError，
    // 上层 worker 会捕获并回 error 响应（此处直接验证错误确定性）
    const jobs = [
      { id: 'a', start: 0, end: 10, benefit: 5, status: 'required' as const },
      { id: 'b', start: 0, end: 10, benefit: 6, status: 'required' as const },
    ];
    expect(() => solve(jobs, 1, [])).toThrow();
    // 放开一个约束（a 改排除）后立即可以再次求解成功：
    // 纯函数调用不依赖任何外部状态，“再次求解”不存在永久计算中一说
    const retry = solve(
      jobs.map((j) => (j.id === 'a' ? { ...j, status: 'excluded' as const } : j)),
      1,
      [],
    );
    expect(retry.selectedIds).toEqual(['b']);
    expect(retry.totalBenefit).toBe(6);
  });
});
