import { solve, type SolverJob, type SolverResult, InfeasibleRequiredError } from '../core/solver';
import { normalizeReferenceMembers, type ReferenceMember } from '../core/reference';
import type { CapacityCalendarSegment } from '../core/types';

export interface SolveRequest {
  type: 'solve';
  requestId: number;
  /** 发起请求时工作区的数据身份；成功/失败响应原样回传，供主线程配对 */
  dataId: string;
  jobs: SolverJob[];
  capacity: number;
  /** 当前请求的容量日历；约束变化（含日历）使旧结果过期 */
  capacityCalendar: CapacityCalendarSegment[];
  /**
   * 可选：已采纳参考方案中仍存在于当前工作区的活动成员
   * （id+start+end）。字段缺失/结构损坏时按无参考求解——
   * 参考只影响同收益方案间的二级裁决，缺失它不会使结果不可行。
   */
  reference?: ReferenceMember[];
}

export type SolveResponse =
  | {
      type: 'success';
      requestId: number;
      dataId: string;
      result: SolverResult;
      elapsedMs: number;
    }
  | {
      type: 'error';
      requestId: number;
      dataId?: string;
      message: string;
      conflictingId?: string;
    };

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<unknown>) => void) | null;
  postMessage: (msg: SolveResponse) => void;
};

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * 请求结构守卫：传输损坏/畸形消息不得导致 worker 未捕获异常
 * （那会让主线程永久停在“计算中”）。无法识别的请求安全忽略；
 * 身份/字段非法但 requestId 可用时回错误响应让主线程退出计算态。
 */
function decodeRequest(raw: unknown): { request: SolveRequest | null; requestId?: number; dataId?: string } {
  if (typeof raw !== 'object' || raw === null) return { request: null };
  const msg = raw as Record<string, unknown>;
  if (msg.type !== 'solve') return { request: null };
  if (!isInt(msg.requestId)) return { request: null };
  const requestId = msg.requestId;
  const dataId = typeof msg.dataId === 'string' ? msg.dataId : undefined;

  if (typeof dataId !== 'string' || dataId.length === 0) {
    return { request: null, requestId, dataId };
  }
  if (!isInt(msg.capacity) || msg.capacity < 1 || msg.capacity > 8) {
    return { request: null, requestId, dataId };
  }
  if (!Array.isArray(msg.jobs) || !Array.isArray(msg.capacityCalendar)) {
    return { request: null, requestId, dataId };
  }
  // jobs / calendar 的深度合法性由 solve 与主线程交叉核对兜底；
  // 这里只保证消息形态足以安全进入求解（数组元素为对象）。
  for (const j of msg.jobs) {
    if (typeof j !== 'object' || j === null) return { request: null, requestId, dataId };
  }
  for (const seg of msg.capacityCalendar) {
    if (typeof seg !== 'object' || seg === null) return { request: null, requestId, dataId };
  }
  // 参考成员是可选的纯 tiebreak 输入：缺失合法、损坏时降级为无参考，
  // 绝不因其结构问题导致整次求解失败（必选/收益/容量结论不受影响）。
  let reference: ReferenceMember[] | undefined;
  if (msg.reference !== undefined) {
    if (!Array.isArray(msg.reference)) {
      reference = [];
    } else {
      const normalized = normalizeReferenceMembers(msg.reference);
      reference = normalized ?? [];
    }
  }
  return {
    request: {
      type: 'solve',
      requestId,
      dataId,
      jobs: msg.jobs as SolverJob[],
      capacity: msg.capacity,
      capacityCalendar: msg.capacityCalendar as CapacityCalendarSegment[],
      reference,
    },
  };
}

ctx.onmessage = (ev: MessageEvent<unknown>) => {
  const { request, requestId, dataId } = decodeRequest(ev.data);
  if (!request) {
    // 无法识别（也无法关联）的消息：安全忽略；能关联的回一个错误响应
    if (requestId !== undefined) {
      ctx.postMessage({ type: 'error', requestId, dataId, message: '求解请求结构非法，已拒绝执行' });
    }
    return;
  }

  const started = performance.now();
  try {
    // Worker 只提交当前请求携带的日历/参考：迟到的旧请求响应会被 UI 丢弃
    const result = solve(
      request.jobs,
      request.capacity,
      request.capacityCalendar ?? [],
      request.reference ?? [],
    );
    const response: SolveResponse = {
      type: 'success',
      requestId: request.requestId,
      dataId: request.dataId,
      result,
      elapsedMs: Math.round(performance.now() - started),
    };
    ctx.postMessage(response);
  } catch (err) {
    const infeasible = err as InfeasibleRequiredError;
    const response: SolveResponse = {
      type: 'error',
      requestId: request.requestId,
      dataId: request.dataId,
      message: err instanceof Error ? err.message : String(err),
      conflictingId: infeasible?.conflictingId,
    };
    ctx.postMessage(response);
  }
};

export {};
