import type {
  Capacity,
  CapacityCalendarSegment,
  ImportPayload,
  RawCalendarSegment,
  RawJob,
} from './types';

export interface ValidationError {
  /** 定位信息，如 "jobs[12].start" */
  path: string;
  message: string;
}

export class ValidationFailure extends Error {
  readonly errors: ValidationError[];
  constructor(errors: ValidationError[]) {
    super(`导入校验失败，共 ${errors.length} 项错误`);
    this.name = 'ValidationFailure';
    this.errors = errors;
  }
}

const MAX_BOUND = 1_000_000_000;
const MAX_JOBS = 50_000;

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * 校验计划员导入的 JSON。任何一项不合法都会收集进错误列表；
 * 调用方必须在校验全部通过后才替换工作区（本函数不产生任何外部副作用）。
 *
 * 校验规则：
 *  - capacity：1..8 的整数
 *  - jobs：长度 1..50000 的数组
 *  - 每项：id 唯一且非空（转为字符串），0 <= start < end <= 1e9，1 <= benefit <= 1e9
 *  - capacityCalendar（可选）：数组，每项为整数 start < end、available 为
 *    0..capacity-1 的整数；区间左闭右开，限于最早作业开始 ~ 最晚作业结束，
 *    互不重叠但可相接。省略字段或空数组表示全程 capacity。
 */
export function validatePayload(data: unknown): {
  capacity: Capacity;
  jobs: { id: string; start: number; end: number; benefit: number }[];
  capacityCalendar: CapacityCalendarSegment[];
} {
  const errors: ValidationError[] = [];

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ValidationFailure([
      { path: '$', message: 'JSON 顶层必须是对象，形如 {"capacity": 3, "jobs": [...]}' },
    ]);
  }

  const payload = data as ImportPayload;

  let capacity: Capacity | null = null;
  if (!('capacity' in payload)) {
    errors.push({ path: 'capacity', message: '缺少 capacity 字段' });
  } else if (!isInteger(payload.capacity)) {
    errors.push({
      path: 'capacity',
      message: `capacity 必须是整数，收到 ${JSON.stringify(payload.capacity)}`,
    });
  } else if (payload.capacity < 1 || payload.capacity > 8) {
    errors.push({
      path: 'capacity',
      message: `capacity 必须是 1 至 8 的整数，收到 ${payload.capacity}`,
    });
  } else {
    capacity = payload.capacity as Capacity;
  }

  if (!('jobs' in payload)) {
    errors.push({ path: 'jobs', message: '缺少 jobs 字段' });
    throw new ValidationFailure(errors);
  }
  if (!Array.isArray(payload.jobs)) {
    errors.push({
      path: 'jobs',
      message: `jobs 必须是数组，收到 ${typeof payload.jobs}`,
    });
    throw new ValidationFailure(errors);
  }
  if (payload.jobs.length < 1 || payload.jobs.length > MAX_JOBS) {
    errors.push({
      path: 'jobs',
      message: `jobs 数量必须在 1..${MAX_JOBS} 之间，收到 ${payload.jobs.length}`,
    });
  }

  const seen = new Set<string>();
  const jobs: { id: string; start: number; end: number; benefit: number }[] = [];

  payload.jobs.forEach((rawItem, i) => {
    const itemErrors: ValidationError[] = [];
    const prefix = `jobs[${i}]`;

    if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) {
      errors.push({ path: prefix, message: '作业必须是对象' });
      return;
    }
    const item = rawItem as RawJob;

    // id：数字也接受（规范化为字符串），但不允许空串
    let id = '';
    if (!('id' in item)) {
      itemErrors.push({ path: `${prefix}.id`, message: '缺少 id 字段' });
    } else if (item.id === null || typeof item.id === 'boolean') {
      itemErrors.push({
        path: `${prefix}.id`,
        message: `id 必须是非空字符串（或整数），收到 ${JSON.stringify(item.id)}`,
      });
    } else {
      if (typeof item.id !== 'string' && typeof item.id !== 'number') {
        itemErrors.push({
          path: `${prefix}.id`,
          message: `id 必须是非空字符串（或整数），收到 ${typeof item.id}`,
        });
      } else {
        id = String(item.id);
        if (id.trim() === '') {
          itemErrors.push({ path: `${prefix}.id`, message: 'id 不允许为空字符串' });
        } else if (seen.has(id)) {
          itemErrors.push({ path: `${prefix}.id`, message: `id "${id}" 重复，必须唯一` });
        }
      }
    }

    if (!isInteger(item.start)) {
      itemErrors.push({
        path: `${prefix}.start`,
        message: `start 必须是整数，收到 ${JSON.stringify(item.start)}`,
      });
    } else if (item.start < 0 || item.start > MAX_BOUND) {
      itemErrors.push({
        path: `${prefix}.start`,
        message: `start 必须满足 0 <= start <= ${MAX_BOUND}，收到 ${item.start}`,
      });
    }

    if (!isInteger(item.end)) {
      itemErrors.push({
        path: `${prefix}.end`,
        message: `end 必须是整数，收到 ${JSON.stringify(item.end)}`,
      });
    } else if (item.end <= (isInteger(item.start) ? item.start : -1)) {
      itemErrors.push({
        path: `${prefix}.end`,
        message: `end 必须严格大于 start（区间左闭右开，相接不算重叠），start=${item.start}, end=${item.end}`,
      });
    } else if (item.end > MAX_BOUND) {
      itemErrors.push({
        path: `${prefix}.end`,
        message: `end 必须 <= ${MAX_BOUND}，收到 ${item.end}`,
      });
    }

    if (!isInteger(item.benefit)) {
      itemErrors.push({
        path: `${prefix}.benefit`,
        message: `benefit 必须是整数，收到 ${JSON.stringify(item.benefit)}`,
      });
    } else if (item.benefit < 1 || item.benefit > MAX_BOUND) {
      itemErrors.push({
        path: `${prefix}.benefit`,
        message: `benefit 必须满足 1 <= benefit <= ${MAX_BOUND}，收到 ${item.benefit}`,
      });
    }

    if (itemErrors.length > 0) {
      errors.push(...itemErrors);
      return;
    }

    seen.add(id);
    jobs.push({ id, start: item.start as number, end: item.end as number, benefit: item.benefit as number });
  });

  // ---- 容量日历（可选） ----
  let calendar: CapacityCalendarSegment[] = [];
  const hasCalendar = 'capacityCalendar' in payload && payload.capacityCalendar !== undefined;
  if (hasCalendar) {
    const rawCalendar = payload.capacityCalendar;
    if (!Array.isArray(rawCalendar)) {
      errors.push({
        path: 'capacityCalendar',
        message: `capacityCalendar 必须是数组，收到 ${typeof rawCalendar}`,
      });
    } else {
      // 作业范围：日历只能覆盖 [最早开始, 最晚结束]
      let minStart = 0;
      let maxEnd = 0;
      if (jobs.length > 0) {
        minStart = jobs[0].start;
        maxEnd = jobs[0].end;
        for (const j of jobs) {
          if (j.start < minStart) minStart = j.start;
          if (j.end > maxEnd) maxEnd = j.end;
        }
      }

      const segments: CapacityCalendarSegment[] = [];
      rawCalendar.forEach((rawSeg, i) => {
        const prefix = `capacityCalendar[${i}]`;
        if (typeof rawSeg !== 'object' || rawSeg === null || Array.isArray(rawSeg)) {
          errors.push({ path: prefix, message: '日历片段必须是对象' });
          return;
        }
        const seg = rawSeg as RawCalendarSegment;
        const segErrors: ValidationError[] = [];

        let start: number | null = null;
        let end: number | null = null;
        let available: number | null = null;

        if (!('start' in seg)) {
          segErrors.push({ path: `${prefix}.start`, message: '缺少 start 字段' });
        } else if (!isInteger(seg.start)) {
          segErrors.push({
            path: `${prefix}.start`,
            message: `start 必须是整数，收到 ${JSON.stringify(seg.start)}`,
          });
        } else {
          start = seg.start;
        }

        if (!('end' in seg)) {
          segErrors.push({ path: `${prefix}.end`, message: '缺少 end 字段' });
        } else if (!isInteger(seg.end)) {
          segErrors.push({
            path: `${prefix}.end`,
            message: `end 必须是整数，收到 ${JSON.stringify(seg.end)}`,
          });
        } else {
          end = seg.end;
        }

        // 端点自身的数值范围（独立于另一端是否合法）
        if (start !== null && (start < 0 || start > MAX_BOUND)) {
          segErrors.push({
            path: `${prefix}.start`,
            message: `start 必须满足 0 <= start <= ${MAX_BOUND}，收到 ${start}`,
          });
        }
        if (end !== null && (end < 0 || end > MAX_BOUND)) {
          segErrors.push({
            path: `${prefix}.end`,
            message: `end 必须满足 0 <= end <= ${MAX_BOUND}，收到 ${end}`,
          });
        }
        // 半开区间方向
        if (start !== null && end !== null && end <= start) {
          segErrors.push({
            path: `${prefix}.end`,
            message: `end 必须严格大于 start（区间左闭右开），start=${start}, end=${end}`,
          });
        }
        // 作业范围：片段必须位于 [最早作业开始, 最晚作业结束] 之内
        if (jobs.length > 0 && start !== null && (start < minStart || start > maxEnd)) {
          segErrors.push({
            path: `${prefix}.start`,
            message: `start 必须位于作业范围 [${minStart}, ${maxEnd}] 之内，收到 ${start}`,
          });
        }
        if (jobs.length > 0 && end !== null && (end < minStart || end > maxEnd)) {
          segErrors.push({
            path: `${prefix}.end`,
            message: `end 必须位于作业范围 [${minStart}, ${maxEnd}] 之内，收到 ${end}`,
          });
        }

        if (!('available' in seg)) {
          segErrors.push({ path: `${prefix}.available`, message: '缺少 available 字段' });
        } else if (!isInteger(seg.available)) {
          segErrors.push({
            path: `${prefix}.available`,
            message: `available 必须是整数，收到 ${JSON.stringify(seg.available)}`,
          });
        } else if (seg.available < 0) {
          segErrors.push({
            path: `${prefix}.available`,
            message: `available 不允许为负数，收到 ${seg.available}`,
          });
        } else if (capacity !== null && seg.available > capacity - 1) {
          segErrors.push({
            path: `${prefix}.available`,
            message: `available 必须在 0..${capacity - 1} 之间（达到容量 ${capacity} 的限制无意义，请直接省略该片段），收到 ${seg.available}`,
          });
        } else {
          available = seg.available;
        }

        if (segErrors.length > 0) {
          errors.push(...segErrors);
          return;
        }
        segments.push({ start: start!, end: end!, available: available! });
      });

      // 排序后逐项检查重叠（相接允许）；字段非法的片段未进入 segments，
      // 不影响对合法片段的结构性检查
      const byStart = segments
        .map((seg, originalIndex) => ({ seg, originalIndex }))
        .sort((a, b) => a.seg.start - b.seg.start || a.seg.end - b.seg.end);
      for (let i = 1; i < byStart.length; i++) {
        const prev = byStart[i - 1].seg;
        const cur = byStart[i].seg;
        if (cur.start < prev.end) {
          const originalIndex = byStart[i].originalIndex;
          errors.push({
            path: `capacityCalendar[${originalIndex}]`,
            message: `片段 [${cur.start}, ${cur.end}) 与前一片段 [${prev.start}, ${prev.end}) 重叠；区间必须互不重叠（端点相接允许）`,
          });
        }
      }
      if (errors.length === 0) {
        calendar = byStart.map((x) => x.seg);
      }
    }
  }

  if (errors.length > 0) {
    throw new ValidationFailure(errors);
  }

  // jobs 数量越界时上面已记录；这里仅用于收窄类型
  return { capacity: capacity as Capacity, jobs, capacityCalendar: calendar };
}
