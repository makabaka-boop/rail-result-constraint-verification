/**
 * 必选作业重叠度维护。
 *
 * 坐标是全部相关端点（作业端点 + 容量日历端点）压缩后的有序坐标；
 * 坐标索引 p 对应的“小格”为 [coords[p], coords[p+1])，即左闭右开。
 * 一条作业 [start, end) 覆盖的是其端点坐标索引构成的半开区间 [li, ri)。
 *
 * 这与求解器的语义一致：端点相接（一个 end == 另一个 start）落在
 * 不同小格，不会被计为重叠。
 *
 * 树中存储的值为「必选深度 - 该小格有效容量基数」，于是区间最大值
 * 表示“超出容量”的最严重程度：
 *  - 无容量日历时每个小格基数相同（-capacity），rangeMax 返回
 *    深度 - capacity（<= 0 表示可行）；
 *  - 有容量日历时各小格基数可能不同（-available 或 -capacity）。
 *
 * 支持：
 *  - rangeMax(li, ri)：区间内（深度 - 容量基数）最大值（不含 ri）
 *  - rangeAdd(li, ri, +1/-1)：必选集合增删
 */

/** 空区间哨兵：深度-容量的实际取值在 [-8, 50000]，此值足够小 */
const NEG_INF = -1_000_000_000;

export class IntervalDepthTree {
  private readonly n: number;
  private readonly mx: Int32Array;
  private readonly lazy: Int32Array;
  /** 是否带有容量基数；无基数（旧行为）时空区间按深度 0 处理 */
  private readonly hasBase: boolean;

  /**
   * @param coords 有序坐标（至少 2 个）
   * @param baseCapacity 小格 p 的容量基数；省略时所有小格视为容量 Infinity
   *        的旧行为（基数 0，即 rangeMax 直接返回必选深度）。
   *        传入单个数字时所有小格使用同一容量（全程 capacity 的旧语义）。
   */
  constructor(coords: number[], baseCapacity?: number | Int32Array) {
    // 小格数量 = 端点数 - 1
    this.n = Math.max(0, coords.length - 1);
    const size = 4 * Math.max(1, this.n);
    this.mx = new Int32Array(size);
    this.lazy = new Int32Array(size);
    this.hasBase = baseCapacity !== undefined;

    if (baseCapacity !== undefined && this.n > 0) {
      if (typeof baseCapacity === 'number') {
        // 全程同一容量：根覆盖整个范围，直接整体置 -capacity
        this.mx[1] = -baseCapacity;
        this.lazy[1] = -baseCapacity;
      } else {
        // 逐小格不同容量：只写叶子再向上归并
        this.buildLeaves(1, 0, this.n, baseCapacity);
      }
    }
  }

  rangeMax(li: number, ri: number): number {
    if (li >= ri || li >= this.n) return this.hasBase ? NEG_INF : 0;
    return this.query(1, 0, this.n, li, Math.min(ri, this.n));
  }

  rangeAdd(li: number, ri: number, delta: number): void {
    if (li >= ri || li >= this.n) return;
    this.update(1, 0, this.n, li, Math.min(ri, this.n), delta);
  }

  private buildLeaves(node: number, l: number, r: number, cap: Int32Array): void {
    if (r - l === 1) {
      this.mx[node] = -cap[l];
      return;
    }
    const m = (l + r) >> 1;
    const left = node << 1;
    this.buildLeaves(left, l, m, cap);
    this.buildLeaves(left | 1, m, r, cap);
    this.mx[node] = Math.max(this.mx[left], this.mx[left | 1]);
  }

  private query(node: number, l: number, r: number, ql: number, qr: number): number {
    if (qr <= l || r <= ql) return this.hasBase ? NEG_INF : 0;
    if (ql <= l && r <= qr) return this.mx[node];
    this.push(node);
    const m = (l + r) >> 1;
    const left = this.query(node << 1, l, m, ql, qr);
    const right = this.query((node << 1) | 1, m, r, ql, qr);
    return Math.max(left, right);
  }

  private update(node: number, l: number, r: number, ql: number, qr: number, delta: number): void {
    if (qr <= l || r <= ql) return;
    if (ql <= l && r <= qr) {
      this.mx[node] += delta;
      this.lazy[node] += delta;
      return;
    }
    this.push(node);
    const m = (l + r) >> 1;
    this.update(node << 1, l, m, ql, qr, delta);
    this.update((node << 1) | 1, m, r, ql, qr, delta);
    this.mx[node] = Math.max(this.mx[node << 1], this.mx[(node << 1) | 1]);
  }

  private push(node: number): void {
    const v = this.lazy[node];
    if (v !== 0) {
      const left = node << 1;
      this.mx[left] += v;
      this.lazy[left] += v;
      this.mx[left | 1] += v;
      this.lazy[left | 1] += v;
      this.lazy[node] = 0;
    }
  }
}
