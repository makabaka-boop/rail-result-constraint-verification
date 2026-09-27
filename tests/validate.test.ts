import { describe, expect, it } from 'vitest';
import { validatePayload, ValidationFailure } from '../src/core/validate';

function expectErrors(data: unknown): string[] {
  try {
    validatePayload(data);
    throw new Error('应当抛出 ValidationFailure');
  } catch (err) {
    if (!(err instanceof ValidationFailure)) throw err;
    return err.errors.map((e) => `${e.path}: ${e.message}`);
  }
}

const validJob = (id: string) => ({ id, start: 0, end: 1, benefit: 1 });

describe('validatePayload：顶层结构', () => {
  it('拒绝非对象 / 数组', () => {
    expectErrors(null);
    expectErrors([1, 2]);
    expectErrors('x');
  });

  it('capacity 必须是 1..8 整数', () => {
    const errs = expectErrors({ capacity: 0, jobs: [validJob('a')] });
    expect(errs.some((e) => e.startsWith('capacity:'))).toBe(true);
    expectErrors({ capacity: 9, jobs: [validJob('a')] });
    expectErrors({ capacity: 2.5, jobs: [validJob('a')] });
    expectErrors({ capacity: '3', jobs: [validJob('a')] });
    expectErrors({ jobs: [validJob('a')] });
  });

  it('jobs 数量必须在 1..50000', () => {
    expectErrors({ capacity: 1, jobs: [] });
    const big = Array.from({ length: 50_001 }, (_, i) => validJob(`j${i}`));
    expectErrors({ capacity: 1, jobs: big });
    expectErrors({ capacity: 1, jobs: 'no' });
  });

  it('合法输入通过并规范化数字 id', () => {
    const r = validatePayload({
      capacity: 3,
      jobs: [{ id: 42, start: 5, end: 9, benefit: 100 }],
    });
    expect(r.capacity).toBe(3);
    expect(r.jobs[0].id).toBe('42');
  });
});

describe('validatePayload：逐项错误', () => {
  it('收集每一项的全部错误而不是遇错即停', () => {
    // 第 2 项：空 id、start 越界、benefit 越界（start 非法时 end 的大小比较不重复报错）
    const errs = expectErrors({
      capacity: 1,
      jobs: [
        validJob('ok'),
        { id: '', start: -1, end: 0, benefit: 0 },
        { id: 'ok', start: 0, end: 0, benefit: 5 },
      ],
    });
    expect(errs.some((e) => e.startsWith('jobs[1].id:'))).toBe(true);
    expect(errs.some((e) => e.startsWith('jobs[1].start:'))).toBe(true);
    expect(errs.some((e) => e.startsWith('jobs[1].benefit:'))).toBe(true);
    // 合法 start 下 end 必须严格更大
    expect(errs.some((e) => e.startsWith('jobs[2].end:'))).toBe(true);
    // 第 3 项：id 重复
    expect(errs.some((e) => e.startsWith('jobs[2].id:'))).toBe(true);
  });

  it('端点边界：start=0、end=1e9、benefit=1e9 合法', () => {
    const r = validatePayload({
      capacity: 8,
      jobs: [{ id: 'edge', start: 0, end: 1_000_000_000, benefit: 1_000_000_000 }],
    });
    expect(r.jobs).toHaveLength(1);
  });

  it('拒绝 start>=end、非整数、null/布尔字段', () => {
    expectErrors({
      capacity: 1,
      jobs: [{ id: 'x', start: 10, end: 10, benefit: 1 }],
    });
    expectErrors({
      capacity: 1,
      jobs: [{ id: 'x', start: 1.5, end: 2, benefit: 1 }],
    });
    expectErrors({
      capacity: 1,
      jobs: [{ id: null, start: 0, end: 2, benefit: 1 }],
    });
    expectErrors({
      capacity: 1,
      jobs: [{ id: true, start: 0, end: 2, benefit: 1 }],
    });
  });

  it('允许额外字段（严格只校验契约字段）', () => {
    const r = validatePayload({
      capacity: 1,
      jobs: [{ ...validJob('a'), crew: 'A', note: 'ok' }],
      source: 'planner',
    });
    expect(r.jobs).toHaveLength(1);
  });

  it('5 万合法项通过且 id 全部保留', () => {
    const jobs = Array.from({ length: 50_000 }, (_, i) => ({
      id: `J-${i}`,
      start: i * 2,
      end: i * 2 + 1,
      benefit: i + 1,
    }));
    const r = validatePayload({ capacity: 8, jobs });
    expect(r.jobs).toHaveLength(50_000);
    expect(r.jobs[49_999].id).toBe('J-49999');
  });
});
