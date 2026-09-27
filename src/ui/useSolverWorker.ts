import { useCallback, useEffect, useRef, useState } from 'react';
import {
  persistReference,
  clearReference,
  persistSnapshot,
  resultMatchesWorkspace,
  type StoredSnapshot,
} from '../core/persistence';
import {
  activeReferenceMembers,
  referenceMembersFromSelection,
  type ReferencePlan,
} from '../core/reference';
import type { Workspace } from '../core/types';
import type { SolveRequest, SolveResponse } from '../solver/solver.worker';
import { decodeSolveResponse, isCurrentResponse } from './messages';

export type SolveState = 'idle' | 'computing' | 'success' | 'error';

/** 进行中请求的全部身份信息；响应必须与之逐字段匹配才允许落地为快照 */
interface PendingRequest {
  requestId: number;
  dataId: string;
  version: number;
  capacity: number;
  calendar: Workspace['capacityCalendar'];
  jobs: Workspace['jobs'];
  /** 发起本次请求时绑定的参考（身份已由调用方保证配套） */
  reference: ReferencePlan | null;
}

export interface SolverStatus {
  state: SolveState;
  /**
   * 最近一次有效成功结果，且只属于当前工作区数据身份；
   * 任何失败、身份不匹配或结果无效都不会写入/保留到这里。
   */
  snapshot: StoredSnapshot | null;
  /** 当前是否正在计算 */
  computing: boolean;
  /** 最近一次失败信息（不影响 snapshot） */
  errorMessage: string | null;
  /** 最近一次成功计算耗时（毫秒） */
  lastElapsedMs: number | null;
  /**
   * 当前已采纳的不可变参考方案；只可能属于当前工作区数据身份。
   * 导入新数据（dataId 变化）时立即清空并删除本地记录。
   */
  reference: ReferencePlan | null;
}

/**
 * 求解状态机。退出“计算中”是确定的：成功消息、失败消息、消息解码失败、
 * worker 进程崩溃（error 事件）或结构化克隆失败（messageerror 事件）
 * 都会把状态收敛到 error（保留最后一份有效结果），且重新创建 worker，
 * 下一次 run 一定可再次求解。
 */
export function useSolverWorker(initial: {
  snapshot: StoredSnapshot | null;
  reference: ReferencePlan | null;
}) {
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const pendingRef = useRef<PendingRequest | null>(null);
  // 当前参考始终放在 ref 中：run 的旧调用/异步回调读到的永远是最新采纳值，
  // 且只可能在参考身份与工作区一致时被发送给 worker。
  const referenceRef = useRef<ReferencePlan | null>(initial.reference);
  // worker 创建器固定在 ref 中，使崩溃后的错误监听器也能重建新 worker
  const createWorkerRef = useRef<() => Worker>(() => {
    throw new Error('worker factory 尚未初始化');
  });

  const [status, setStatus] = useState<SolverStatus>(() => ({
    state: initial.snapshot ? 'success' : 'idle',
    // 来自 restoreSession：已与工作区按数据身份严格配对，可直接作为
    // “最近一份有效结果”展示；身份存疑的快照不会出现在这里。
    snapshot: initial.snapshot,
    computing: false,
    errorMessage: null,
    lastElapsedMs: null,
    // 参考同样来自 restoreSession 的严格 dataId 配对，异身份记录已被丢弃。
    reference: initial.reference,
  }));

  /** 失败收敛：保留最后一份有效快照与参考，回到可重试状态。 */
  const failWith = useCallback((message: string) => {
    setStatus((prev) => ({
      state: 'error',
      snapshot: prev.snapshot,
      computing: false,
      errorMessage: message,
      lastElapsedMs: prev.lastElapsedMs,
      reference: prev.reference,
    }));
  }, []);

  useEffect(() => {
    const attach = (worker: Worker) => {
      // 进程级异常（求解器抛出未捕获错误/worker 加载失败）：
      // 当前 worker 已不可信，终止并重建；状态必须退出计算态
      worker.onerror = (ev: ErrorEvent) => {
        if (workerRef.current === worker) {
          worker.terminate();
          workerRef.current = createWorkerRef.current();
          attach(workerRef.current);
          pendingRef.current = null;
          failWith(`求解进程异常：${ev.message || '未知错误'}，可修正后重新计算`);
        }
      };
      // postMessage 参数无法结构化克隆等传输层错误
      worker.onmessageerror = () => {
        if (workerRef.current === worker) {
          worker.terminate();
          workerRef.current = createWorkerRef.current();
          attach(workerRef.current);
          pendingRef.current = null;
          failWith('求解消息传输失败，可重新计算');
        }
      };

      worker.onmessage = (ev: MessageEvent<unknown>) => {
        // 解码失败不能抛进事件循环，也不能让状态永远停在计算中
        const msg: SolveResponse | null = decodeSolveResponse(ev.data);
        if (!msg) return; // 无法关联到任何请求的畸形消息：丢弃
        if (!isCurrentResponse(msg, requestIdRef.current)) return;

        const pending = pendingRef.current;
        if (!pending || msg.requestId !== pending.requestId) return;

        if (msg.type === 'error') {
          pendingRef.current = null;
          setStatus((prev) => ({
            state: 'error',
            snapshot: prev.snapshot, // 关键语义：失败不清空最后一次有效结果
            computing: false,
            errorMessage: msg.message,
            lastElapsedMs: prev.lastElapsedMs,
            reference: prev.reference,
          }));
          return;
        }

        // 成功也要按当前工作区身份与内容交叉核对后才允许落地，
        // 任何对不上（异身份、引用不存在作业、收益/峰值不符）按失败处理
        if (msg.dataId !== pending.dataId) {
          pendingRef.current = null;
          failWith('求解结果与当前数据身份不匹配，已丢弃；请重新计算');
          return;
        }
        const pendingWorkspace: Workspace = {
          capacity: pending.capacity as Workspace['capacity'],
          version: pending.version,
          jobs: pending.jobs,
          capacityCalendar: pending.calendar,
          dataId: pending.dataId,
        };
        if (!resultMatchesWorkspace(pendingWorkspace, msg.result)) {
          pendingRef.current = null;
          failWith('求解结果未通过一致性校验（集合/收益/容量对不上），已丢弃；请重新计算');
          return;
        }

        const snapshot: StoredSnapshot = {
          workspaceDataId: pending.dataId,
          workspaceVersion: pending.version,
          capacity: msg.result.capacity,
          capacityCalendar: pending.calendar,
          solvedAt: new Date().toISOString(),
          result: msg.result,
        };
        pendingRef.current = null;
        // 工作区先写、快照后写：若只成功写入快照，恢复时没有同身份
        // 工作区可配对，孤儿快照会被 restoreSession 直接丢弃
        persistSnapshot(snapshot);
        setStatus((prev) => ({
          state: 'success',
          snapshot,
          computing: false,
          errorMessage: null,
          lastElapsedMs: msg.elapsedMs,
          reference: prev.reference,
        }));
      };
    };

    createWorkerRef.current = () =>
      new Worker(new URL('../solver/solver.worker.ts', import.meta.url), { type: 'module' });

    const worker = createWorkerRef.current();
    workerRef.current = worker;
    attach(worker);

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [failWith]);

  /**
   * 丢弃当前参考（导入新数据时调用）：内存状态与本地记录同时清除，
   * 此后求解回到“仅最大化收益”的原始行为。
   */
  const resetReference = useCallback(() => {
    referenceRef.current = null;
    clearReference();
    setStatus((prev) =>
      prev.reference === null
        ? prev
        : {
            ...prev,
            reference: null,
          },
    );
  }, []);

  /**
   * 把一份成功结果采纳为不可变参考方案。
   * 仅允许采纳与当前工作区身份配套、版本当前的成功结果（调用方 UI
   * 负责闸门）；采纳本身不重新求解——采纳来源就是当前严格最优解，
   * 差异为空（无已删除成员时），原求解结果逐项不变。
   */
  const adoptReference = useCallback(
    (workspace: Workspace, snapshot: StoredSnapshot): { adopted: boolean; reason?: string } => {
      if (snapshot.workspaceDataId !== workspace.dataId) {
        return { adopted: false, reason: '该结果不属于当前工作区，不能采纳为参考方案' };
      }
      if (snapshot.workspaceVersion !== workspace.version) {
        return { adopted: false, reason: '结果已过期，请先重新计算再采纳' };
      }
      if (snapshot.result.selectedCount === 0) {
        return { adopted: false, reason: '空排程没有可通知的作业，无需采纳为参考方案' };
      }
      const plan: ReferencePlan = {
        workspaceDataId: workspace.dataId,
        workspaceVersion: workspace.version,
        adoptedAt: new Date().toISOString(),
        members: referenceMembersFromSelection(snapshot.result.selectedIds, workspace.jobs),
      };
      referenceRef.current = plan;
      persistReference(plan); // 存储失败仅影响刷新后恢复，不影响当前采纳
      setStatus((prev) => ({ ...prev, reference: plan }));
      return { adopted: true };
    },
    [],
  );

  const run = useCallback(
    (workspace: Workspace) => {
      requestIdRef.current += 1;
      const id = requestIdRef.current;
      // 身份闸门（防御性）：只可能把与当前工作区同身份的参考送入求解。
      const reference =
        referenceRef.current && referenceRef.current.workspaceDataId === workspace.dataId
          ? referenceRef.current
          : null;
      if (referenceRef.current && reference === null) {
        // 理论上不应到达：导入新数据会先 resetReference；到达说明
        // 出现异身份残留，主动清掉，绝不误用。
        referenceRef.current = null;
        clearReference();
      }
      pendingRef.current = {
        requestId: id,
        dataId: workspace.dataId,
        version: workspace.version,
        capacity: workspace.capacity,
        calendar: workspace.capacityCalendar,
        jobs: workspace.jobs,
        reference,
      };
      const request: SolveRequest = {
        type: 'solve',
        requestId: id,
        dataId: workspace.dataId,
        capacity: workspace.capacity,
        jobs: workspace.jobs,
        capacityCalendar: workspace.capacityCalendar,
        // 仅发送仍存在于当前工作区的活动成员；已删除成员不参与
        // 可避免差异计数（改期成员仍以 id+时刻 不同而自然成为新成员）。
        reference: reference ? activeReferenceMembers(reference, workspace.jobs) : [],
      };
      setStatus((prev) => ({
        // 导入新数据（dataId 变化）：旧身份快照立即从状态中消失，
        // 绝不与新工作区同屏展示/可下载；同身份重算则保留旧版本结果
        // （界面按版本标记“已过期”）。
        state: 'computing',
        snapshot:
          prev.snapshot && prev.snapshot.workspaceDataId === workspace.dataId
            ? prev.snapshot
            : null,
        computing: true,
        errorMessage: null,
        lastElapsedMs: prev.lastElapsedMs,
        reference:
          prev.reference && prev.reference.workspaceDataId === workspace.dataId
            ? prev.reference
            : null,
      }));
      try {
        const worker = workerRef.current;
        if (!worker) {
          // 挂载 effect 尚未运行或已卸载：不创建无处理器的 worker
          pendingRef.current = null;
          failWith('求解进程尚未就绪，请稍后重新计算');
          return;
        }
        worker.postMessage(request);
      } catch {
        // 极端情况下 worker 不可用：同样确定地回到可重试状态
        pendingRef.current = null;
        failWith('求解进程不可用，请重新计算');
      }
    },
    [failWith],
  );

  return { status, run, adoptReference, resetReference };
}
