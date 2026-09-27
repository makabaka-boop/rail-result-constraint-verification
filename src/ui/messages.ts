import type { SolverResult } from '../core/solver';
import type { SolveResponse } from '../solver/solver.worker';

/**
 * 判断一条 worker 响应是否仍属于当前最新的请求。
 *
 * 工作区 A 计算期间立即导入工作区 B 会使最新 requestId 前移；
 * A 迟到（先于 B 返回）的响应 requestId 已过期，必须丢弃，
 * 否则 A 的集合/收益会被写入 B 的页面状态、快照与下载文件。
 */
export function isCurrentResponse(msg: SolveResponse, latestRequestId: number): boolean {
  return msg.requestId === latestRequestId;
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * 严格解码 worker 消息。消息解码失败（结构损坏、字段缺失/类型错误、
 * 结果体畸形）不得抛进 React 事件循环、更不得让状态永久停在“计算中”：
 *  - 能取到合法 requestId 的：归一为该请求的错误响应，由状态机
 *    确定地退出计算态，回到可重试状态；
 *  - 连 requestId 都没有的无法关联任何请求：返回 null（丢弃，
 *    不触碰当前状态）。
 */
export function decodeSolveResponse(raw: unknown): SolveResponse | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const msg = raw as Record<string, unknown>;
  if (!isInt(msg.requestId)) return null;
  const requestId = msg.requestId;

  if (msg.type === 'error') {
    return {
      type: 'error',
      requestId,
      message: typeof msg.message === 'string' && msg.message.length > 0 ? msg.message : '求解进程返回了无法识别的错误信息',
      conflictingId: typeof msg.conflictingId === 'string' ? msg.conflictingId : undefined,
    };
  }

  if (msg.type !== 'success') return null;
  if (typeof msg.dataId !== 'string' || msg.dataId.length === 0) {
    return { type: 'error', requestId, message: '求解成功消息缺少数据身份，已丢弃' };
  }
  const dataId = msg.dataId;

  const result = decodeResult(msg.result);
  if (!result) {
    return { type: 'error', requestId, message: '求解成功消息解码失败：结果结构不完整或字段非法' };
  }
  return {
    type: 'success',
    requestId,
    dataId,
    result,
    elapsedMs: isInt(msg.elapsedMs) && msg.elapsedMs >= 0 ? msg.elapsedMs : 0,
  };
}

/** SolverResult 的结构守卫：只接受字段完整、类型/取值正确的结果。 */
export function decodeResult(raw: unknown): SolverResult | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (!Array.isArray(r.selectedIds)) return null;
  const selectedIds: string[] = [];
  const seen = new Set<string>();
  for (const id of r.selectedIds) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) return null;
    seen.add(id);
    selectedIds.push(id);
  }

  if (!Number.isSafeInteger(r.totalBenefit) || (r.totalBenefit as number) < 0) return null;
  if (!isInt(r.peakOccupancy) || r.peakOccupancy < 0) return null;
  if (!isInt(r.capacity) || r.capacity < 1 || r.capacity > 8) return null;
  if (!isInt(r.selectedCount) || r.selectedCount !== selectedIds.length) return null;
  if (r.peakCellLimit !== undefined && (!isInt(r.peakCellLimit) || r.peakCellLimit < 0)) return null;

  return {
    selectedIds,
    totalBenefit: r.totalBenefit as number,
    peakOccupancy: r.peakOccupancy as number,
    peakCellLimit: r.peakCellLimit as number | undefined,
    capacity: r.capacity as number,
    selectedCount: r.selectedCount as number,
  };
}
