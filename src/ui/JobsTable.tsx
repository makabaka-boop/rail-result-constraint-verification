import { useEffect, useMemo, useRef, useState } from 'react';
import type { Job, JobStatus } from '../core/types';

export type StatusFilter = 'all' | JobStatus | 'selected';

interface Props {
  jobs: Job[];
  selectedIds: Set<string> | null;
  onChangeStatus: (jobIndex: number, next: JobStatus) => void;
}

const ROW_HEIGHT = 34;
const OVERSCAN = 8;

/**
 * 作业清单：
 *  - 窗口化渲染，只绘制可视区域附近的行，支持 5 万行流畅滚动
 *  - 可按状态 / 关键字 / 是否入选过滤
 *  - 每行可在 普通 / 必选 / 排除 间切换；必选被拒绝时由父组件提示
 */
export function JobsTable({ jobs, selectedIds, onChangeStatus }: Props) {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [keyword, setKeyword] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(520);

  const filtered = useMemo(() => {
    const kw = keyword.trim();
    const result: { job: Job; originalIndex: number }[] = [];
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      if (filter === 'required' && job.status !== 'required') continue;
      if (filter === 'excluded' && job.status !== 'excluded') continue;
      if (filter === 'normal' && job.status !== 'normal') continue;
      if (filter === 'selected' && (!selectedIds || !selectedIds.has(job.id))) continue;
      if (kw !== '' && !job.id.includes(kw)) continue;
      result.push({ job, originalIndex: i });
    }
    return result;
  }, [jobs, filter, keyword, selectedIds]);

  const totalH = filtered.length * ROW_HEIGHT;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportH / ROW_HEIGHT) + 2 * OVERSCAN;
  const end = Math.min(filtered.length, start + visibleCount);

  // 视口高度用 ResizeObserver 测量，保证窗口化行数准确
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (h) setViewportH(h);
    });
    observer.observe(el);
    setViewportH(el.clientHeight || 520);
    return () => observer.disconnect();
  }, []);

  // 过滤条件变化后回到顶部，避免停留在超出新列表长度的滚动位置
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, [filter, keyword]);

  return (
    <section className="panel jobs-panel">
      <h2>2. 设置约束（必选 / 排除 / 普通）</h2>
      <div className="toolbar">
        <label>
          过滤：
          <select value={filter} onChange={(e) => setFilter(e.target.value as StatusFilter)}>
            <option value="all">全部</option>
            <option value="normal">普通</option>
            <option value="required">必选</option>
            <option value="excluded">排除</option>
            <option value="selected">当前结果已选</option>
          </select>
        </label>
        <label>
          id 包含：
          <input
            type="search"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索 id"
          />
        </label>
        <span className="count-label">
          显示 {filtered.length} / {jobs.length} 项
        </span>
      </div>

      <div
        className="table-viewport"
        ref={scrollRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: totalH, position: 'relative' }}>
          <table className="jobs-table" style={{ top: start * ROW_HEIGHT }}>
            <thead>
              <tr>
                <th className="col-idx">#</th>
                <th className="col-id">id</th>
                <th className="col-num">start</th>
                <th className="col-num">end</th>
                <th className="col-num">benefit</th>
                <th className="col-status">状态</th>
                <th className="col-selected">入选</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(start, end).map(({ job, originalIndex }) => (
                <tr
                  key={job.id}
                  className={
                    job.status === 'required'
                      ? 'row-required'
                      : job.status === 'excluded'
                        ? 'row-excluded'
                        : ''
                  }
                >
                  <td className="col-idx">{originalIndex}</td>
                  <td className="col-id" title={job.id}>
                    {job.id}
                  </td>
                  <td className="col-num">{job.start}</td>
                  <td className="col-num">{job.end}</td>
                  <td className="col-num">{job.benefit.toLocaleString()}</td>
                  <td className="col-status">
                    <div className="seg" role="group" aria-label={`作业 ${job.id} 的状态`}>
                      {(
                        [
                          ['normal', '普通'],
                          ['required', '必选'],
                          ['excluded', '排除'],
                        ] as [JobStatus, string][]
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          className={`seg-btn ${job.status === value ? 'active seg-' + value : ''}`}
                          onClick={() => onChangeStatus(originalIndex, value)}
                          aria-pressed={job.status === value}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="col-selected">
                    {selectedIds?.has(job.id) ? <span className="badge-in">✓</span> : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
