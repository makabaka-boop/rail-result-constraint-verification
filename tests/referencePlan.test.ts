import { describe, expect, it } from 'vitest';
import { solve, InfeasibleRequiredError, type SolverJob } from '../src/core/solver';
import {
  computeReferenceDiff,
  memberKey,
  normalizeReferenceMembers,
  referenceMembersFromSelection,
  splitReferenceMembers,
  type ReferenceMember,
  type ReferencePlan,
} from '../src/core/reference';
import type { CapacityCalendarSegment, Job, JobStatus } from '../src/core/types';

/**
 * 两级目标的穷举核对：枚举 2^n 个可行子集，严格按字典序
 *   （总收益, -可避免差异数）
 * 取最优；同分时模拟求解器的确定性裁决（固定候选顺序下，对作业边按
 * 下标升序的 SSP 行为等价于“按贪心最短路”，这里用穷举记录全部最优
 * 集合并核对求解结果确实在最优集合族中）。
 */
function bruteForceLexicographic(
  jobs: SolverJob[],
  capacity: number,
  calendar: CapacityCalendarSegment[],
  reference: ReferenceMember[],
): { best: Array<{ ids: string[]; total: number; diff: number }>; feasible: boolean } {
  const n = jobs.length;
  const coordSet = new Set<number>();
  for (const j of jobs) {
    coordSet.add(j.start);
    coordSet.add(j.end);
  }
  for (const seg of calendar) {
    coordSet.add(seg.start);
    coordSet.add(seg.end);
  }
  const coords = [...coordSet].sort((a, b) => a - b);
  const limitAt = (lo: number): number => {
    for (const seg of calendar) {
      if (seg.start <= lo && lo < seg.end) return seg.available;
    }
    return capacity;
  };

  // 只统计与某个候选完全同键（id+start+end）的参考成员；改期后的旧时刻
  // 成员不命中任何候选，与“已删除”一样不参与可避免差异计数（与求解器一致）。
  const candidateKeys = new Set(jobs.map(memberKey));
  const refKeys = new Set(reference.filter((m) => candidateKeys.has(memberKey(m))).map(memberKey));

  let requiredAllFeasible = false;
  let best: Array<{ ids: string[]; total: number; diff: number }> = [];

  for (let mask = 0; mask < 1 << n; mask++) {
    const chosen: SolverJob[] = [];
    let requiredOk = true;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        if (jobs[i].status === 'excluded') {
          requiredOk = false;
          break;
        }
        chosen.push(jobs[i]);
      } else if (jobs[i].status === 'required') {
        requiredOk = false;
      }
    }
    if (!requiredOk) continue;

    let feasible = true;
    for (let c = 0; c < coords.length - 1; c++) {
      const lo = coords[c];
      const hi = coords[c + 1];
      let depth = 0;
      for (const job of chosen) {
        if (job.start <= lo && job.end >= hi) depth++;
      }
      if (depth > limitAt(lo)) {
        feasible = false;
        break;
      }
    }
    if (!feasible) continue;

    requiredAllFeasible = true;
    const selectedKeys = new Set(chosen.map(memberKey));
    let removed = 0;
    for (const key of refKeys) if (!selectedKeys.has(key)) removed++;
    let added = 0;
    for (const job of chosen) if (!refKeys.has(memberKey(job))) added++;

    const ids = chosen.map((j) => j.id);
    const total = chosen.reduce((s, j) => s + j.benefit, 0);
    const candidate = { ids, total, diff: removed + added };
    if (best.length === 0) {
      best = [candidate];
    } else if (total > best[0].total) {
      best = [candidate]; // 更高收益：整族替换
    } else if (total === best[0].total && candidate.diff === best[0].diff) {
      best.push(candidate); // 收益、差异都相同：并入最优族
    }
    // 同收益但 diff 更大的候选直接丢弃（注意不能在此重置 best）
  }

  return { best, feasible: requiredAllFeasible };
}

function makeJobs(
  raw: [string, number, number, number][],
  statuses: Record<string, JobStatus> = {},
): SolverJob[] {
  return raw.map(([id, start, end, benefit]) => ({
    id,
    start,
    end,
    benefit,
    status: statuses[id] ?? 'normal',
  }));
}

function plan(version: number, members: Array<[string, number, number]>): ReferencePlan {
  return {
    workspaceDataId: 'ws-test',
    workspaceVersion: version,
    adoptedAt: '2026-09-23T08:00:00.000Z',
    members: members.map(([id, start, end]) => ({ id, start, end })),
  };
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('参考方案 tiebreak：两级目标的小规模穷举核对', () => {
  it('无参考时：传参考但无成员命中，结果与旧调用逐项一致', () => {
    const jobs = makeJobs([
      ['a', 0, 10, 5],
      ['b', 0, 10, 7],
    ]);
    const without = solve(jobs, 1);
    const emptyRef = solve(jobs, 1, [], []);
    const noHit = solve(jobs, 1, [], [{ id: 'ghost', start: 0, end: 10 }]);
    expect(emptyRef).toEqual(without);
    expect(noHit).toEqual(without);
    expect(without.selectedIds).toEqual(['b']);
  });

  it('同收益二选一时：参考成员被保留而不是换成另一个最优解', () => {
    // a、b 完全重叠且同分 5，capacity=1：无参考时 SSP 确定性裁决
    const jobs = makeJobs([
      ['a', 0, 10, 5],
      ['b', 0, 10, 5],
    ]);
    const baseline = solve(jobs, 1);
    const baselineId = baseline.selectedIds[0];

    // 采纳“另一个”作业为参考：新最优解必须翻向参考成员
    const otherId = baselineId === 'a' ? 'b' : 'a';
    const r = solve(jobs, 1, [], [{ id: otherId, start: 0, end: 10 }]);
    expect(r.totalBenefit).toBe(5); // 收益严格不变
    expect(r.selectedIds).toEqual([otherId]); // 差异最小 => 保留参考
  });

  it('收益差 1 也压过参考偏好：严格最大化总收益优先于少改动', () => {
    // 参考保留 a(5)，但 b(6) 严格更优：必须选 b（差异 2 > 0 也在所不惜）
    const jobs = makeJobs([
      ['a', 0, 10, 5],
      ['b', 0, 10, 6],
    ]);
    const r = solve(jobs, 1, [], [{ id: 'a', start: 0, end: 10 }]);
    expect(r.totalBenefit).toBe(6);
    expect(r.selectedIds).toEqual(['b']);
  });

  it('日历压容后参考成员不可同时保留：在最优收益方案间最小化撤下', () => {
    // capacity=2，三项完全重叠，[0,10) available=1 => 最多选 1 项
    const jobs = makeJobs([
      ['a', 0, 10, 5],
      ['b', 0, 10, 5],
      ['c', 0, 10, 5],
    ]);
    const calendar: CapacityCalendarSegment[] = [{ start: 0, end: 10, available: 1 }];
    // 参考排程（日历变化前 capacity=2 时的通知版本）：a + b
    const reference: ReferenceMember[] = [
      { id: 'a', start: 0, end: 10 },
      { id: 'b', start: 0, end: 10 },
    ];
    const r = solve(jobs, 2, calendar, reference);
    expect(r.totalBenefit).toBe(5);
    // 只能保一个：保留 a/b 之一（差异：撤下 1），绝不会引入 c（撤下 2 + 新增 1）
    expect(['a', 'b']).toContain(r.selectedIds[0]);
    expect(r.selectedIds).not.toContain('c');
  });

  it('日历恢复容量后：可在不牺牲收益时把参考成员都加回来', () => {
    // capacity=2，三项重叠且同分：参考 a+b；无日历时最优收益下正好可保留二者
    const jobs = makeJobs([
      ['a', 0, 10, 5],
      ['b', 0, 10, 5],
      ['c', 0, 10, 5],
    ]);
    const reference: ReferenceMember[] = [
      { id: 'a', start: 0, end: 10 },
      { id: 'b', start: 0, end: 10 },
    ];
    const r = solve(jobs, 2, [], reference);
    expect(r.totalBenefit).toBe(10);
    expect(r.selectedIds.sort()).toEqual(['a', 'b']);
  });

  it('必选约束优先：必选作业即使不是参考成员也必须入选', () => {
    // capacity=1，a、b 重叠同分；参考是 a，但 b 被设为必选
    const jobs = makeJobs(
      [
        ['a', 0, 10, 5],
        ['b', 0, 10, 5],
      ],
      { b: 'required' },
    );
    const r = solve(jobs, 1, [], [{ id: 'a', start: 0, end: 10 }]);
    expect(r.selectedIds).toEqual(['b']);
    expect(r.totalBenefit).toBe(5);
  });

  it('必选 + 参考同时是必选：费用编码下仍严格可行且最优', () => {
    const jobs = makeJobs(
      [
        ['r', 0, 10, 1],
        ['a', 0, 10, 100],
        ['b', 10, 20, 100],
      ],
      { r: 'required' },
    );
    const r = solve(jobs, 1, [], [{ id: 'r', start: 0, end: 10 }]);
    expect(r.selectedIds).toContain('r');
    expect(r.totalBenefit).toBe(101);
  });

  it('必选集合不可行仍抛 InfeasibleRequiredError（参考不能使其“变可行”）', () => {
    const jobs = makeJobs(
      [
        ['r1', 0, 10, 1],
        ['r2', 0, 10, 1],
      ],
      { r1: 'required', r2: 'required' },
    );
    expect(() =>
      solve(jobs, 1, [], [{ id: 'r1', start: 0, end: 10 }]),
    ).toThrow(InfeasibleRequiredError);
  });

  it('排除的参考成员无法保留：计入不可避免差异，同收益选择仍偏向其余参考成员', () => {
    // capacity=1：a、c 在同一时段重叠且同分；参考包含 a 与 b（b 位于另一时段）。
    // 把 b 排除 => b 的撤下不可避免；a 与 c 同收益时选 a（保留参考），
    // 若选 c 则差异再多 2（撤下 a + 新增 c）。
    const jobs = makeJobs(
      [
        ['a', 10, 20, 5],
        ['b', 0, 10, 7],
        ['c', 10, 20, 5],
      ],
      { b: 'excluded' },
    );
    const reference: ReferenceMember[] = [
      { id: 'a', start: 10, end: 20 },
      { id: 'b', start: 0, end: 10 },
    ];
    const r = solve(jobs, 1, [], reference);
    expect(r.totalBenefit).toBe(5);
    expect(r.selectedIds).toEqual(['a']);
  });

  it('已删除参考成员不参与差异计数：求解器不受其影响', () => {
    const jobs = makeJobs([
      ['a', 0, 10, 5],
      ['b', 0, 10, 5],
    ]);
    // ghost 在工作区中不存在：调用方只传活动成员；即使误传入也不命中候选
    const r1 = solve(jobs, 1, [], [{ id: 'ghost', start: 0, end: 10 }]);
    expect(r1).toEqual(solve(jobs, 1));
    const r2 = solve(jobs, 1, [], [
      { id: 'ghost', start: 0, end: 10 },
      { id: 'a', start: 0, end: 10 },
    ]);
    expect(r2.selectedIds).toEqual(['a']);
  });

  it('改期语义：同 id 不同时刻 = 撤下旧成员 + 加入新成员（按差异最小选择）', () => {
    // 工作区里 a=[0,10) 与 a2=[10,20) 是不同作业；参考成员 a[0,10)
    // 保留 a：差异 0；换 b（同分同时段）：撤下 a + 新增 b = 2
    const jobs = makeJobs([
      ['a', 0, 10, 5],
      ['b', 0, 10, 5],
      ['c', 10, 20, 7],
    ]);
    const r = solve(jobs, 1, [], [{ id: 'a', start: 0, end: 10 }]);
    expect(r.totalBenefit).toBe(12);
    expect(r.selectedIds.sort()).toEqual(['a', 'c']);
  });

  it('随机小规模穷举：每个用例都在（收益最大、差异最小）最优集合族中', () => {
    const rand = mulberry32(20260924);
    let checked = 0;
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + Math.floor(rand() * 10); // 1..10
      const cap = 1 + Math.floor(rand() * 3);
      const maxT = 10;
      const raw: [string, number, number, number][] = [];
      for (let i = 0; i < n; i++) {
        const s = Math.floor(rand() * maxT);
        const len = 1 + Math.floor(rand() * 4);
        const e = Math.min(maxT + 1, s + len);
        if (e <= s) {
          i--;
          continue;
        }
        raw.push([`j${i}`, s, e, 1 + Math.floor(rand() * 9)]);
      }
      const statuses: Record<string, JobStatus> = {};
      for (const [id] of raw) {
        const roll = rand();
        if (roll < 0.1) statuses[id] = 'required';
        else if (roll < 0.2) statuses[id] = 'excluded';
      }
      const jobs = makeJobs(raw, statuses);

      // 日历：一半用例随机放一个压容片段
      const calendar: CapacityCalendarSegment[] = [];
      if (rand() < 0.5 && raw.length > 0) {
        const minStart = Math.min(...raw.map((x) => x[1]));
        const maxEnd = Math.max(...raw.map((x) => x[2]));
        const span = maxEnd - minStart;
        const segStart = minStart + Math.floor(rand() * span);
        const segEnd = Math.min(maxEnd, segStart + 1 + Math.floor(rand() * Math.max(1, span - 1)));
        if (segEnd > segStart) {
          calendar.push({ start: segStart, end: segEnd, available: Math.floor(rand() * cap) });
        }
      }

      // 参考：从该实例“可能的成员空间”随机挑 0..3 个，包含部分已删除
      // （id 取 j<n+2，可能有 j{n},j{n+1} 这种幽灵编号）
      const reference: ReferenceMember[] = [];
      const refCount = Math.floor(rand() * 4);
      for (let k = 0; k < refCount; k++) {
        const idx = Math.floor(rand() * (n + 2));
        const s = Math.floor(rand() * maxT);
        const len = 1 + Math.floor(rand() * 4);
        const e = Math.min(maxT + 1, s + len);
        if (e > s) reference.push({ id: `j${idx}`, start: s, end: e });
      }

      const { best, feasible } = bruteForceLexicographic(jobs, cap, calendar, reference);
      if (!feasible) {
        expect(() => solve(jobs, cap, calendar, reference)).toThrow(InfeasibleRequiredError);
        continue;
      }
      checked++;
      const r = solve(jobs, cap, calendar, reference);
      // 一级目标：总收益必须等于穷举最大值
      expect(r.totalBenefit).toBe(best[0].total);
      // 二级目标：结果集合必须落在（收益最大且差异最小）的最优集合族中
      const selected = [...r.selectedIds].sort().join(',');
      const inFamily = best.some(
        (candidate) => [...candidate.ids].sort().join(',') === selected,
      );
      if (!inFamily) {
        throw new Error(
          `trial=${trial} 结果 ${selected} 不在最优族 ${JSON.stringify(best)} 中`,
        );
      }
      // 必选/排除合规
      for (const job of jobs) {
        if (job.status === 'required') expect(r.selectedIds).toContain(job.id);
        if (job.status === 'excluded') expect(r.selectedIds).not.toContain(job.id);
      }
    }
    expect(checked).toBeGreaterThan(200); // 绝大多数随机实例必须可行
  });

  it('确定性：相同输入（含参考）重复求解严格一致', () => {
    const rand = mulberry32(11);
    const raw: [string, number, number, number][] = [];
    for (let i = 0; i < 30; i++) {
      const s = Math.floor(rand() * 60);
      raw.push([`j${i}`, s, s + 1 + Math.floor(rand() * 12), 1 + Math.floor(rand() * 5)]);
    }
    const jobs = makeJobs(raw);
    const reference: ReferenceMember[] = [
      { id: 'j1', start: jobs[1].start, end: jobs[1].end },
      { id: 'j7', start: jobs[7].start, end: jobs[7].end },
      { id: 'j20', start: jobs[20].start, end: jobs[20].end },
    ];
    const r1 = solve(jobs, 3, [], reference);
    const r2 = solve(jobs, 3, [], reference);
    expect(r2).toEqual(r1);
  });

  it('5 万作业带参考仍在 3 秒内完成且收益与无参考相同（一级目标无损）', () => {
    const rand = mulberry32(1234);
    const jobs: SolverJob[] = [];
    const cap = 4;
    for (let i = 0; i < 50_000; i++) {
      const s = Math.floor(rand() * 1_000_000_000);
      const len = 1 + Math.floor(rand() * 1_000_000);
      jobs.push({
        id: `job-${i}`,
        start: s,
        end: Math.min(1_000_000_000, s + len),
        benefit: 1 + Math.floor(rand() * 1_000_000_000),
        status: 'normal',
      });
    }
    const baseline = solve(jobs, cap);
    const reference: ReferenceMember[] = [
      { id: 'job-1', start: jobs[1].start, end: jobs[1].end },
      { id: 'job-100', start: jobs[100].start, end: jobs[100].end },
      { id: 'deleted-one', start: 0, end: 10 },
    ];
    const started = performance.now();
    const r = solve(jobs, cap, [], reference);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(3000);
    expect(r.totalBenefit).toBe(baseline.totalBenefit); // 收益严格不降级
    expect(r.peakOccupancy).toBeLessThanOrEqual(cap);
  });
});

describe('参考方案：成员规范化、改期与删除的差异计算', () => {
  const jobs: Job[] = [
    { id: 'a', start: 0, end: 10, benefit: 5, status: 'normal' },
    { id: 'b', start: 10, end: 20, benefit: 6, status: 'normal' },
    // 注意：真实工作区 id 唯一，这里仅用于差异函数的“当前时刻”演示
  ];

  it('成员键由 id+start+end 共同决定', () => {
    expect(memberKey({ id: 'a', start: 0, end: 10 })).toBe('a#0#10');
    expect(memberKey({ id: 'a', start: 0, end: 11 })).not.toBe(memberKey({ id: 'a', start: 0, end: 10 }));
  });

  it('规范化：去重、排序、拒绝畸形项', () => {
    const ok = normalizeReferenceMembers([
      { id: 'b', start: 10, end: 20 },
      { id: 'a', start: 0, end: 10 },
      { id: 'a', start: 0, end: 10 }, // 重复
    ]);
    expect(ok!.map((m) => m.id)).toEqual(['a', 'b']);
    expect(normalizeReferenceMembers([{ id: '', start: 0, end: 10 }])).toBeNull();
    expect(normalizeReferenceMembers([{ id: 'a', start: 1.5, end: 10 }])).toBeNull();
    expect(normalizeReferenceMembers([{ id: 'a', start: 10, end: 10 }])).toBeNull();
    expect(normalizeReferenceMembers('x')).toBeNull();
    expect(normalizeReferenceMembers([])).toEqual([]);
  });

  it('splitReferenceMembers：同 id 存在为活动，否则为删除', () => {
    const members: ReferenceMember[] = [
      { id: 'a', start: 0, end: 10 },
      { id: 'gone', start: 0, end: 10 },
    ];
    const { active, deleted } = splitReferenceMembers(members, jobs);
    expect(active.map((m) => m.id)).toEqual(['a']);
    expect(deleted.map((m) => m.id)).toEqual(['gone']);
  });

  it('computeReferenceDiff：保留/撤下/新增 + 删除成员透明列出且不计差异', () => {
    const reference = plan(1, [
      ['a', 0, 10],
      ['b', 10, 20], // b 将被撤下
      ['gone', 0, 5], // 已删除：不计数
    ]);
    // 当前入选 a + c（c 是新增）；b 撤下
    const diff = computeReferenceDiff(['a', 'c'], [
      ...jobs,
      { id: 'c', start: 20, end: 30, benefit: 9, status: 'normal' },
    ], reference);
    expect(diff.retained.map((m) => m.id)).toEqual(['a']);
    expect(diff.removed.map((m) => m.id)).toEqual(['b']);
    expect(diff.added.map((m) => m.id)).toEqual(['c']);
    expect(diff.deletedReference.map((m) => m.id)).toEqual(['gone']);
    expect(diff.diffCount).toBe(2);
  });

  it('改期：旧时刻成员撤下、新时刻成员新增（即便 id 相同）', () => {
    // 参考是 a[0,10)；当前工作区 a 变成 [5,15)，求解选择了当前的 a
    const moved: Job[] = [{ id: 'a', start: 5, end: 15, benefit: 5, status: 'normal' }];
    const reference = plan(1, [['a', 0, 10]]);
    const diff = computeReferenceDiff(['a'], moved, reference);
    expect(diff.retained).toEqual([]);
    expect(diff.removed).toEqual([
      { id: 'a', start: 0, end: 10, currentStart: 5, currentEnd: 15 },
    ]);
    expect(diff.added).toEqual([
      { id: 'a', start: 5, end: 15, currentStart: 5, currentEnd: 15 },
    ]);
    expect(diff.diffCount).toBe(2);
  });

  it('referenceMembersFromSelection：从入选结果构造成员（含去重）', () => {
    const members = referenceMembersFromSelection(['b', 'a'], jobs);
    // 规范顺序按 start 排序
    expect(members.map((m) => m.id)).toEqual(['a', 'b']);
  });
});
