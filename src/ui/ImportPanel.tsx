import { useRef, useState } from 'react';
import { validatePayload, ValidationFailure } from '../core/validate';
import type { ValidationError } from '../core/validate';
import type { Capacity, CapacityCalendarSegment } from '../core/types';

export interface ImportSuccess {
  capacity: Capacity;
  jobs: { id: string; start: number; end: number; benefit: number }[];
  capacityCalendar: CapacityCalendarSegment[];
}

interface Props {
  onImport: (data: ImportSuccess) => void;
  disabled?: boolean;
}

/**
 * 导入区：支持文件选择与文本粘贴。校验失败时逐项列出错误，
 * 是否替换工作区完全交给父组件（本组件不持有工作区）。
 */
export function ImportPanel({ onImport, disabled }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);

  const consumeText = (text: string, source: string) => {
    setErrors([]);
    setParseError(null);
    setOkMessage(null);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      setParseError(`${source} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    try {
      const result = validatePayload(json);
      onImport(result);
      setOkMessage(
        `导入成功：capacity=${result.capacity}，作业 ${result.jobs.length} 项` +
          (result.capacityCalendar.length > 0
            ? `，容量日历 ${result.capacityCalendar.length} 段`
            : ''),
      );
    } catch (err) {
      if (err instanceof ValidationFailure) {
        setErrors(err.errors);
      } else {
        setParseError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  return (
    <section className="panel import-panel">
      <h2>1. 导入作业数据</h2>
      <p className="hint">
        普通 JSON：<code>capacity</code> 为 1..8 整数；<code>jobs</code>{' '}
        为 1..50000 项，每项含唯一非空 <code>id</code> 与整数{' '}
        <code>start/end/benefit</code>。区间左闭右开，相接不算重叠。
        可选 <code>capacityCalendar</code>：形如{' '}
        <code>{'[{ "start": 0, "end": 10, "available": 1 }]'}</code>{' '}
        的片段数组，<code>available</code> 为 0..capacity-1；
        片段限于最早作业开始至最晚结束，互不重叠但可相接；省略表示全程 capacity。
      </p>
      <div className="import-actions">
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            file.text().then((text) => consumeText(text, `文件 "${file.name}"`));
            e.target.value = '';
          }}
        />
        <button onClick={() => fileRef.current?.click()} disabled={disabled}>
          选择 JSON 文件
        </button>
      </div>
      <details>
        <summary>或直接粘贴 JSON 文本</summary>
        <PasteImport
          onSubmit={(text) => consumeText(text, '粘贴内容')}
          disabled={disabled}
        />
      </details>

      {parseError && <div className="error-box">{parseError}</div>}
      {errors.length > 0 && (
        <div className="error-box" role="alert">
          <div className="error-summary">
            非法导入，共 {errors.length} 项错误；工作区未被修改：
          </div>
          <ul className="error-list">
            {errors.slice(0, 200).map((e, i) => (
              <li key={i}>
                <code>{e.path}</code>：{e.message}
              </li>
            ))}
            {errors.length > 200 && <li>… 其余 {errors.length - 200} 项已省略</li>}
          </ul>
        </div>
      )}
      {okMessage && <div className="ok-box">{okMessage}</div>}
    </section>
  );
}

function PasteImport({
  onSubmit,
  disabled,
}: {
  onSubmit: (text: string) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState('');
  return (
    <div className="paste-area">
      <textarea
        rows={6}
        placeholder='{"capacity": 2, "jobs": [{"id": "a", "start": 0, "end": 10, "benefit": 5}]}'
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <button disabled={disabled || text.trim() === ''} onClick={() => onSubmit(text)}>
        校验并导入
      </button>
    </div>
  );
}
