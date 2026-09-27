import { describe, expect, it } from 'vitest';
import { validatePayload, ValidationFailure } from '../src/core/validate';
import type { CapacityCalendarSegment } from '../src/core/types';

function expectErrors(data: unknown): string[] {
  try {
    validatePayload(data);
    throw new Error('应当抛出 ValidationFailure');
  } catch (err) {
    if (!(err instanceof ValidationFailure)) throw err;
    return err.errors.map((e) => `${e.path}: ${e.message}`);
  }
}

const job = (id: string, start = 0, end = 20) => ({ id, start, end, benefit: 1 });

describe('validatePayload：capacityCalendar 缺省/空', () => {
  it('省略字段：日历为空数组（全程 capacity）', () => {
    const r = validatePayload({ capacity: 2, jobs: [job('a')] });
    expect(r.capacityCalendar).toEqual([]);
  });

  it('空数组：日历为空数组', () => {
    const r = validatePayload({ capacity: 2, jobs: [job('a')], capacityCalendar: [] });
    expect(r.capacityCalendar).toEqual([]);
  });

  it('合法片段被规范化并按 start 排序', () => {
    const r = validatePayload({
      capacity: 3,
      jobs: [job('a', 0, 30)],
      capacityCalendar: [
        { start: 10, end: 20, available: 0 },
        { start: 0, end: 10, available: 2 },
      ],
    });
    expect(r.capacityCalendar).toEqual([
      { start: 0, end: 10, available: 2 },
      { start: 10, end: 20, available: 0 },
    ]);
  });

  it('片段可在作业范围边界相接（start=最早开始、end=最晚结束）', () => {
    const r = validatePayload({
      capacity: 2,
      jobs: [
        job('a', 5, 10),
        job('b', 10, 25),
      ],
      capacityCalendar: [{ start: 5, end: 25, available: 1 }],
    });
    expect(r.capacityCalendar).toHaveLength(1);
  });
});

describe('validatePayload：日历逐项错误（拒绝且不产生部分数据）', () => {
  it('非数组报错', () => {
    const errs = expectErrors({
      capacity: 2,
      jobs: [job('a')],
      capacityCalendar: { start: 0, end: 10, available: 1 },
    });
    expect(errs.some((e) => e.startsWith('capacityCalendar:'))).toBe(true);
  });

  it('片段不是对象报错', () => {
    const errs = expectErrors({
      capacity: 2,
      jobs: [job('a')],
      capacityCalendar: [1, 'x', null],
    });
    expect(errs.some((e) => e.startsWith('capacityCalendar[0]:'))).toBe(true);
    expect(errs.some((e) => e.startsWith('capacityCalendar[1]:'))).toBe(true);
    expect(errs.some((e) => e.startsWith('capacityCalendar[2]:'))).toBe(true);
  });

  it('available 越界：负数 / 等于 capacity / 大于 capacity', () => {
    const errs = expectErrors({
      capacity: 2,
      jobs: [job('a', 0, 30)],
      capacityCalendar: [
        { start: 0, end: 10, available: -1 },
        { start: 10, end: 20, available: 2 },
        { start: 20, end: 30, available: 5 },
      ],
    });
    expect(errs.some((e) => e.startsWith('capacityCalendar[0].available:'))).toBe(true);
    expect(errs.some((e) => e.startsWith('capacityCalendar[1].available:'))).toBe(true);
    expect(errs.some((e) => e.startsWith('capacityCalendar[2].available:'))).toBe(true);
  });

  it('available 非整数 / 缺失 / 布尔', () => {
    const errs = expectErrors({
      capacity: 2,
      jobs: [job('a', 0, 30)],
      capacityCalendar: [
        { start: 0, end: 10, available: 1.5 },
        { start: 10, end: 20 },
        { start: 20, end: 30, available: true },
      ],
    });
    expect(errs.some((e) => e.startsWith('capacityCalendar[0].available:'))).toBe(true);
    expect(errs.some((e) => e.startsWith('capacityCalendar[1].available:'))).toBe(true);
    expect(errs.some((e) => e.startsWith('capacityCalendar[2].available:'))).toBe(true);
  });

  it('capacity=1 时 available 只能是 0', () => {
    expectErrors({
      capacity: 1,
      jobs: [job('a', 0, 10)],
      capacityCalendar: [{ start: 0, end: 10, available: 1 }],
    });
    const ok = validatePayload({
      capacity: 1,
      jobs: [job('a', 0, 10)],
      capacityCalendar: [{ start: 0, end: 10, available: 0 }],
    });
    expect(ok.capacityCalendar[0].available).toBe(0);
  });

  it('越界：片段早于最早作业开始 / 晚于最晚作业结束', () => {
    const errs = expectErrors({
      capacity: 2,
      jobs: [
        job('a', 5, 10),
        job('b', 15, 20),
      ],
      capacityCalendar: [
        { start: 0, end: 10, available: 1 },
        { start: 10, end: 25, available: 1 },
      ],
    });
    expect(errs.some((e) => e.startsWith('capacityCalendar[0]'))).toBe(true);
    expect(errs.some((e) => e.startsWith('capacityCalendar[1]'))).toBe(true);
  });

  it('start>=end、非整数端点、负端点报错', () => {
    const errs = expectErrors({
      capacity: 2,
      jobs: [job('a', 0, 20)],
      capacityCalendar: [
        { start: 10, end: 10, available: 1 },
        { start: 1.5, end: 10, available: 1 },
        { start: 0, end: 5, available: 1 },
      ],
    });
    expect(errs.some((e) => e.startsWith('capacityCalendar[0].end:'))).toBe(true);
    expect(errs.some((e) => e.startsWith('capacityCalendar[1].start:'))).toBe(true);
  });

  it('重叠片段逐项报错（相接允许）', () => {
    const errs = expectErrors({
      capacity: 3,
      jobs: [job('a', 0, 30)],
      capacityCalendar: [
        { start: 0, end: 12, available: 1 },
        { start: 10, end: 20, available: 2 }, // 与上一片重叠 [10,12)
      ],
    });
    expect(errs.some((e) => e.includes('重叠'))).toBe(true);
  });

  it('相接片段不报错', () => {
    const r = validatePayload({
      capacity: 3,
      jobs: [job('a', 0, 30)],
      capacityCalendar: [
        { start: 0, end: 10, available: 1 },
        { start: 10, end: 20, available: 2 },
        { start: 20, end: 30, available: 0 },
      ],
    });
    expect(r.capacityCalendar).toHaveLength(3);
  });

  it('日历错误与作业错误同时逐项收集', () => {
    const errs = expectErrors({
      capacity: 2,
      jobs: [{ id: 'a', start: 0, end: 0, benefit: 1 }],
      capacityCalendar: [{ start: 0, end: 10, available: 2 }],
    });
    expect(errs.some((e) => e.startsWith('jobs[0].end:'))).toBe(true);
    expect(errs.some((e) => e.startsWith('capacityCalendar[0].available:'))).toBe(true);
  });

  it('非法导入整体拒绝：返回值不存在（抛异常），调用方不替换工作区', () => {
    let threw = false;
    try {
      validatePayload({
        capacity: 2,
        jobs: [job('a', 0, 10)],
        capacityCalendar: [{ start: 0, end: 10, available: 99 }],
      });
    } catch (e) {
      threw = e instanceof ValidationFailure;
    }
    expect(threw).toBe(true);
  });
});

describe('validatePayload：日历结果可直接用于求解', () => {
  it('校验通过的日历片段排序后喂给求解器（类型贯通）', () => {
    const r = validatePayload({
      capacity: 2,
      jobs: [
        { id: 'a', start: 0, end: 10, benefit: 5 },
        { id: 'b', start: 0, end: 10, benefit: 7 },
        { id: 'c', start: 10, end: 20, benefit: 6 },
      ],
      capacityCalendar: [{ start: 0, end: 10, available: 1 }],
    });
    const cal: CapacityCalendarSegment[] = r.capacityCalendar;
    expect(cal[0]).toEqual({ start: 0, end: 10, available: 1 });
  });
});
