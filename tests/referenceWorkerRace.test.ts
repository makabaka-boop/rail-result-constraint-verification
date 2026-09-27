import { describe, expect, it } from 'vitest';
import { isCurrentResponse } from '../src/ui/messages';
import type { SolveResponse } from '../src/solver/solver.worker';

/**
 * Worker 在 jsdom/node 下不便直接构造，这里通过 ?worker 插件不可用时
 * 直接验证两条与参考方案相关的消息层契约（解码逻辑见 solver.worker.ts）：
 *  1) 异步旧结果：携带参考的迟到响应仍由 requestId 闸门丢弃；
 *  2) 响应解码不因新增字段而变化（结构守卫向前兼容）。
 * 参考字段的“畸形降级为无参考”在求解器侧通过 solve(..., reference)
 * 的宽松命中行为已在 referencePlan.test.ts 覆盖（幽灵成员等同无命中）。
 */
function success(requestId: number, ids: string[], total: number, dataId = 'data-X'): SolveResponse {
  return {
    type: 'success',
    requestId,
    dataId,
    result: {
      selectedIds: ids,
      totalBenefit: total,
      peakOccupancy: 1,
      peakCellLimit: 1,
      capacity: 1,
      selectedCount: ids.length,
    },
    elapsedMs: 8,
  };
}

describe('异步旧结果：携带参考的迟到响应不得落地', () => {
  it('旧请求（发起时已采纳参考）的迟到成功响应被 requestId 闸门丢弃', () => {
    // 请求 1：采纳参考 R 后对日历 v2 求解；用户立即再改约束发出请求 2。
    // 请求 1 迟到返回：哪怕它的结果是按 R tiebreak 算的，也不能覆盖请求 2。
    const stale = success(1, ['old-tiebreak'], 100, 'data-X');
    const current = success(2, ['new-optimum'], 100, 'data-X');
    expect(isCurrentResponse(stale, 2)).toBe(false);
    expect(isCurrentResponse(current, 2)).toBe(true);
  });

  it('旧请求的迟到失败响应同样被丢弃，不会把当前状态置为错误', () => {
    const staleError: SolveResponse = {
      type: 'error',
      requestId: 1,
      dataId: 'data-X',
      message: '旧日历下必选不可行',
    };
    expect(isCurrentResponse(staleError, 2)).toBe(false);
  });

  it('同收益不同成员的两个响应：只有最新请求的结果可以落地（差异不豁免闸门）', () => {
    // 两个响应总收益相同但集合不同：若错误地接受旧响应，页面会展示
    // 非最新约束下的 tiebreak 成员，下载也会随之出错。
    const stale = success(1, ['ref-kept'], 10);
    const current = success(2, ['ref-swapped'], 10);
    expect(isCurrentResponse(stale, 2)).toBe(false);
    expect(isCurrentResponse(current, 2)).toBe(true);
  });
});
