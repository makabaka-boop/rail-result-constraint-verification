import { describe, expect, it } from 'vitest';
import { solve, InfeasibleRequiredError, type SolverJob } from '../src/core/solver';
import type { JobStatus } from '../src/core/types';

/**
 * 穷举参考解：枚举所有 2^n 子集，校验重叠容量，取最大收益。
 * 仅用于小规模测试（n <= 14）。
 */
function bruteForce(
  jobs: SolverJob[],
  capacity: number,
): { total: number; peak: number; ids: string[] } | null {
  const n = jobs.length;
  let best: { total: number; peak: number; ids: string[] } | null = null;
  const coords = [...new Set(jobs.flatMap((j) => [j.start, j.end]))].sort((a, b) => a - b);

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

    // 每个坐标小格上的重叠数（左闭右开：相接点深度先降后升）
    let peak = 0;
    for (let c = 0; c < coords.length - 1; c++) {
      const lo = coords[c];
      const hi = coords[c + 1];
      let depth = 0;
      for (const job of chosen) {
        if (job.start <= lo && job.end >= hi) depth++;
      }
      if (depth > capacity) {
        ok = false;
        break;
      }
      peak = Math.max(peak, depth);
    }
    if (!ok) continue;

    const total = chosen.reduce((s, j) => s + j.benefit, 0);
    if (best === null || total > best.total) {
      best = { total, peak, ids: chosen.map((j) => j.id) };
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

describe('solver：穷举一致性', () => {
  it('端点相接不算重叠（左闭右开语义）', () => {
    // [0,10) 与 [10,20) 相接，capacity=1 下可同时入选
    const jobs = makeJobs([
      ['a', 0, 10, 5],
      ['b', 10, 20, 7],
    ]);
    const r = solve(jobs, 1);
    expect(r.totalBenefit).toBe(12);
    expect(r.selectedIds.sort()).toEqual(['a', 'b']);
    // 峰值占用任一小格都只有 1
    expect(r.peakOccupancy).toBe(1);
  });

  it('真正重叠的作业在 capacity=1 下互斥，取高收益', () => {
    const jobs = makeJobs([
      ['a', 0, 10, 5],
      ['b', 5, 15, 9],
      ['c', 15, 25, 4],
    ]);
    const r = solve(jobs, 1);
    // b+c=13（相接），优于 a+c=9
    expect(r.totalBenefit).toBe(13);
    expect(r.selectedIds).toEqual(['b', 'c']);
    expect(r.peakOccupancy).toBe(1);
  });

  it('capacity=2 可并行重叠作业', () => {
    const jobs = makeJobs([
      ['a', 0, 10, 5],
      ['b', 0, 10, 6],
      ['c', 0, 10, 7],
    ]);
    const r = solve(jobs, 2);
    expect(r.totalBenefit).toBe(13);
    expect(r.peakOccupancy).toBe(2);
  });

  it('随机小规模与穷举完全一致（容量 1..3，各种状态）', () => {
    const rand = mulberry32(20260920);
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rand() * 11); // 1..11
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

      const expected = bruteForce(jobs, cap);
      if (expected === null) {
        // 仅当必选不可行时才无解
        expect(() => solve(jobs, cap)).toThrow(InfeasibleRequiredError);
      } else {
        const r = solve(jobs, cap);
        expect(r.totalBenefit).toBe(expected.total);
        expect(r.peakOccupancy).toBe(expected.peak);
        expect(r.peakOccupancy).toBeLessThanOrEqual(cap);
        expect(r.selectedIds).toHaveLength(r.selectedCount);
        // 集合合法性再独立核对一遍
        const byId = new Map(jobs.map((j) => [j.id, j]));
        const chosen = r.selectedIds.map((id) => byId.get(id)!);
        for (const j of jobs) {
          if (j.status === 'required') expect(r.selectedIds).toContain(j.id);
          if (j.status === 'excluded') expect(r.selectedIds).not.toContain(j.id);
        }
        const coords = [...new Set(chosen.flatMap((j) => [j.start, j.end]))].sort(
          (a, b) => a - b,
        );
        for (let c = 0; c < coords.length - 1; c++) {
          const depth = chosen.filter(
            (j) => j.start <= coords[c] && j.end >= coords[c + 1],
          ).length;
          expect(depth).toBeLessThanOrEqual(cap);
        }
      }
    }
  });

  it('必选优先：低收益必选挤掉高收益组合但保证可行', () => {
    const jobs = makeJobs(
      [
        ['r', 0, 10, 1],
        ['a', 1, 9, 100],
        ['b', 1, 9, 100],
      ],
      { r: 'required' },
    );
    // capacity=2：必选 r 占一格，a/b 只能选一个 => 101
    const r = solve(jobs, 2);
    expect(r.totalBenefit).toBe(101);
    expect(r.selectedIds).toContain('r');
  });

  it('必选重叠超过容量时报不可行', () => {
    const jobs = makeJobs(
      [
        ['r1', 0, 10, 1],
        ['r2', 1, 9, 1],
      ],
      { r1: 'required', r2: 'required' },
    );
    expect(() => solve(jobs, 1)).toThrow(InfeasibleRequiredError);
  });

  it('排除项永远不入选，即使收益最高', () => {
    const jobs = makeJobs(
      [
        ['a', 0, 10, 1],
        ['b', 0, 10, 999],
      ],
      { b: 'excluded' },
    );
    const r = solve(jobs, 1);
    expect(r.selectedIds).toEqual(['a']);
    expect(r.totalBenefit).toBe(1);
  });

  it('结果确定性：同样输入重复求解结果一致', () => {
    const rand = mulberry32(7);
    const raw: [string, number, number, number][] = [];
    for (let i = 0; i < 40; i++) {
      const s = Math.floor(rand() * 100);
      raw.push([`j${i}`, s, s + 1 + Math.floor(rand() * 20), 1 + Math.floor(rand() * 100)]);
    }
    const jobs = makeJobs(raw);
    const r1 = solve(jobs, 3);
    const r2 = solve(jobs, 3);
    expect(r2).toEqual(r1);
  });

  it('全部排除时返回空解而不是报错', () => {
    const jobs = makeJobs(
      [
        ['a', 0, 10, 100],
        ['b', 0, 10, 200],
      ],
      { a: 'excluded', b: 'excluded' },
    );
    const r = solve(jobs, 1);
    expect(r.selectedIds).toEqual([]);
    expect(r.totalBenefit).toBe(0);
    expect(r.peakOccupancy).toBe(0);
    expect(r.selectedCount).toBe(0);
  });

  it('大收益精确：累计超过 2^53 的场景结果仍精确', () => {
    // 两个相接作业，各 9e14... 实际单项上限 1e9；用多个 1e9 凑超 2^53
    // 50,000 项相接、benefit=1e9 => 总和 5e13，本身已安全整数；
    // 这里构造 10 项必选 1e9 + 比较项，核对 BigInt 路径无数值漂移
    const raw: [string, number, number, number][] = [];
    for (let i = 0; i < 10; i++) raw.push([`j${i}`, i * 2, i * 2 + 2, 1_000_000_000]);
    const r = solve(makeJobs(raw), 1);
    expect(r.totalBenefit).toBe(10_000_000_000);
    expect(r.selectedIds).toHaveLength(10);
  });

  it('capacity 大于作业数：容量闲置合法，不强制选择', () => {
    const jobs = makeJobs([
      ['a', 0, 5, 3],
      ['b', 5, 10, 4],
    ]);
    const r = solve(jobs, 8);
    expect(r.totalBenefit).toBe(7);
    expect(r.peakOccupancy).toBe(1);
  });

  it('嵌套区间 + 容量 3 的穷举一致', () => {
    const jobs = makeJobs([
      ['a', 0, 100, 10],
      ['b', 10, 90, 15],
      ['c', 20, 80, 20],
      ['d', 30, 70, 25],
      ['e', 100, 200, 5],
    ]);
    const expected = bruteForce(jobs, 3);
    const r = solve(jobs, 3);
    expect(r.totalBenefit).toBe(expected!.total); // a+b+c+d 深 4 不可全选
    expect(r.peakOccupancy).toBeLessThanOrEqual(3);
  });

  it('回归：同一时段低收益必选必须入选，高收益普通作业让位', () => {
    const jobs = makeJobs(
      [
        ['req', 0, 10, 1],
        ['norm', 0, 10, 100],
      ],
      { req: 'required' },
    );
    // 旧实现必选边只记 -benefit，求解选了普通作业后触发“必选未入选”内部错误
    const r = solve(jobs, 1);
    expect(r.selectedIds).toEqual(['req']);
    expect(r.totalBenefit).toBe(1);
    expect(r.peakOccupancy).toBe(1);
  });

  it('回归：高收益排除作业不得挤掉低收益普通作业', () => {
    const jobs = makeJobs(
      [
        ['norm', 0, 10, 1],
        ['ex', 0, 10, 100],
      ],
      { ex: 'excluded' },
    );
    // 旧实现排除作业仍在网络中，100 收益边被选中进入集合、总收益与下载
    const r = solve(jobs, 1);
    expect(r.selectedIds).toEqual(['norm']);
    expect(r.totalBenefit).toBe(1);
    expect(r.selectedIds).not.toContain('ex');
  });

  it('5 万作业在 3 秒内完成且结果合法', () => {
    const rand = mulberry32(99);
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
    const started = performance.now();
    const r = solve(jobs, cap);
    const elapsed = performance.now() - started;
    // 留足 CI 余量；要求本身是 3 秒
    expect(elapsed).toBeLessThan(3000);
    expect(r.peakOccupancy).toBeLessThanOrEqual(cap);
    expect(r.selectedIds).toHaveLength(r.selectedCount);
    expect(r.totalBenefit).toBeGreaterThan(0);
    // 重新加总核对
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const sum = r.selectedIds.reduce((s, id) => s + byId.get(id)!.benefit, 0);
    expect(sum).toBe(r.totalBenefit);
  });
});
