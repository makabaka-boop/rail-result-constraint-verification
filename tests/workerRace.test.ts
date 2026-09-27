import { describe, expect, it } from 'vitest';
import { isCurrentResponse } from '../src/ui/messages';
import type { SolverResult } from '../src/core/solver';
import type { SolveResponse } from '../src/solver/solver.worker';

function success(requestId: number, ids: string[], total: number, dataId = 'data-X'): SolveResponse {
  const result: SolverResult = {
    selectedIds: ids,
    totalBenefit: total,
    peakOccupancy: 1,
    peakCellLimit: 1,
    capacity: 1,
    selectedCount: ids.length,
  };
  return { type: 'success', requestId, dataId, result, elapsedMs: 12 };
}

describe('回归：工作区切换时的 worker 响应竞态', () => {
  it('A 仍在计算时导入 B：A 先返回的响应被丢弃，只接受 B', () => {
    // run(A) -> requestId 1；run(B) -> requestId 2
    let latestRequestId = 1;
    const responseA = success(1, ['A-only'], 111);
    const responseB = success(2, ['B-only'], 222);

    // A 迟到（先于 B）返回时，最新请求已是 B
    latestRequestId = 2;
    expect(isCurrentResponse(responseA, latestRequestId)).toBe(false);

    // 旧实现没有这道校验：A 的结果会被当成 B 提交并持久化/下载
    // 只有 requestId 与最新请求一致的响应才允许落地
    expect(isCurrentResponse(responseB, latestRequestId)).toBe(true);
  });

  it('过期工作区的失败响应同样被丢弃，不会把当前工作区置为错误态', () => {
    const staleError: SolveResponse = { type: 'error', requestId: 1, message: 'A 失败' };
    expect(isCurrentResponse(staleError, 2)).toBe(false);
    const currentError: SolveResponse = { type: 'error', requestId: 2, message: 'B 失败' };
    expect(isCurrentResponse(currentError, 2)).toBe(true);
  });
});
