import { buildCapacityGrid } from './capacityCalendar';
import { newDataId, isDataId } from './identity';
import {
  normalizeReferenceMembers,
  type ReferenceDiff,
  type ReferenceMember,
  type ReferencePlan,
} from './reference';
import type { SolverResult } from './solver';
import type { Capacity, CapacityCalendarSegment, Job, JobStatus, Workspace } from './types';

export interface StoredSnapshot {
  /**
   * 配套工作区的数据身份。旧快照没有该字段（undefined）：
   * 仅在 restoreSession 的旧数据迁移中、与同一旧工作区确认配套后补登。
   */
  workspaceDataId?: string;
  workspaceVersion: number;
  capacity: number;
  /** 本次求解使用的容量日历（与工作区同一数据源） */
  capacityCalendar: CapacityCalendarSegment[];
  solvedAt: string;
  result: SolverResult;
}

const STORAGE_KEY = 'rail-possession-scheduler:v1';
const SNAPSHOT_KEY = 'rail-possession-scheduler:snapshot:v1';
/**
 * 已采纳的不可变参考方案。与工作区/快照一样仅凭 dataId 配套：
 * 导入新数据或恢复到身份不配套的本地记录时绝不生效（记录直接丢弃）。
 */
const REFERENCE_KEY = 'rail-possession-scheduler:reference:v1';

const MAX_BOUND = 1_000_000_000;
const MAX_JOBS = 50_000;
const JOB_STATUSES: ReadonlySet<string> = new Set(['normal', 'required', 'excluded']);

interface PersistedWorkspace {
  dataId?: unknown;
  capacity: unknown;
  version: unknown;
  jobs: unknown;
  /** 旧版本地数据可能没有该字段；缺省即全程 capacity（空数组） */
  capacityCalendar?: unknown;
}

export interface RestoredSession {
  /** 通过结构校验的工作区；存储损坏/不完整时为 null */
  workspace: Workspace | null;
  /**
   * 仅当与工作区共享同一数据身份（且内容交叉核对通过）时非 null。
   * 同身份但版本较旧的快照保留（界面标记“已过期”）；身份不明/不匹配、
   * 结构无效或引用了不存在作业的快照一律为 null，不展示也不可下载。
   */
  snapshot: StoredSnapshot | null;
  /**
   * 仅当参考记录结构合法且 dataId 与工作区完全一致时非 null。
   * 参考不随快照成对：快照丢失/过期不影响已采纳参考；异身份、
   * 损坏或旧格式（无 dataId）的参考记录一律丢弃，绝不作用于新工作区。
   */
  reference: ReferencePlan | null;
}

function safeParse(raw: string | null): unknown | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 日历结构校验。与导入校验同标准：
 *  - 每项为对象，start/end/available 均为整数；
 *  - 0 <= start < end <= 1e9，0 <= available < capacity；
 *  - 各片段限于作业范围 [minStart, maxEnd]（有作业时）；
 *  - 片段互不重叠（端点相接允许）。
 * 返回按 start 排序的新数组；任何一项不合法返回 null。
 * 缺省（undefined）与空数组等价：返回 []。
 */
export function parseCalendar(
  value: unknown,
  capacity: number,
  jobBounds: { minStart: number; maxEnd: number } | null,
): CapacityCalendarSegment[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;

  const segments: CapacityCalendarSegment[] = [];
  for (const rawSeg of value) {
    if (typeof rawSeg !== 'object' || rawSeg === null || Array.isArray(rawSeg)) return null;
    const seg = rawSeg as Record<string, unknown>;
    const { start, end, available } = seg;
    if (!isInt(start) || !isInt(end) || !isInt(available)) return null;
    if (start < 0 || start > MAX_BOUND || end < 0 || end > MAX_BOUND) return null;
    if (end <= start) return null;
    if (available < 0 || available > capacity - 1) return null;
    if (jobBounds && (start < jobBounds.minStart || end > jobBounds.maxEnd)) return null;
    segments.push({ start, end, available });
  }

  segments.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].start < segments[i - 1].end) return null;
  }
  return segments;
}

function jobBounds(jobs: { start: number; end: number }[]): { minStart: number; maxEnd: number } | null {
  if (jobs.length === 0) return null;
  let minStart = jobs[0].start;
  let maxEnd = jobs[0].end;
  for (const j of jobs) {
    if (j.start < minStart) minStart = j.start;
    if (j.end > maxEnd) maxEnd = j.end;
  }
  return { minStart, maxEnd };
}

interface RawStoredJob {
  id: unknown;
  start: unknown;
  end: unknown;
  benefit: unknown;
  status: unknown;
}

/** 工作区结构校验：任何字段缺失/越界/状态非法/id 重复均整体拒绝。 */
function parseWorkspace(data: unknown): { workspace: Omit<Workspace, 'dataId'> & { dataId?: string }; legacy: boolean } | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const p = data as PersistedWorkspace;

  if (!isInt(p.capacity) || p.capacity < 1 || p.capacity > 8) return null;

  // version：旧数据可能缺失，缺省为 1；存在则必须是正整数
  let version = 1;
  if (p.version !== undefined) {
    if (!isInt(p.version) || p.version < 1) return null;
    version = p.version;
  }

  if (!Array.isArray(p.jobs) || p.jobs.length < 1 || p.jobs.length > MAX_JOBS) return null;

  const jobs: Job[] = [];
  const seen = new Set<string>();
  for (const rawJob of p.jobs) {
    if (typeof rawJob !== 'object' || rawJob === null || Array.isArray(rawJob)) return null;
    const j = rawJob as RawStoredJob;
    // 存储由本应用写入，id 必为字符串；非法 id 不再宽松规范化
    if (!isNonEmptyString(j.id) || seen.has(j.id)) return null;
    if (!isInt(j.start) || j.start < 0 || j.start > MAX_BOUND) return null;
    if (!isInt(j.end) || j.end <= j.start || j.end > MAX_BOUND) return null;
    if (!isInt(j.benefit) || j.benefit < 1 || j.benefit > MAX_BOUND) return null;
    if (!isNonEmptyString(j.status) || !JOB_STATUSES.has(j.status)) return null;
    seen.add(j.id);
    jobs.push({ id: j.id, start: j.start, end: j.end, benefit: j.benefit, status: j.status as JobStatus });
  }

  const calendar = parseCalendar(p.capacityCalendar, p.capacity, jobBounds(jobs));
  if (calendar === null) return null;

  // dataId：旧数据缺失（legacy），由恢复逻辑补登
  if (p.dataId !== undefined && !isDataId(p.dataId)) return null;

  return {
    workspace: {
      capacity: p.capacity as Capacity,
      version,
      jobs,
      capacityCalendar: calendar,
      dataId: p.dataId,
    },
    legacy: p.dataId === undefined,
  };
}

/** 快照结果体的纯结构校验（不依赖工作区；交叉核对另见 resultMatchesWorkspace）。 */
function parseSnapshotResult(result: unknown): SolverResult | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const r = result as Record<string, unknown>;

  if (!Array.isArray(r.selectedIds)) return null;
  const selectedIds: string[] = [];
  const idsSeen = new Set<string>();
  for (const id of r.selectedIds) {
    if (!isNonEmptyString(id) || idsSeen.has(id)) return null;
    idsSeen.add(id);
    selectedIds.push(id);
  }

  if (!Number.isSafeInteger(r.totalBenefit) || (r.totalBenefit as number) < 0) return null;
  if (!isInt(r.peakOccupancy) || r.peakOccupancy < 0) return null;
  if (!isInt(r.capacity) || r.capacity < 1 || r.capacity > 8) return null;
  if (!isInt(r.selectedCount) || r.selectedCount !== selectedIds.length) return null;
  // peakCellLimit 为新字段：旧结果缺失允许，存在则必须为非负整数
  if (r.peakCellLimit !== undefined && (!isInt(r.peakCellLimit) || r.peakCellLimit < 0)) return null;

  const totalBenefit = r.totalBenefit as number;
  const peakOccupancy = r.peakOccupancy as number;
  const capacity = r.capacity as number;
  const selectedCount = r.selectedCount as number;
  const peakCellLimit = r.peakCellLimit as number | undefined;

  return {
    selectedIds,
    totalBenefit,
    peakOccupancy,
    peakCellLimit,
    capacity,
    selectedCount,
  };
}

interface ParsedSnapshot {
  snapshot: StoredSnapshot;
  legacy: boolean;
}

/** 快照结构校验：工作区身份可缺失（旧快照），其余字段必须完整合法。 */
function parseSnapshot(data: unknown): ParsedSnapshot | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const s = data as Record<string, unknown>;

  if (s.workspaceDataId !== undefined && !isDataId(s.workspaceDataId)) return null;
  if (!isInt(s.workspaceVersion) || s.workspaceVersion < 1) return null;
  if (!isInt(s.capacity) || s.capacity < 1 || s.capacity > 8) return null;
  if (!isNonEmptyString(s.solvedAt)) return null;

  const result = parseSnapshotResult(s.result);
  if (!result) return null;

  // 日历先按快照自带 capacity 做结构校验；与工作区日历逐段相等由配对时核对
  const calendar = parseCalendar(s.capacityCalendar, s.capacity, null);
  if (calendar === null) return null;

  return {
    snapshot: {
      workspaceDataId: s.workspaceDataId as string | undefined,
      workspaceVersion: s.workspaceVersion,
      capacity: s.capacity,
      capacityCalendar: calendar,
      solvedAt: s.solvedAt,
      result,
    },
    legacy: s.workspaceDataId === undefined,
  };
}

function sameCalendar(a: CapacityCalendarSegment[], b: CapacityCalendarSegment[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end || a[i].available !== b[i].available) {
      return false;
    }
  }
  return true;
}

/**
 * 求解结果与工作区的交叉核对（也用于 worker 成功响应落地前的防御性验证）：
 *  - 容量、日历与工作区一致；
 *  - selectedIds 全部指向工作区中真实存在的作业；
 *  - 总收益等于入选作业收益之和；
 *  - 逐格扫描得到的峰值占用与 peakOccupancy 一致，且每格不超有效容量；
 *  - peakCellLimit（若结果中存在）等于最早峰值格的有效容量。
 *
 * 不校验入选作业的必选/排除状态：同身份旧版本的结果在约束修改后本就应
 * 标记为“已过期”，不属于冒充当前结果。
 */
export function resultMatchesWorkspace(
  workspace: Workspace,
  result: Pick<SolverResult, 'selectedIds' | 'totalBenefit' | 'peakOccupancy' | 'peakCellLimit' | 'capacity'>,
): boolean {
  if (result.capacity !== workspace.capacity) return false;

  const byId = new Map<string, Job>();
  for (const job of workspace.jobs) byId.set(job.id, job);

  const selected: Job[] = [];
  for (const id of result.selectedIds) {
    const job = byId.get(id);
    if (!job) return false; // 把不存在的作业交给下游是最危险的伪造结果
    selected.push(job);
  }

  let totalBenefit = 0;
  const grid = buildCapacityGrid(workspace.jobs, workspace.capacity, workspace.capacityCalendar);
  const m = grid.coords.length - 1;
  const diff = new Int32Array(m);
  for (const job of selected) {
    const li = grid.index.get(job.start)!;
    const ri = grid.index.get(job.end)!;
    diff[li] += 1;
    diff[ri] -= 1;
    totalBenefit += job.benefit;
  }
  if (totalBenefit !== result.totalBenefit) return false;

  let peak = 0;
  let peakCellLimit: number = workspace.capacity;
  let cur = 0;
  for (let i = 0; i < m; i++) {
    cur += diff[i];
    if (cur > grid.cellCapacity[i]) return false;
    if (cur > peak) {
      peak = cur;
      peakCellLimit = grid.cellCapacity[i];
    }
  }
  if (peak !== result.peakOccupancy) return false;
  if (result.peakCellLimit !== undefined && result.peakCellLimit !== peakCellLimit) return false;
  return true;
}

/** 快照与工作区是否配套：身份 + 版本 + 容量/日历 + 结果内容全部一致。 */
export function snapshotMatchesWorkspace(snapshot: StoredSnapshot, workspace: Workspace): boolean {
  if (snapshot.workspaceDataId !== workspace.dataId) return false;
  if (snapshot.workspaceVersion !== workspace.version) return false;
  if (snapshot.capacity !== workspace.capacity) return false;
  if (!sameCalendar(snapshot.capacityCalendar, workspace.capacityCalendar)) return false;
  return resultMatchesWorkspace(workspace, snapshot.result);
}

/**
 * 同身份但可能是旧版本的快照（用于“已过期”展示）：身份一致、
 * 内容仍是该批数据的一份合法结果即可；版本不同只表示过期，不表示伪造。
 */
export function snapshotBelongsToWorkspace(snapshot: StoredSnapshot, workspace: Workspace): boolean {
  if (snapshot.workspaceDataId !== workspace.dataId) return false;
  if (snapshot.capacity !== workspace.capacity) return false;
  if (!sameCalendar(snapshot.capacityCalendar, workspace.capacityCalendar)) return false;
  return resultMatchesWorkspace(workspace, snapshot.result);
}

function removeItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 存储不可用时忽略：内存中的配对结论仍然成立
  }
}

/**
 * 参考方案记录结构校验。参考是不可变输入，任何字段缺失/非法
 * （无 dataId、版本非正整数、时间戳非字符串、成员畸形/重复）整体拒绝。
 * 不校验成员是否仍存在于工作区：已删除成员由配对后的差异计算剔除。
 */
function parseReference(data: unknown): ReferencePlan | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  if (!isDataId(r.workspaceDataId)) return null;
  if (!isInt(r.workspaceVersion) || r.workspaceVersion < 1) return null;
  if (!isNonEmptyString(r.adoptedAt)) return null;
  const members = normalizeReferenceMembers(r.members);
  if (members === null) return null;
  return {
    workspaceDataId: r.workspaceDataId,
    workspaceVersion: r.workspaceVersion,
    adoptedAt: r.adoptedAt,
    members,
  };
}

/** 单独读取参考记录：仅结构校验，不与任何工作区配对（测试/工具用）。 */
export function loadReference(): ReferencePlan | null {
  try {
    const raw = localStorage.getItem(REFERENCE_KEY);
    return parseReference(safeParse(raw));
  } catch {
    return null;
  }
}

/** 持久化参考方案（采纳后写入；存储失败不影响内存中的功能）。 */
export function persistReference(reference: ReferencePlan): void {
  try {
    localStorage.setItem(REFERENCE_KEY, JSON.stringify(reference));
  } catch {
    // 忽略：存储不可用（隐私模式/超额）不影响当前会话
  }
}

/** 丢弃参考记录（导入新数据/异身份恢复时调用）。 */
export function clearReference(): void {
  removeItem(REFERENCE_KEY);
}

/**
 * 恢复唯一入口：同时读取工作区、求解快照与参考方案，按数据身份严格配对。
 *
 * 防混合规则：
 *  - 两份结果记录必须同属一个数据身份。版本号相同但 dataId 不同（典型：
 *    新导入的数据也从 version=1 起步）绝不配套；
 *  - 浏览器只成功写入一份记录（单键写入/中途崩溃）时，另一份没有同身份
 *    对象可配对，孤儿快照直接丢弃，绝不与新工作区混合；
 *  - 结构无效（畸形日历、非法状态、结果不完整、selectedIds 指向不存在
 *    的作业、收益/峰值对不上）的记录整体拒绝并清除，不渲染也不导出；
 *  - 参考方案独立按 dataId 配对：身份不明（旧格式无 dataId）或不匹配的
 *    参考记录直接删除，绝不作用于新工作区；参考不与快照绑定，
 *    快照过期/丢失不影响已采纳参考；
 *  - 旧合法存储（两份均无 dataId）仅在版本、容量、日历、结果内容全部
 *    与工作区对得上时视为配套，补登同一新 dataId 并立即回写迁移。
 */
export function restoreSession(): RestoredSession {
  const empty: RestoredSession = { workspace: null, snapshot: null, reference: null };
  let storageOk = true;
  try {
    storageOk = typeof localStorage !== 'undefined';
  } catch {
    storageOk = false;
  }
  if (!storageOk) return empty;

  let wsRaw: string | null = null;
  let snapRaw: string | null = null;
  let refRaw: string | null = null;
  try {
    wsRaw = localStorage.getItem(STORAGE_KEY);
    snapRaw = localStorage.getItem(SNAPSHOT_KEY);
    refRaw = localStorage.getItem(REFERENCE_KEY);
  } catch {
    return empty;
  }

  const parsedWs = parseWorkspace(safeParse(wsRaw));
  const parsedSnap = parseSnapshot(safeParse(snapRaw));
  // 旧版本地数据不可能有参考键：无 dataId 的参考记录直接判废
  const parsedReference = parseReference(safeParse(refRaw));
  if (refRaw !== null && !parsedReference) removeItem(REFERENCE_KEY);

  if (!parsedWs) {
    if (wsRaw !== null) removeItem(STORAGE_KEY);
    if (parsedSnap) removeItem(SNAPSHOT_KEY); // 没有工作区的快照无法配对，不能下发
    if (parsedReference) removeItem(REFERENCE_KEY);
    return empty;
  }

  if (!parsedSnap) {
    if (snapRaw !== null) removeItem(SNAPSHOT_KEY); // 工作区有效，快照损坏：保工作区、弃快照
    const dataId = parsedWs.legacy ? newDataId() : parsedWs.workspace.dataId!;
    const workspace = { ...parsedWs.workspace, dataId };
    if (parsedWs.legacy) persistWorkspace(workspace); // 旧工作区补登身份并立即回写
    return { workspace, snapshot: null, reference: matchReference(parsedReference, dataId) };
  }

  const { snapshot, legacy: snapLegacy } = parsedSnap;
  const wsLegacy = parsedWs.legacy;

  // 只有“两份都是旧数据”或“两份都是新数据且 dataId 相同”才可能配套
  if (wsLegacy !== snapLegacy || (!wsLegacy && parsedWs.workspace.dataId !== snapshot.workspaceDataId)) {
    removeItem(SNAPSHOT_KEY); // 异身份：可能是单键写入或旧快照残留，丢弃
    const dataId = wsLegacy ? newDataId() : parsedWs.workspace.dataId!;
    const workspace = { ...parsedWs.workspace, dataId };
    if (wsLegacy) persistWorkspace(workspace);
    return { workspace, snapshot: null, reference: matchReference(parsedReference, dataId) };
  }

  const workspace: Workspace = wsLegacy
    ? { ...parsedWs.workspace, dataId: newDataId() }
    : { ...parsedWs.workspace, dataId: parsedWs.workspace.dataId! };

  // 旧数据没有 dataId，版本号是唯一的配对线索：版本不一致不能配套
  const versionOk = !wsLegacy || snapshot.workspaceVersion === workspace.version;
  const contentOk =
    versionOk &&
    snapshot.capacity === workspace.capacity &&
    sameCalendar(snapshot.capacityCalendar, workspace.capacityCalendar) &&
    resultMatchesWorkspace(workspace, snapshot.result);

  if (!contentOk) {
    removeItem(SNAPSHOT_KEY);
    if (wsLegacy) persistWorkspace(workspace);
    return { workspace, snapshot: null, reference: matchReference(parsedReference, workspace.dataId) };
  }

  if (wsLegacy) {
    // 确认配套的旧数据：补登同一身份并回写，之后按新数据处理
    snapshot.workspaceDataId = workspace.dataId;
    persistWorkspace(workspace);
    persistSnapshot(snapshot);
  }

  // 同身份：版本相同即当前结果；版本较旧时由界面标记“已过期”（不冒充当前）
  return {
    workspace,
    snapshot,
    reference: matchReference(parsedReference, workspace.dataId),
  };
}

/**
 * 参考与工作区的唯一配对条件：dataId 完全相等。
 * 不匹配（含无工作区时的残留）的合法记录直接删除，防止误用。
 */
function matchReference(reference: ReferencePlan | null, dataId: string): ReferencePlan | null {
  if (!reference) return null;
  if (reference.workspaceDataId !== dataId) {
    removeItem(REFERENCE_KEY);
    return null;
  }
  return reference;
}

export function persistWorkspace(workspace: Workspace): void {
  try {
    const data: PersistedWorkspace & { dataId: string } = {
      dataId: workspace.dataId,
      capacity: workspace.capacity,
      version: workspace.version,
      jobs: workspace.jobs,
      capacityCalendar: workspace.capacityCalendar,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // 存储不可用（隐私模式/超额）不影响内存中的功能
  }
}

/**
 * 单独加载工作区（旧接口，供测试与工具复用）。同样执行严格结构校验；
 * 旧数据缺 dataId 时补一个新身份。
 */
export function loadWorkspace(): Workspace | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = parseWorkspace(safeParse(raw));
    if (!parsed) return null;
    return { ...parsed.workspace, dataId: parsed.legacy ? newDataId() : parsed.workspace.dataId! };
  } catch {
    return null;
  }
}

export function persistSnapshot(snapshot: StoredSnapshot): void {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // 忽略：结果持久化失败不影响当前会话
  }
}

/**
 * 单独加载快照（旧接口）：仅做结构校验。注意它不与任何工作区配对——
 * 界面恢复必须走 restoreSession()，避免跨批次数据冒充当前结果。
 */
export function loadSnapshot(): StoredSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    return parseSnapshot(safeParse(raw))?.snapshot ?? null;
  } catch {
    return null;
  }
}

/** 下载 JSON 中单个相对参考方案的差异成员（时刻为该成员当前时刻）。 */
export interface ReferenceDiffJson {
  id: string;
  start: number;
  end: number;
  /** 同编号作业在当前工作区中的时刻（保留项与 start/end 相同；改期项不同） */
  currentStart: number;
  currentEnd: number;
}

/** 下载 JSON 中的参考方案区块：与屏幕结果页逐项一致。 */
export interface ReferenceBlockJson {
  dataId: string;
  adoptedAt: string;
  /** 采纳时的工作区版本（仅信息用途） */
  workspaceVersion: number;
  retained: ReferenceDiffJson[];
  removed: ReferenceDiffJson[];
  added: ReferenceDiffJson[];
  /** 已从当前工作区删除、不参与可避免差异计数的参考成员 */
  deletedReference: ReferenceMember[];
  /** 可避免差异数 = removed + added */
  diffCount: number;
}

function toDiffJson(items: ReferenceDiff['retained']): ReferenceDiffJson[] {
  return items.map((item) => ({
    id: item.id,
    start: item.start,
    end: item.end,
    currentStart: item.currentStart,
    currentEnd: item.currentEnd,
  }));
}

/**
 * 屏幕展示集合与下载文件必须一致：统一由此函数构造结果 JSON。
 * 下载内容包含同一身份、同一日历、集合、收益和峰值数据，
 * 不含任何占位值或派生猜测字段；旧快照无身份时该字段缺省（原结构不变）。
 *
 * referenceDiff 非空（已采纳且身份配套的参考）时，结果页展示的
 * 保留/撤下/新增三类成员原样进入下载文件，屏幕与下载来自同一份
 * computeReferenceDiff 结果，不存在两套计算路径。
 */
export function buildResultJson(
  snapshot: StoredSnapshot,
  reference: ReferencePlan | null = null,
  referenceDiff: ReferenceDiff | null = null,
): {
  dataId?: string;
  capacity: number;
  capacityCalendar: CapacityCalendarSegment[];
  workspaceVersion: number;
  solvedAt: string;
  totalBenefit: number;
  peakOccupancy: number;
  peakCellLimit: number;
  selectedCount: number;
  selectedIds: string[];
  reference?: ReferenceBlockJson;
} {
  const base = {
    // undefined 在 JSON.stringify 时自动省略：旧快照下载结构保持原样
    dataId: snapshot.workspaceDataId,
    capacity: snapshot.capacity,
    capacityCalendar: snapshot.capacityCalendar,
    workspaceVersion: snapshot.workspaceVersion,
    solvedAt: snapshot.solvedAt,
    totalBenefit: snapshot.result.totalBenefit,
    peakOccupancy: snapshot.result.peakOccupancy,
    peakCellLimit:
      snapshot.result.peakCellLimit ?? effectiveFallback(snapshot.capacityCalendar, snapshot.capacity),
    selectedCount: snapshot.result.selectedCount,
    selectedIds: snapshot.result.selectedIds,
  };
  if (!reference || !referenceDiff) return base;
  return {
    ...base,
    reference: {
      dataId: reference.workspaceDataId,
      adoptedAt: reference.adoptedAt,
      workspaceVersion: reference.workspaceVersion,
      retained: toDiffJson(referenceDiff.retained),
      removed: toDiffJson(referenceDiff.removed),
      added: toDiffJson(referenceDiff.added),
      deletedReference: referenceDiff.deletedReference.map((m) => ({ ...m })),
      diffCount: referenceDiff.diffCount,
    },
  };
}

/** 旧结果缺 peakCellLimit 时的展示回退：空日历即全程 capacity。 */
function effectiveFallback(calendar: CapacityCalendarSegment[], capacity: number): number {
  return calendar.length === 0 ? capacity : Math.min(...calendar.map((s) => s.available));
}
