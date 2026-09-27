import { describe, expect, it } from 'vitest';
import { solve, InfeasibleRequiredError, type SolverJob } from '../src/core/solver';
import type { CapacityCalendarSegment, JobStatus } from '../src/core/types';

/**
 * 带容量日历的穷举参考解：枚举所有 2^n 子集，在「作业端点 + 日历端点」
 * 形成的每个时间格上逐一核对入选数 <= 该格有效容量，取最大收益。
 * 仅用于小规模测试（n <= 14）。
 */
function bruteForceWithCalendar(
  jobs: SolverJob[],
  capacity: number,
  calendar: CapacityCalendarSegment[],
): { total: number; peak: number; peakCellLimit: number; ids: string[] } | null {
  const n = jobs.length;
  let best: { total: number; peak: number; peakCellLimit: number; ids: string[] } | null = null;

  // 统一时间格：作业端点 + 日历端点
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
    // 小格 [lo, hi) 的有效容量：片段端点已与 coords 对齐，用左端点定位
    for (const seg of calendar) {
      if (seg.start <= lo && lo < seg.end) return seg.available;
    }
    return capacity;
  };

  for (let mask = 0; mask < 1 << n; mask++) {
    const chosen: SolverJob[] = [];
    let ok = true;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        if (jobs[i].status === 'excluded') ok = false;
        chosen.push(jobs[i]);
      } else if (jobs[i].status === 'required') {
        ok = false;
      }
    }
    if (!ok) continue;

    let peak = 0;
    let peakCellLimit = capacity;
    for (let c = 0; c < coords.length - 1; c++) {
      const lo = coords[c];
      const hi = coords[c + 1];
      const limit = limitAt(lo);
      let depth = 0;
      for (const job of chosen) {
        if (job.start <= lo && job.end >= hi) depth++;
      }
      if (depth > limit) {
        ok = false;
        break;
      }
      if (depth > peak) {
        peak = depth;
        peakCellLimit = limit;
      }
    }
    if (!ok) continue;

    const total = chosen.reduce((s, j) => s + j.benefit, 0);
    if (best === null || total > best.total) {
      best = { total, peak, peakCellLimit, ids: chosen.map((j) => j.id) };
    }
  }
  return best;
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

// 简单确定性伪随机
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

describe('solver + 容量日历：固定锁定用例', () => {
  it('capacity=2、[0,10) available=1：两项 [0,10) 作业最多入选一项', () => {
    const jobs = makeJobs([
      ['a', 0, 10, 5],
      ['b', 0, 10, 7],
    ]);
    const calendar: CapacityCalendarSegment[] = [{ start: 0, end: 10, available: 1 }];
    const r = solve(jobs, 2, calendar);
    // 全局 capacity=2，但 [0,10) 被日历压到 1 => 只能选收益高的 b
    expect(r.selectedIds).toEqual(['b']);
    expect(r.totalBenefit).toBe(7);
    expect(r.peakOccupancy).toBe(1);
    // 最早峰值格就是被压容的格，上限为 1
    expect(r.peakCellLimit).toBe(1);
  });

  it('capacity=2、[0,10) available=1：两项 [10,20) 作业可同时入选', () => {
    const jobs = makeJobs([
      ['c', 10, 20, 5],
      ['d', 10, 20, 7],
    ]);
    const calendar: CapacityCalendarSegment[] = [{ start: 0, end: 10, available: 1 }];
    const r = solve(jobs, 2, calendar);
    // 日历只压 [0,10)；作业全在 [10,20)，不受影响，容量恢复为 2
    expect(r.selectedIds.sort()).toEqual(['c', 'd']);
    expect(r.totalBenefit).toBe(12);
    expect(r.peakOccupancy).toBe(2);
    // 峰值发生在未被日历覆盖的格，上限是全局 capacity=2
    expect(r.peakCellLimit).toBe(2);
  });

  it('同一用例中：受限时段限一项、其后恢复容量两项并行', () => {
    const jobs = makeJobs([
      ['a', 0, 10, 5],
      ['b', 0, 10, 7],
      ['c', 10, 20, 5],
      ['d', 10, 20, 7],
    ]);
    const calendar: CapacityCalendarSegment[] = [{ start: 0, end: 10, available: 1 }];
    const r = solve(jobs, 2, calendar);
    expect(r.selectedIds.sort()).toEqual(['b', 'c', 'd']);
    expect(r.totalBenefit).toBe(19);
    // 峰值 2 出现在 [10,20)；该格上限为 2
    expect(r.peakOccupancy).toBe(2);
    expect(r.peakCellLimit).toBe(2);
  });

  it('available=0 的时段禁止任何作业跨越，段外作业照常入选', () => {
    const jobs = makeJobs([
      // a 跨越封闭时段，无论收益多高都不可选
      ['a', 0, 20, 1000],
      // b、c 也都搭到了封闭段的边，同样不可选
      ['b', 0, 10, 9],
      ['c', 10, 20, 8],
      // 完全位于封闭段之前/之后的作业不受影响
      ['e', 0, 5, 9],
      ['f', 15, 20, 8],
    ]);
    const calendar: CapacityCalendarSegment[] = [{ start: 5, end: 15, available: 0 }];
    const r = solve(jobs, 2, calendar);
    expect(r.selectedIds.sort()).toEqual(['e', 'f']);
    expect(r.totalBenefit).toBe(17);
    // e=[0,5)、f=[15,20) 互不重叠，峰值 1；两段都在日历外，上限为 2
    expect(r.peakOccupancy).toBe(1);
    expect(r.peakCellLimit).toBe(2);
  });

  it('available=0 时段：与其相接（端点相等）的作业仍可入选', () => {
    // 左闭右开：作业在 5 结束 / 15 开始，与封闭段 [5,15) 相接不算跨越
    const jobs = makeJobs([
      ['before', 0, 5, 9],
      ['after', 15, 20, 8],
    ]);
    const calendar: CapacityCalendarSegment[] = [{ start: 5, end: 15, available: 0 }];
    const r = solve(jobs, 2, calendar);
    expect(r.selectedIds.sort()).toEqual(['after', 'before']);
    expect(r.totalBenefit).toBe(17);
  });

  it('内部日历端点：片段端点落在作业内部时按更小时间格精确限容', () => {
    // 作业 a=[0,20)；日历在内部点 10 处分段：[0,10) 容量 1，[10,20) 容量 1
    const jobs = makeJobs([
      ['a', 0, 20, 5],
      ['b', 0, 10, 9],
      ['c', 10, 20, 9],
    ]);
    const calendar: CapacityCalendarSegment[] = [{ start: 0, end: 10, available: 1 }];
    const r = solve(jobs, 2, calendar);
    // [0,10) 限 1：a 或 b；若选 a 则 [10,20) 也占 1，c 与 a 在 [10,20) 可并行(容量2)
    // 方案 a+c = 14（[0,10): 只有 a=1 ✓；[10,20): a,c=2 ✓）
    // 方案 b+c = 18（两段各 1）=> 更优
    expect(r.totalBenefit).toBe(18);
    expect(r.selectedIds.sort()).toEqual(['b', 'c']);
  });

  it('多段日历相接：各段独立生效，相接不算重叠', () => {
    const jobs = makeJobs([
      ['a', 0, 10, 5],
      ['b', 0, 10, 6],
      ['c', 10, 20, 5],
      ['d', 10, 20, 6],
    ]);
    const calendar: CapacityCalendarSegment[] = [
      { start: 0, end: 10, available: 1 },
      { start: 10, end: 20, available: 1 },
    ];
    const r = solve(jobs, 2, calendar);
    expect(r.totalBenefit).toBe(12);
    expect(r.selectedIds.sort()).toEqual(['b', 'd']);
    expect(r.peakOccupancy).toBe(1);
    expect(r.peakCellLimit).toBe(1);
  });
});

describe('solver + 容量日历：必选失败隔离', () => {
  it('日历压容导致必选不可行时抛出 InfeasibleRequiredError（普通作业仍可排）', () => {
    const jobs = makeJobs(
      [
        ['r1', 0, 10, 1],
        ['r2', 0, 10, 1],
        ['n', 10, 20, 100],
      ],
      { r1: 'required', r2: 'required' },
    );
    // capacity=2 下两个必选本可并行，但 [0,10) 被压到 1 => 不可行
    const calendar: CapacityCalendarSegment[] = [{ start: 0, end: 10, available: 1 }];
    expect(() => solve(jobs, 2, calendar)).toThrow(InfeasibleRequiredError);
  });

  it('必选只在受限时段超限：可在不受限时段并行', () => {
    const jobs = makeJobs(
      [
        ['r1', 10, 20, 1],
        ['r2', 10, 20, 1],
      ],
      { r1: 'required', r2: 'required' },
    );
    // 限制在 [0,10)，必选全在其后，容量 2，可同时入选
    const calendar: CapacityCalendarSegment[] = [{ start: 0, end: 10, available: 1 }];
    const r = solve(jobs, 2, calendar);
    expect(r.selectedIds.sort()).toEqual(['r1', 'r2']);
  });

  it('必选跨越 available=0 的格不可行', () => {
    const jobs = makeJobs([['r', 0, 20, 1]], { r: 'required' });
    const calendar: CapacityCalendarSegment[] = [{ start: 5, end: 15, available: 0 }];
    expect(() => solve(jobs, 2, calendar)).toThrow(InfeasibleRequiredError);
  });

  it('无日历时默认参数与旧行为一致（同输入同结果）', () => {
    const jobs = makeJobs([
      ['a', 0, 10, 5],
      ['b', 0, 10, 6],
      ['c', 0, 10, 7],
    ]);
    const r1 = solve(jobs, 2);
    const r2 = solve(jobs, 2, []);
    expect(r2).toEqual(r1);
    expect(r2.totalBenefit).toBe(13);
    expect(r2.peakCellLimit).toBe(2);
  });
});

describe('solver + 容量日历：小规模独立穷举逐格核对', () => {
  it('随机用例（容量 1..3、随机日历片段、必选/排除）与 2^n 穷举一致', () => {
    const rand = mulberry32(20260922);
    let calendarTrials = 0;
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + Math.floor(rand() * 10); // 1..10
      const cap = 1 + Math.floor(rand() * 3);
      const maxT = 12;
      const raw: [string, number, number, number][] = [];
      for (let i = 0; i < n; i++) {
        const s = Math.floor(rand() * maxT);
        const len = 1 + Math.floor(rand() * 4);
        const e = Math.min(maxT + 1, s + len);
        if (e <= s) {
          i--;
          continue;
        }
        raw.push([`j${i}`, s, e, 1 + Math.floor(rand() * 20)]);
      }
      const statuses: Record<string, JobStatus> = {};
      for (const [id] of raw) {
        const roll = rand();
        if (roll < 0.12) statuses[id] = 'required';
        else if (roll < 0.24) statuses[id] = 'excluded';
      }
      const jobs = makeJobs(raw, statuses);

      // 在作业范围内生成 0..3 段互不重叠的日历（available 0..cap-1）
      const minStart = Math.min(...raw.map((j) => j[1]));
      const maxEnd = Math.max(...raw.map((j) => j[2]));
      const calendar: CapacityCalendarSegment[] = [];
      const segCount = Math.floor(rand() * 4);
      let cursor = minStart;
      for (let s = 0; s < segCount; s++) {
        const remaining = maxEnd - cursor;
        if (remaining <= 1) break;
        const start = cursor + Math.floor(rand() * (remaining - 1));
        const maxLen = maxEnd - start;
        const end = start + 1 + Math.floor(rand() * Math.min(3, maxLen - 1));
        if (end > maxEnd || start >= end) continue;
        calendar.push({
          start,
          end,
          available: Math.min(cap - 1, Math.floor(rand() * cap)),
        });
        cursor = end; // 保证互不重叠（允许相接）
      }
      if (calendar.length > 0) calendarTrials++;

      const expected = bruteForceWithCalendar(jobs, cap, calendar);
      if (expected === null) {
        // 仅当必选在逐格容量下不可行时才无解
        expect(() => solve(jobs, cap, calendar)).toThrow(InfeasibleRequiredError);
      } else {
        const r = solve(jobs, cap, calendar);
        expect(r.totalBenefit).toBe(expected.total);
        expect(r.peakOccupancy).toBe(expected.peak);
        expect(r.peakCellLimit).toBe(expected.peakCellLimit);
        expect(r.selectedIds).toHaveLength(r.selectedCount);
        // 逐格再独立核对一遍入选数 <= 有效容量（内部日历端点同样覆盖）
        const byId = new Map(jobs.map((j) => [j.id, j]));
        const chosen = r.selectedIds.map((id) => byId.get(id)!);
        const coordSet = new Set<number>();
        chosen.forEach((j) => {
          coordSet.add(j.start);
          coordSet.add(j.end);
        });
        calendar.forEach((seg) => {
          coordSet.add(seg.start);
          coordSet.add(seg.end);
        });
        const coords = [...coordSet].sort((a, b) => a - b);
        for (let c = 0; c < coords.length - 1; c++) {
          const lo = coords[c];
          const hi = coords[c + 1];
          let limit = cap;
          for (const seg of calendar) {
            if (seg.start <= lo && lo < seg.end) limit = seg.available;
          }
          const depth = chosen.filter((j) => j.start <= lo && j.end >= hi).length;
          expect(depth).toBeLessThanOrEqual(limit);
        }
        // 必选/排除合规
        for (const j of jobs) {
          if (j.status === 'required') expect(r.selectedIds).toContain(j.id);
          if (j.status === 'excluded') expect(r.selectedIds).not.toContain(j.id);
        }
      }
    }
    // 确保大部分试验确实带日历，否则本套件失去意义
    expect(calendarTrials).toBeGreaterThan(150);
  });
});

describe('solver + 容量日历：5 万作业性能量级', () => {
  it('带日历的 5 万作业仍在 3 秒内完成且逐格合法', () => {
    const rand = mulberry32(2026092201);
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
    // 三段调峰：一段降到 2、一段降到 1、一段封闭
    const calendar: CapacityCalendarSegment[] = [
      { start: 100_000_000, end: 200_000_000, available: 2 },
      { start: 250_000_000, end: 350_000_000, available: 1 },
      { start: 400_000_000, end: 410_000_000, available: 0 },
    ];
    const started = performance.now();
    const r = solve(jobs, cap, calendar);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(3000);
    expect(r.totalBenefit).toBeGreaterThan(0);
    expect(r.selectedIds).toHaveLength(r.selectedCount);

    // 逐格核对：在日历段内入选重叠数不得超过 available
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const chosen = r.selectedIds.map((id) => byId.get(id)!);
    for (const seg of calendar) {
      // 用差分统计该片段内部的峰值（片段内部无日历端点，深度恒定只需查一点；
      // 但作业可能在片段内部起止，因此仍需扫描作业端点）
      const pts = new Set<number>([seg.start, seg.end]);
      for (const j of chosen) {
        if (j.end > seg.start && j.start < seg.end) {
          pts.add(Math.max(j.start, seg.start));
          pts.add(Math.min(j.end, seg.end));
        }
      }
      const xs = [...pts].sort((a, b) => a - b);
      for (let i = 0; i < xs.length - 1; i++) {
        const lo = xs[i];
        const hi = xs[i + 1];
        const depth = chosen.filter((j) => j.start <= lo && j.end >= hi).length;
        expect(depth).toBeLessThanOrEqual(seg.available);
      }
    }

    // 重新加总核对
    const sum = r.selectedIds.reduce((s, id) => s + byId.get(id)!.benefit, 0);
    expect(sum).toBe(r.totalBenefit);
  });
});
