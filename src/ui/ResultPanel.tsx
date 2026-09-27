import { useMemo } from 'react';
import { buildResultJson, type StoredSnapshot } from '../core/persistence';
import { computeReferenceDiff, type ReferenceDiff, type ReferencePlan } from '../core/reference';
import type { Job } from '../core/types';
import type { SolverStatus } from './useSolverWorker';

interface Props {
  status: SolverStatus;
  jobs: Job[];
  workspaceDataId: string;
  workspaceVersion: number;
  onRecompute: () => void;
  onAdopt: () => void;
}

/**
 * 求解结果区。
 * 关键语义：
 *  - 计算中：显示进行中状态，同身份旧结果仍可见
 *  - 失败：显示错误，不清空最近一次有效结果；按钮立即可再次求解
 *  - 结果与当前工作区数据身份不一致：不展示、不可下载
 *    （版本号相同但属于另一批数据时尤其关键）
 *  - 同身份但版本较旧时标记“已过期，请重算”
 *  - 已采纳参考方案时：结果页列出相对参考的 保留 / 撤下 / 新增 成员，
 *    屏幕与下载 JSON 使用同一个 computeReferenceDiff 结果快照
 *  - 屏幕显示的集合 = 下载 JSON 中的集合（同一个 buildResultJson 数据源）
 */
export function ResultPanel({
  status,
  jobs,
  workspaceDataId,
  workspaceVersion,
  onRecompute,
  onAdopt,
}: Props) {
  const rawSnapshot = status.snapshot;
  // 数据身份闸门：不匹配的快照（理论上状态机已剔除）在此再挡一次，
  // 保证展示与下载永远只属于当前工作区
  const snapshot =
    rawSnapshot && rawSnapshot.workspaceDataId === workspaceDataId ? rawSnapshot : null;
  const stale = snapshot !== null && snapshot.workspaceVersion !== workspaceVersion;

  // 参考同样按身份再挡一次；身份不配套时不显示差异，也不进入下载。
  const reference: ReferencePlan | null =
    status.reference && status.reference.workspaceDataId === workspaceDataId
      ? status.reference
      : null;

  // 差异只从当前快照 + 当前工作区作业 + 参考方案一次性计算：
  // 结果页列表与下载文件引用同一个 diff 对象（同一结果快照）。
  const diff: ReferenceDiff | null = useMemo(
    () => (snapshot && reference ? computeReferenceDiff(snapshot.result.selectedIds, jobs, reference) : null),
    [snapshot, reference, jobs],
  );

  // 采纳来源必须是当前版本的成功结果：过期/计算中/失败均不允许。
  const adoptable =
    snapshot !== null &&
    !stale &&
    !status.computing &&
    snapshot.result.selectedCount > 0;

  const download = useMemo(() => {
    if (!snapshot) return null;
    return () => {
      const payload = buildResultJson(snapshot, reference, diff);
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `schedule-${payload.workspaceVersion}.json`;
      a.click();
      URL.revokeObjectURL(url);
    };
  }, [snapshot, reference, diff]);

  return (
    <section className="panel result-panel">
      <div className="result-head">
        <h2>3. 排程结果</h2>
        <div className="result-actions">
          <button
            className="primary"
            onClick={onRecompute}
            disabled={status.computing}
            title="先严格最大化总收益；收益相同时最小化与已采纳参考方案的作业成员差异"
          >
            {status.computing ? '计算中…' : snapshot ? '重新计算' : '计算最优排程'}
          </button>
          <button
            onClick={onAdopt}
            disabled={!adoptable}
            title="把当前结果采纳为不可变参考方案；之后重算在同收益方案间尽量少改动已通知作业"
          >
            采纳为参考方案
          </button>
          <button onClick={() => download?.()} disabled={!snapshot || status.computing}>
            下载结果 JSON
          </button>
        </div>
      </div>

      {reference && (
        <div className="info-box reference-banner">
          已采纳不可变参考方案（v{reference.workspaceVersion}，采纳于 {reference.adoptedAt}）：
          求解仍先严格最大化总收益并满足必选/排除与逐时段容量约束，仅在收益相同的
          方案间最小化与参考方案的作业成员差异。
          {diff && (
            <>
              {' '}
              当前可避免差异 <strong>{diff.diffCount}</strong> 项
              （撤下 {diff.removed.length}、新增 {diff.added.length}；
              保留 {diff.retained.length}
              {diff.deletedReference.length > 0
                ? `；参考成员已从工作区删除 ${diff.deletedReference.length} 项，不计入差异`
                : ''}
              ）。
            </>
          )}
        </div>
      )}

      {status.state === 'error' && status.errorMessage && (
        <div className="error-box" role="alert">
          计算失败：{status.errorMessage}
          <div className="hint">
            同批数据的最近一次有效结果仍保留；当前结果未被清空，可直接再次计算。
          </div>
        </div>
      )}

      {status.computing && <div className="info-box">正在精确求解，请稍候…</div>}

      {!snapshot && !status.computing && (
        <div className="hint">尚未计算。导入数据后将自动求解，或点击上方按钮手动计算。</div>
      )}

      {snapshot && (
        <div className={stale ? 'stale' : ''}>
          {stale && (
            <div className="warn-box">
              约束或容量日历已修改，以下结果基于旧版本（v{snapshot.workspaceVersion}，当前 v
              {workspaceVersion}），已过期。点击“重新计算”获取最新最优解。
            </div>
          )}
          <div className="metric-grid">
            <Metric label="总收益（精确）" value={snapshot.result.totalBenefit.toLocaleString()} />
            <Metric
              label="峰值占用 / 最早峰值格上限"
              value={`${snapshot.result.peakOccupancy} / ${snapshot.result.peakCellLimit ?? snapshot.capacity}`}
            />
            <Metric label="入选作业数" value={String(snapshot.result.selectedCount)} />
            <Metric label="求解版本" value={`v${snapshot.workspaceVersion}`} />
          </div>
          <div className="result-meta">
            计算完成时间：{snapshot.solvedAt}
            {status.lastElapsedMs !== null && (
              <>　·　耗时 {status.lastElapsedMs} ms</>
            )}
          </div>
          {diff && reference && <ReferenceChanges diff={diff} snapshot={snapshot} reference={reference} />}
          <SelectedIds snapshot={snapshot} reference={reference} diff={diff} />
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}

/** 成员在列表中的统一展示文本：id [start,end)；改期项附当前时刻。 */
function memberLine(m: { id: string; start: number; end: number }): string {
  return `${m.id}  [${m.start}, ${m.end})`;
}

/**
 * 保留 / 撤下 / 新增 三个名单。所有名单来自同一个 diff 对象，
 * 该对象同时传入 buildResultJson，因此屏幕与下载严格一致。
 */
function ReferenceChanges({
  diff,
  snapshot,
  reference,
}: {
  diff: ReferenceDiff;
  snapshot: StoredSnapshot;
  reference: ReferencePlan;
}) {
  const payload = buildResultJson(snapshot, reference, diff);
  const screenRetained = diff.retained.map(memberLine);
  const downloadRetained = payload.reference!.retained.map(memberLine);
  const screenRemoved = diff.removed.map(memberLine);
  const downloadRemoved = payload.reference!.removed.map(memberLine);
  const screenAdded = diff.added.map(memberLine);
  const downloadAdded = payload.reference!.added.map(memberLine);
  const consistent =
    sameLines(screenRetained, downloadRetained) &&
    sameLines(screenRemoved, downloadRemoved) &&
    sameLines(screenAdded, downloadAdded) &&
    payload.reference!.diffCount === diff.diffCount;

  return (
    <details className="reference-details" open>
      <summary>
        相对参考方案的成员差异（{diff.diffCount} 项可避免差异
        {consistent ? '，与下载 JSON 一致' : '，与下载不一致！'}）
      </summary>
      <div className="reference-columns">
        <ChangeColumn
          title={`保留（${diff.retained.length}）`}
          lines={screenRetained}
          className="col-retained"
        />
        <ChangeColumn
          title={`撤下（${diff.removed.length}）`}
          lines={screenRemoved}
          className="col-removed"
        />
        <ChangeColumn title={`新增（${diff.added.length}）`} lines={screenAdded} className="col-added" />
      </div>
      {diff.deletedReference.length > 0 && (
        <div className="hint">
          以下 {diff.deletedReference.length} 项参考成员已从当前工作区删除，不参与可避免差异计数：
          <ul className="deleted-ref-list">
            {diff.deletedReference.map((m) => (
              <li key={`${m.id}-${m.start}-${m.end}`}>{memberLine(m)}</li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

function ChangeColumn({
  title,
  lines,
  className,
}: {
  title: string;
  lines: string[];
  className: string;
}) {
  return (
    <div className={`reference-col ${className}`}>
      <div className="reference-col-title">{title}</div>
      {lines.length === 0 ? (
        <div className="hint">—</div>
      ) : (
        <ul className="change-list">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SelectedIds({
  snapshot,
  reference,
  diff,
}: {
  snapshot: StoredSnapshot;
  reference: ReferencePlan | null;
  diff: ReferenceDiff | null;
}) {
  const ids = snapshot.result.selectedIds;
  const jsonPayload = buildResultJson(snapshot, reference, diff);
  const jsonIds = jsonPayload.selectedIds;
  // 屏幕集合与下载一致性断言（同数据源，正常情况下恒等）
  const consistent = ids.length === jsonIds.length && ids.every((v, i) => v === jsonIds[i]);
  return (
    <details className="selected-details">
      <summary>
        入选集合（{ids.length} 项{consistent ? '，与下载 JSON 一致' : '，与下载不一致！'}）
      </summary>
      <textarea readOnly rows={10} value={JSON.stringify(ids, null, 2)} spellCheck={false} />
    </details>
  );
}
