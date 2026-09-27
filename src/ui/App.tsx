import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImportPanel, type ImportSuccess } from './ImportPanel';
import { JobsTable } from './JobsTable';
import { ResultPanel } from './ResultPanel';
import { useSolverWorker } from './useSolverWorker';
import { createWorkspace, createDepthIndex, applyStatusChange } from '../core/workspace';
import { persistWorkspace, restoreSession } from '../core/persistence';
import type { IntervalDepthTree } from '../core/segmentTree';
import type { JobStatus, Workspace } from '../core/types';

export default function App() {
  // 恢复是唯一入口：restoreSession 同时校验工作区、快照与参考方案并按
  // 数据身份配对，单键写入、畸形记录、同版本异数据都不会混合成“当前结果”。
  // 惰性初始化只执行一次（其中旧数据迁移的回写也是幂等的）。
  const [initialSession] = useState(() =>
    typeof localStorage !== 'undefined'
      ? restoreSession()
      : { workspace: null, snapshot: null, reference: null },
  );
  const [workspace, setWorkspace] = useState<Workspace | null>(initialSession.workspace);
  const [toast, setToast] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const { status, run, adoptReference, resetReference } = useSolverWorker({
    snapshot: initialSession.snapshot,
    reference: initialSession.reference,
  });
  // 始终指向最新工作区，避免结果面板按钮闭包捕获旧对象
  const workspaceRef = useRef<Workspace | null>(null);
  workspaceRef.current = workspace;

  // 必选重叠度索引随工作区存活；导入时整体重建，约束修改时增量更新
  const depthRef = useRef<{
    tree: IntervalDepthTree;
    index: Map<number, number>;
    dataId: string;
    version: number;
  } | null>(null);

  // 导入后重建索引并自动求解
  const handleImport = useCallback(
    (data: ImportSuccess) => {
      const ws = createWorkspace(data);
      const { tree, index } = createDepthIndex(ws);
      depthRef.current = { tree, index, dataId: ws.dataId, version: ws.version };
      // 新数据 = 新 dataId：旧参考方案无论如何都不得作用于新工作区，
      // 先从内存与本地记录中彻底清除，再写入新工作区。
      resetReference();
      setWorkspace(ws);
      // 先持久化新工作区：任何时刻只写入快照时，恢复侧都因找不到同身份
      // 工作区而丢弃孤儿快照，旧结果不可能冒充新数据
      persistWorkspace(ws);
      setToast({ kind: 'ok', text: `已导入 ${ws.jobs.length} 项作业，开始自动求解` });
      run(ws);
    },
    [resetReference, run],
  );

  // 刷新（如初次加载已有工作区）时惰性建立索引
  const ensureDepthIndex = useCallback((ws: Workspace) => {
    if (
      !depthRef.current ||
      depthRef.current.dataId !== ws.dataId ||
      depthRef.current.version !== ws.version
    ) {
      const { tree, index } = createDepthIndex(ws);
      depthRef.current = { tree, index, dataId: ws.dataId, version: ws.version };
    }
    return depthRef.current;
  }, []);

  const handleChangeStatus = useCallback(
    (jobIndex: number, next: JobStatus) => {
      setWorkspace((prev) => {
        if (!prev) return prev;
        // 在副本上操作，保证拒绝时旧状态原样保留
        const copy: Workspace = {
          capacity: prev.capacity,
          version: prev.version,
          dataId: prev.dataId,
          jobs: prev.jobs.map((j) => ({ ...j })),
          capacityCalendar: prev.capacityCalendar,
        };
        const depth = ensureDepthIndex(prev);
        // 索引基于原工作区坐标；副本坐标完全相同，可复用
        const result = applyStatusChange(copy, depth.tree, depth.index, jobIndex, next);
        if (result.rejected) {
          setToast({ kind: 'error', text: result.rejected });
          return prev; // 旧约束、旧结果全部不变
        }
        depth.dataId = copy.dataId;
        depth.version = copy.version;
        persistWorkspace(copy);
        return copy;
      });
    },
    [ensureDepthIndex],
  );

  // 初次加载若有持久化工作区，重建索引（不自动重算，避免未经确认的计算）
  useEffect(() => {
    if (workspace) ensureDepthIndex(workspace);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(t);
  }, [toast]);

  // 入选集合只在快照与当前工作区同属一个数据身份时才下发给表格：
  // 异身份（含求解失败后残留的旧结果）绝不能在新作业上打勾
  const selectedIds = useMemo(
    () =>
      status.snapshot &&
      workspace &&
      status.snapshot.workspaceDataId === workspace.dataId
        ? new Set(status.snapshot.result.selectedIds)
        : null,
    [status.snapshot, workspace],
  );

  const counts = useMemo(() => {
    if (!workspace) return { normal: 0, required: 0, excluded: 0 };
    const c = { normal: 0, required: 0, excluded: 0 };
    for (const j of workspace.jobs) c[j.status]++;
    return c;
  }, [workspace]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>夜间铁路检修窗口排程</h1>
        <div className="subtitle">
          容量约束带权作业选择 · 精确最优 · 纯本地运行，无任何在线服务调用
        </div>
      </header>

      <ImportPanel onImport={handleImport} />

      {workspace ? (
        <>
          <section className="panel summary-panel">
            <div className="summary-row">
              <span>
                容量 <strong>capacity = {workspace.capacity}</strong>
              </span>
              <span>作业总数 {workspace.jobs.length}</span>
              <span className="tag tag-required">必选 {counts.required}</span>
              <span className="tag tag-excluded">排除 {counts.excluded}</span>
              <span className="tag tag-normal">普通 {counts.normal}</span>
              <span className="version-tag">工作区 v{workspace.version}</span>
            </div>
            {workspace.capacityCalendar.length > 0 && (
              <details className="calendar-details">
                <summary>
                  容量日历 {workspace.capacityCalendar.length} 段（未覆盖时段保持 capacity=
                  {workspace.capacity}）
                </summary>
                <ul className="calendar-list">
                  {workspace.capacityCalendar.map((seg, i) => (
                    <li key={i}>
                      <code>
                        [{seg.start}, {seg.end})
                      </code>{' '}
                      有效容量 <strong>{seg.available}</strong>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <JobsTable
            jobs={workspace.jobs}
            selectedIds={selectedIds}
            onChangeStatus={handleChangeStatus}
          />

          <ResultPanel
            status={status}
            jobs={workspace.jobs}
            workspaceDataId={workspace.dataId}
            workspaceVersion={workspace.version}
            onRecompute={() => {
              const ws = workspaceRef.current;
              if (ws) run(ws);
            }}
            onAdopt={() => {
              const ws = workspaceRef.current;
              const snap = status.snapshot;
              if (!ws || !snap) return;
              const outcome = adoptReference(ws, snap);
              if (outcome.adopted) {
                setToast({
                  kind: 'ok',
                  text: `已采纳当前结果（v${ws.version}）为不可变参考方案：此后重算在收益相同时将尽量少改动已通知作业`,
                });
              } else {
                setToast({ kind: 'error', text: outcome.reason ?? '采纳失败' });
              }
            }}
          />
        </>
      ) : (
        <section className="panel">
          <p className="hint">空仓库：请先导入作业 JSON。当前没有任何工作数据。</p>
        </section>
      )}

      {toast && (
        <div className={`toast toast-${toast.kind}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}
