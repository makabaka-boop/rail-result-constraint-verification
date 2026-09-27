import { describe, expect, it, beforeEach } from 'vitest';
import {
  restoreSession,
  persistWorkspace,
  persistSnapshot,
  persistReference,
  loadReference,
  clearReference,
  buildResultJson,
  type StoredSnapshot,
} from '../src/core/persistence';
import { createWorkspace } from '../src/core/workspace';
import { computeReferenceDiff, type ReferencePlan } from '../src/core/reference';
import { newDataId } from '../src/core/identity';
import { solve } from '../src/core/solver';
import type { Capacity, CapacityCalendarSegment, Workspace } from '../src/core/types';

const SNAP_KEY = 'rail-possession-scheduler:snapshot:v1';
const REF_KEY = 'rail-possession-scheduler:reference:v1';

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

function snapshotFor(workspace: Workspace, version = workspace.version): StoredSnapshot {
  const result = solve(workspace.jobs, workspace.capacity, workspace.capacityCalendar);
  return {
    workspaceDataId: workspace.dataId,
    workspaceVersion: version,
    capacity: workspace.capacity,
    capacityCalendar: workspace.capacityCalendar,
    solvedAt: '2026-09-23T08:00:00.000Z',
    result,
  };
}

function referenceFor(workspace: Workspace, memberIds: string[]): ReferencePlan {
  const byId = new Map(workspace.jobs.map((j) => [j.id, j]));
  return {
    workspaceDataId: workspace.dataId,
    workspaceVersion: workspace.version,
    adoptedAt: '2026-09-23T09:00:00.000Z',
    members: memberIds
      .map((id) => byId.get(id))
      .filter((j): j is NonNullable<typeof j> => !!j)
      .map((j) => ({ id: j.id, start: j.start, end: j.end })),
  };
}

describe('参考方案：采纳与持久化', () => {
  it('采纳的参考随会话恢复（dataId 配套），且不依赖快照存在', () => {
    const w = makeWorkspace([
      { id: 'a', start: 0, end: 10, benefit: 5 },
      { id: 'b', start: 0, end: 10, benefit: 7 },
    ]);
    persistWorkspace(w);
    persistReference(referenceFor(w, ['a']));
    // 快照键故意不写：参考独立持久化
    const session = restoreSession();
    expect(session.workspace!.dataId).toBe(w.dataId);
    expect(session.snapshot).toBeNull();
    expect(session.reference).not.toBeNull();
    expect(session.reference!.members.map((m) => m.id)).toEqual(['a']);
    expect(session.reference!.workspaceDataId).toBe(w.dataId);
  });

  it('loadReference 只做结构校验，损坏返回 null', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    persistReference(referenceFor(w, ['a']));
    expect(loadReference()!.members).toHaveLength(1);
    storage.set(REF_KEY, '{not json');
    expect(loadReference()).toBeNull();
  });

  it('参考结构非法（无 dataId/成员畸形/重复端点字段错误）：恢复时整体拒绝并清除', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    persistWorkspace(w);
    const good: ReferencePlan = referenceFor(w, ['a']);

    storage.set(
      REF_KEY,
      JSON.stringify({ ...good, workspaceDataId: '' }),
    );
    expect(restoreSession().reference).toBeNull();
    expect(storage.has(REF_KEY)).toBe(false); // 非法记录被清除

    storage.set(REF_KEY, JSON.stringify({ ...good, members: [{ id: 'a', start: 0 }] }));
    expect(restoreSession().reference).toBeNull();

    storage.set(
      REF_KEY,
      JSON.stringify({ ...good, members: [{ id: 'a', start: 5, end: 5 }] }),
    );
    expect(restoreSession().reference).toBeNull();

    storage.set(REF_KEY, JSON.stringify({ ...good, workspaceVersion: 0 }));
    expect(restoreSession().reference).toBeNull();
  });

  it('成员重复（同 id+start+end）在持久化读取时规范化去重', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    persistWorkspace(w);
    storage.set(
      REF_KEY,
      JSON.stringify({
        workspaceDataId: w.dataId,
        workspaceVersion: 1,
        adoptedAt: 't',
        members: [
          { id: 'a', start: 0, end: 10 },
          { id: 'a', start: 0, end: 10 },
        ],
      }),
    );
    expect(loadReference()!.members).toHaveLength(1);
  });
});

describe('参考方案：身份绑定——导入新数据/异身份记录绝不误用', () => {
  it('异身份参考：恢复到 B 的工作区时 A 的参考被丢弃并删除', () => {
    const a = makeWorkspace([{ id: 'a1', start: 0, end: 10, benefit: 1 }]);
    const b = makeWorkspace([{ id: 'b1', start: 0, end: 10, benefit: 2 }]);
    persistWorkspace(a);
    persistReference(referenceFor(a, ['a1']));
    // 次日导入 B（工作区被覆盖；模拟参考键残留——清理由新导入负责，
    // 这里直接验证 restore 的防混合：不调 clearReference 也不能误用）
    persistWorkspace(b);

    const session = restoreSession();
    expect(session.workspace!.dataId).toBe(b.dataId);
    expect(session.reference).toBeNull();
    expect(storage.has(REF_KEY)).toBe(false);
  });

  it('旧格式本地记录（无 dataId 字段的参考）：不配套，删除且不生效', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    persistWorkspace(w);
    storage.set(
      REF_KEY,
      JSON.stringify({
        workspaceVersion: 1,
        adoptedAt: 'old',
        members: [{ id: 'a', start: 0, end: 10 }],
      }),
    );
    const session = restoreSession();
    expect(session.reference).toBeNull();
    expect(storage.has(REF_KEY)).toBe(false);
  });

  it('版本号相同但 dataId 不同（两批新导入都从 v1 起）：参考不配套', () => {
    const a = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 1 }]);
    const b = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 2 }]);
    persistReference(referenceFor(a, ['a'])); // 注意两批都有 id a
    persistWorkspace(b);
    const session = restoreSession();
    expect(session.reference).toBeNull();
  });

  it('clearReference：导入新数据时调用，内存键与本地记录同时清除', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    persistReference(referenceFor(w, ['a']));
    expect(storage.has(REF_KEY)).toBe(true);
    clearReference();
    expect(storage.has(REF_KEY)).toBe(false);
    expect(loadReference()).toBeNull();
  });

  it('只有参考键（无工作区）：恢复为空且参考被清除', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    persistReference(referenceFor(w, ['a']));
    const session = restoreSession();
    expect(session).toEqual({ workspace: null, snapshot: null, reference: null });
    expect(storage.has(REF_KEY)).toBe(false);
  });
});

describe('参考方案：恢复后差异计算与下载 JSON 同一快照', () => {
  it('结果页三类名单与下载 reference 区块逐项一致', () => {
    // 工作区：a/b 重叠（cap=1），c 在后面；参考为 a+b（旧 cap=2 通知版本）
    const w = makeWorkspace(
      [
        { id: 'a', start: 0, end: 10, benefit: 5 },
        { id: 'b', start: 0, end: 10, benefit: 5 },
        { id: 'c', start: 10, end: 20, benefit: 9 },
        { id: 'gone', start: 20, end: 30, benefit: 2 },
      ],
      1,
    );
    // 构造参考：a + b + gone（gone 随后从工作区删除）
    const fullWs = makeWorkspace(
      [
        { id: 'a', start: 0, end: 10, benefit: 5 },
        { id: 'b', start: 0, end: 10, benefit: 5 },
        { id: 'c', start: 10, end: 20, benefit: 9 },
        { id: 'gone', start: 20, end: 30, benefit: 2 },
      ],
      1,
    );
    const plan: ReferencePlan = {
      ...referenceFor(fullWs, ['a', 'b', 'gone']),
      workspaceDataId: w.dataId,
    };

    // 当前工作区删掉 gone
    const live: Workspace = { ...w, jobs: w.jobs.filter((j) => j.id !== 'gone') };
    persistWorkspace(live);
    const snap = snapshotFor(live);
    persistSnapshot(snap);
    persistReference(plan);

    const session = restoreSession();
    expect(session.reference).not.toBeNull();
    const diff = computeReferenceDiff(session.snapshot!.result.selectedIds, live.jobs, session.reference!);

    // cap=1 下 a/b 二选一（同分，参考偏向其一），c 必选式最优入选
    const payload = buildResultJson(session.snapshot!, session.reference, diff);
    expect(payload.reference).toBeDefined();
    // 屏幕与下载严格一致
    expect(payload.reference!.retained).toEqual(diff.retained);
    expect(payload.reference!.removed).toEqual(diff.removed);
    expect(payload.reference!.added).toEqual(diff.added);
    expect(payload.reference!.deletedReference.map((m) => m.id)).toEqual(['gone']);
    expect(payload.reference!.diffCount).toBe(diff.diffCount);
    // 删除成员不计入可避免差异
    const ids = payload.selectedIds;
    const liveDiff = computeReferenceDiff(ids, live.jobs, session.reference!);
    expect(liveDiff.deletedReference.map((m) => m.id)).toEqual(['gone']);
    expect(liveDiff.diffCount).toBe(liveDiff.removed.length + liveDiff.added.length);
  });

  it('无参考时下载 JSON 结构保持原样（没有 reference 字段）', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    const snap = snapshotFor(w);
    const payload = buildResultJson(snap, null, null);
    expect('reference' in payload).toBe(false);
  });

  it('改期成员：旧时刻撤下、新时刻新增，下载与屏幕一致', () => {
    const plan: ReferencePlan = {
      workspaceDataId: newDataId(),
      workspaceVersion: 1,
      adoptedAt: 't',
      members: [{ id: 'a', start: 0, end: 10 }],
    };
    const moved: Workspace = {
      capacity: 1,
      version: 1,
      dataId: plan.workspaceDataId,
      capacityCalendar: [],
      jobs: [{ id: 'a', start: 5, end: 15, benefit: 5, status: 'normal' }],
    };
    const snap = snapshotFor(moved);
    const diff = computeReferenceDiff(snap.result.selectedIds, moved.jobs, plan);
    const payload = buildResultJson(snap, plan, diff);
    expect(payload.reference!.removed).toEqual([
      { id: 'a', start: 0, end: 10, currentStart: 5, currentEnd: 15 },
    ]);
    expect(payload.reference!.added).toEqual([
      { id: 'a', start: 5, end: 15, currentStart: 5, currentEnd: 15 },
    ]);
    expect(payload.reference!.retained).toEqual([]);
    expect(payload.reference!.diffCount).toBe(2);
  });
});

describe('参考方案：单键写入 / 存储失败 / 异步旧结果', () => {
  it('只成功写入参考键（工作区写入失败）：孤儿参考恢复时丢弃', () => {
    const w = makeWorkspace([{ id: 'a', start: 0, end: 10, benefit: 5 }]);
    persistReference(referenceFor(w, ['a']));
    // 不写工作区
    expect(restoreSession()).toEqual({ workspace: null, snapshot: null, reference: null });
    expect(storage.has(REF_KEY)).toBe(false);
  });

  it('工作区 + 快照 + 参考 三键齐全且同身份：全部恢复', () => {
    const w = makeWorkspace([
      { id: 'a', start: 0, end: 10, benefit: 5 },
      { id: 'b', start: 10, end: 20, benefit: 6 },
    ]);
    persistWorkspace(w);
    persistSnapshot(snapshotFor(w));
    persistReference(referenceFor(w, ['a', 'b']));
    const session = restoreSession();
    expect(session.workspace!.dataId).toBe(w.dataId);
    expect(session.snapshot).not.toBeNull();
    expect(session.reference!.members).toHaveLength(2);
  });

  it('快照异身份被弃、参考同身份仍保留（两者独立配对）', () => {
    const a = makeWorkspace([{ id: 'a1', start: 0, end: 10, benefit: 1 }]);
    const b = makeWorkspace([{ id: 'b1', start: 0, end: 10, benefit: 2 }]);
    persistWorkspace(b);
    // 快照是 A 的（异身份），参考是 B 的（同身份）
    persistSnapshot(snapshotFor(a));
    persistReference(referenceFor(b, ['b1']));
    const session = restoreSession();
    expect(session.snapshot).toBeNull();
    expect(storage.has(SNAP_KEY)).toBe(false);
    expect(session.reference).not.toBeNull();
    expect(session.reference!.members[0].id).toBe('b1');
  });

  it('参考持久化抛异常（配额/隐私模式）：不抛出，功能在内存中仍可用', () => {
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: () => null,
      setItem: (k: string) => {
        if (k === REF_KEY) throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as Storage;
    expect(() =>
      persistReference({
        workspaceDataId: newDataId(),
        workspaceVersion: 1,
        adoptedAt: 't',
        members: [],
      }),
    ).not.toThrow();
    expect(loadReference()).toBeNull();
  });

  it('参考损坏时 clearReference 的 removeItem 抛异常也安全降级', () => {
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
      removeItem: () => {
        throw new Error('SecurityError');
      },
      clear: () => {},
      key: () => null,
      length: 0,
    } as Storage;
    expect(() => restoreSession()).not.toThrow();
    expect(() => clearReference()).not.toThrow();
  });
});
