import { buildCapacityGrid, findRequiredConflict } from './capacityCalendar';
import { memberKey, type ReferenceMember } from './reference';
import type { CapacityCalendarSegment, JobStatus } from './types';

export interface SolverJob {
  id: string;
  start: number;
  end: number;
  benefit: number;
  status: JobStatus;
}

export interface SolverResult {
  /** 入选作业 id（按导入顺序排序，保证确定性） */
  selectedIds: string[];
  /** 入选作业收益之和（精确整数；输入上界下 <= 5e13） */
  totalBenefit: number;
  /** 入选作业在时间轴上的最大同时重叠数 */
  peakOccupancy: number;
  /**
   * 峰值占用最早发生的那个时间格的有效容量上限。
   * 可选：旧持久化结果可能没有该字段（消费者回退到 capacity/日历最小值）。
   */
  peakCellLimit?: number;
  capacity: number;
  /** 入选作业数 */
  selectedCount: number;
}

export class InfeasibleRequiredError extends Error {
  /** 必选集合本身超过容量时，给出一个最早发生冲突的必选作业 id */
  readonly conflictingId?: string;
  constructor(message: string, conflictingId?: string) {
    super(message);
    this.name = 'InfeasibleRequiredError';
    this.conflictingId = conflictingId;
  }
}

interface Edge {
  to: number;
  /** 剩余容量 */
  cap: number;
  /** 费用（BigInt，可为负） */
  cost: bigint;
  rev: number;
  /** 作业边：对应候选数组下标；时间边/辅助边为 -1 */
  jobIndex: number;
}

/**
 * 最小二叉堆：元素为 [距离, 节点]，按 BigInt 距离比较。
 * 允许同节点多次插入；由调用方用弹出的 key 与当前 dist 比对来丢弃过期条目。
 */
class Heap {
  private keys: bigint[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: bigint, value: number): void {
    let i = this.keys.length;
    this.keys.push(key);
    this.vals.push(value);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): [bigint, number] | undefined {
    const n = this.keys.length;
    if (n === 0) return undefined;
    const key = this.keys[0];
    const value = this.vals[0];
    const lastKey = this.keys[n - 1];
    const lastVal = this.vals[n - 1];
    this.keys.pop();
    this.vals.pop();
    if (n > 1) {
      this.keys[0] = lastKey;
      this.vals[0] = lastVal;
      let i = 0;
      const m = this.keys.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= m) break;
        const r = l + 1;
        let c = l;
        if (r < m && this.keys[r] < this.keys[l]) c = r;
        if (this.keys[i] <= this.keys[c]) break;
        this.swap(i, c);
        i = c;
      }
    }
    return [key, value];
  }

  private swap(a: number, b: number): void {
    const k = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = k;
    const v = this.vals[a];
    this.vals[a] = this.vals[b];
    this.vals[b] = v;
  }
}

const INF_DIST = 1n << 120n;

/**
 * 精确求解容量（可随时间变化）约束下的带权作业选择。
 *
 * 可选 reference：调用方已采纳的不可变参考方案中、仍存在于当前数据的
 * 活动成员（id+start+end 三元组；已删除成员应在调用前剔除）。
 *
 * 优化为严格字典序：
 *   1) 必选作业全部入选（可行时）；
 *   2) 总收益最大化；
 *   3) 总收益相同的最优方案间，最小化与参考方案的可避免成员差异
 *      （多保留一个参考成员 / 少引入一个非参考成员都使目标 -1）；
 *   4) 仍并列时由流网络的确定性最短路裁决（与无参考时完全相同）。
 *
 * 费用编码（BigInt）：设候选数 n、候选收益和 Bsum：
 *   - K = 2n+1（任何方案间的成员偏好分差 |Δ| <= 2n < K，故单位收益
 *     的取舍 K 严格压过任何成员偏好）；
 *   - 必选权重 M = K·Bsum + 2n + 1（丢掉一项必选的代价超过任何
 *     收益/成员取舍之和，必选数严格第一优先）；
 *   - 普通作业费用 = -(K·benefit + ε)，必选作业费用 = -(M + K·benefit + ε)；
 *     参考成员 ε = 1（入选使费用再减 1），非参考成员 ε = -1。
 * 无参考（或没有任何活动成员命中当前候选）时 ε ≡ 0，费用结构与旧版
 * 完全一致，求解结果逐项不变。
 *
 * 时间格由「作业端点 + 容量日历端点」坐标压缩形成，小格 i 的有效容量
 * 为 cap_i（无日历覆盖处即全局 capacity）。
 *
 * 模型（时间轴 DAG 上的最小费用流，单一超源 S、单一超汇 T）：
 *   - 时间节点 0..m；时间边 i -> i+1 容量 capacity、费用 0，
 *     一单位流 = 一条作业队轨道在该格闲置；
 *   - 作业边 li -> ri 容量 1，费用见上；
 *   - 边界（轨道上/下班）边，令 cap_{-1}=cap_m=0：
 *       cap_i > cap_{i-1}（升容）：S -> i，容量为增量（轨道在此上线）；
 *       cap_i < cap_{i-1}（降容）：i -> T，容量为减量（轨道在此下线）。
 *
 * 正确性（割论证）：对小格 i 作割，时间节点 0..i 与 S 同属源侧，
 * 其余节点（含 T）属汇侧。从源侧到汇侧穿越该割的正向边只有
 * 时间边 i->i+1（容量 capacity）与跨越该格的作业边；S->j、j->T
 * 边界边两端同处一侧，不穿越任何小格割。由流量守恒，穿越割 i 的
 * 总流量恰为“已上线、尚未下线”的轨道数，即升/降容边界的前缀和，
 * 恰等于 cap_i；其中时间边是闲置轨道，故跨越该格的作业边流量
 * （入选作业数）<= cap_i。cap_i 恒为 capacity（无日历）时只有
 * S->0 与 m->T 两条边界边，完全退化为旧模型（发送 capacity 单位流）。
 *
 * 残余网络中的反向边界边允许 SSP 把轨道改派到更晚的升容点
 * （处理 available=0 等中断时段所必需）；割论证对增广后的最终
 * 可行流依然成立。
 *
 * 初始位势用 SPFA 精确求得（图有多个直达 T 的降容点，不是从 S
 * 单调向前的 DAG，简单拓扑松弛会使约化费用出现负边）。
 *
 * 费用/距离全程 BigInt。相接端点属于不同小格，天然允许首尾相接。
 */
export function solve(
  jobs: SolverJob[],
  capacity: number,
  calendar: CapacityCalendarSegment[] = [],
  reference: readonly ReferenceMember[] = [],
): SolverResult {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) {
    throw new Error(`capacity 非法：${capacity}`);
  }

  // 排除作业不进入候选/网络，任何情况下都不会入选
  const candidates: SolverJob[] = [];
  const requiredJobs: SolverJob[] = [];
  for (const job of jobs) {
    if (job.status === 'excluded') continue;
    candidates.push(job);
    if (job.status === 'required') requiredJobs.push(job);
  }

  // 没有任何作业：空选择即最优
  if (candidates.length === 0) {
    return {
      selectedIds: [],
      totalBenefit: 0,
      peakOccupancy: 0,
      peakCellLimit: capacity,
      capacity,
      selectedCount: 0,
    };
  }

  // 统一时间格（作业端点 + 日历端点）与每格有效容量
  const grid = buildCapacityGrid(candidates, capacity, calendar);
  const coords = grid.coords;
  const cellCap = grid.cellCapacity;
  const index = grid.index;
  const m = coords.length - 1; // 小格数；时间节点 0..m

  // 必选可行性：逐格检查必选深度 <= 该格有效容量
  const conflictId = findRequiredConflict(requiredJobs, grid);
  if (conflictId !== undefined) {
    throw new InfeasibleRequiredError(
      `必选作业在部分时段重叠数超过有效容量上限（容量日历可能在部分时段下调了 capacity=${capacity}，例如 "${conflictId}" 附近），无解`,
      conflictId,
    );
  }

  // 必选费用的权重基数（字典序编码）：
  //   成员偏好 ε ∈ {-1,+1}，任意两方案的 ε 总和之差 |Δε| <= 2n < K，
  //   所以 1 单位收益（权重 K）严格压过任何成员取舍；
  //   M = K·Bsum + 2n + 1 又严格压过“任意收益差 + 任意 ε 差”，
  //   所以多包含一项必选（费用再减 M）永远优先于一切收益/成员取舍。
  let benefitSum = 0n;
  for (const job of candidates) benefitSum += BigInt(job.benefit);
  const nCandidates = BigInt(candidates.length);
  const K = 2n * nCandidates + 1n;
  const M = K * benefitSum + 2n * nCandidates + 1n;

  // 活动参考成员键集合（id+start+end）。命中候选的成员才启用 ε：
  // 一个都不命中时 ε ≡ 0，费用与旧版逐位相同（未采纳时结果逐项不变）。
  const candidateKeys = new Set<string>();
  for (const job of candidates) candidateKeys.add(memberKey(job));
  const referenceKeys = new Set<string>();
  let referenceHits = 0;
  for (const member of reference) {
    if (candidateKeys.has(memberKey(member))) {
      referenceKeys.add(memberKey(member));
      referenceHits++;
    }
  }
  const useReference = referenceHits > 0;

  // 节点：0..m 时间节点；S = m+1 超源；T = m+2 超汇
  const S = m + 1;
  const T = m + 2;
  const nodeCount = m + 3;
  const graph: Edge[][] = Array.from({ length: nodeCount }, () => []);
  const addEdge = (u: number, v: number, cap: number, cost: bigint, jobIndex: number): void => {
    const forward: Edge = { to: v, cap, cost, rev: graph[v].length, jobIndex };
    const backward: Edge = { to: u, cap: 0, cost: -cost, rev: graph[u].length, jobIndex: -1 };
    graph[u].push(forward);
    graph[v].push(backward);
  };

  // 时间边
  for (let i = 0; i < m; i++) {
    addEdge(i, i + 1, capacity, 0n, -1);
  }
  // 作业边
  for (let j = 0; j < candidates.length; j++) {
    const job = candidates[j];
    const li = index.get(job.start)!;
    const ri = index.get(job.end)!;
    const benefitPart = K * BigInt(job.benefit);
    // ε=+1 参考成员（偏好保留）、ε=-1 非参考成员（偏好不引入）；
    // 无命中参考时 ε=0。最小化费用 = 最小化可避免成员差异。
    const epsilon = useReference ? (referenceKeys.has(memberKey(job)) ? 1n : -1n) : 0n;
    const cost =
      job.status === 'required' ? -(M + benefitPart + epsilon) : -(benefitPart + epsilon);
    addEdge(li, ri, 1, cost, j);
  }

  // 边界（上/下班）边与总供给。totalSupply 累计所有升容沿的上线轨道，
  // 包含容量在下降后再次回升时重新上线的轨道；其规模为
  // capacity ×（升容段数 + 1），日历片段通常很少，故增广次数仍是小常数。
  let totalSupply = 0;
  let prevCap = 0;
  for (let i = 0; i <= m; i++) {
    const capHere = i < m ? cellCap[i] : 0;
    if (capHere > prevCap) {
      addEdge(S, i, capHere - prevCap, 0n, -1);
      totalSupply += capHere - prevCap;
    } else if (capHere < prevCap) {
      addEdge(i, T, prevCap - capHere, 0n, -1);
    }
    prevCap = capHere;
  }

  // 初始可行位势 = 从 S 出发的最短距离。前向图在顺序
  // [S, 0, 1, ..., m, T] 下是 DAG：S->i、i->i+1、作业边 li->ri、
  // i->T 全部由前指向后（T 最后松弛，届时所有降容点 i 已定稿），
  // 且每个时间节点都能经时间边（容量 capacity>0）从节点 0 到达。
  // 故按该拓扑序单遍松弛即精确最短，O(V+E)，无需 Bellman-Ford。
  const potential: bigint[] = new Array(nodeCount).fill(0n);
  {
    const dist: bigint[] = new Array(nodeCount).fill(INF_DIST);
    dist[S] = 0n;
    const relax = (u: number): void => {
      if (dist[u] === INF_DIST) return;
      const du = dist[u];
      for (const e of graph[u]) {
        if (e.cap > 0 && du + e.cost < dist[e.to]) dist[e.to] = du + e.cost;
      }
    };
    relax(S);
    for (let i = 0; i <= m; i++) relax(i);
    for (let v = 0; v < nodeCount; v++) {
      if (dist[v] < INF_DIST) potential[v] = dist[v];
    }
  }

  // 从 S 向 T 发送 totalSupply 单位流；带位势 Dijkstra 求最短路后沿
  // 路径瓶颈容量批量增广（边界边/时间边容量可能 >1），把 Dijkstra
  // 次数压到“不同最短路费用”的数量，日历片段很多时也不退化。
  const dist: bigint[] = new Array(nodeCount);
  const prevNode: Int32Array = new Int32Array(nodeCount);
  const prevEdge: Int32Array = new Int32Array(nodeCount);

  let sent = 0;
  while (sent < totalSupply) {
    dist.fill(INF_DIST);
    dist[S] = 0n;
    const heap = new Heap();
    heap.push(0n, S);

    while (heap.size > 0) {
      const popped = heap.pop();
      if (!popped) break;
      const [key, u] = popped;
      if (key !== dist[u]) continue;
      const du = key;
      const edges = graph[u];
      for (let ei = 0; ei < edges.length; ei++) {
        const e = edges[ei];
        if (e.cap <= 0) continue;
        const reduced = e.cost + potential[u] - potential[e.to];
        const nd = du + reduced;
        if (nd < dist[e.to]) {
          dist[e.to] = nd;
          prevNode[e.to] = u;
          prevEdge[e.to] = ei;
          heap.push(nd, e.to);
        }
      }
    }

    if (dist[T] === INF_DIST) {
      // 时间边构成各时段直连通道，边界供给不超过各格容量，不会发生
      throw new InfeasibleRequiredError('流网络无法发送足够流量，排程不可行');
    }

    for (let v = 0; v < nodeCount; v++) {
      if (dist[v] < INF_DIST) potential[v] += dist[v];
    }

    // 瓶颈容量（不超过尚未发送的供给）
    let aug = totalSupply - sent;
    for (let v = T; v !== S; v = prevNode[v]) {
      aug = Math.min(aug, graph[prevNode[v]][prevEdge[v]].cap);
    }
    for (let v = T; v !== S; v = prevNode[v]) {
      const u = prevNode[v];
      const ei = prevEdge[v];
      const e = graph[u][ei];
      e.cap -= aug;
      graph[v][e.rev].cap += aug;
    }
    sent += aug;
  }

  // 入选判定：作业边剩余容量 0 即恰有 1 单位流量经过
  const selected = new Set<number>();
  for (let u = 0; u <= m; u++) {
    for (const e of graph[u]) {
      if (e.jobIndex >= 0 && e.cap === 0) {
        selected.add(e.jobIndex);
      }
    }
  }

  // 结果核对：必选必须全部入选（费用性质保证，此处为防御性断言）
  for (const job of requiredJobs) {
    const j = candidates.indexOf(job);
    if (!selected.has(j)) {
      throw new InfeasibleRequiredError(
        `内部错误：必选作业 "${job.id}" 未被选入，请反馈`,
        job.id,
      );
    }
  }

  // 峰值占用：差分扫描；同时逐格核对容量并记录最早峰值格的上限
  const diff = new Int32Array(m);
  let total = 0;
  for (const j of selected) {
    const job = candidates[j];
    const li = index.get(job.start)!;
    const ri = index.get(job.end)!;
    diff[li] += 1;
    diff[ri] -= 1;
    total += job.benefit;
  }
  let peak = 0;
  let peakCellLimit = capacity;
  let cur = 0;
  for (let i = 0; i < m; i++) {
    cur += diff[i];
    if (cur > cellCap[i]) {
      throw new InfeasibleRequiredError(
        `内部错误：时间格 [${coords[i]}, ${coords[i + 1]}) 入选数 ${cur} 超过有效容量 ${cellCap[i]}，请反馈`,
      );
    }
    if (cur > peak) {
      peak = cur;
      peakCellLimit = cellCap[i];
    }
  }

  // candidates 保持导入顺序，下标升序即导入顺序
  const indices = [...selected].sort((a, b) => a - b);

  return {
    selectedIds: indices.map((j) => candidates[j].id),
    totalBenefit: total,
    peakOccupancy: peak,
    peakCellLimit,
    capacity,
    selectedCount: selected.size,
  };
}
