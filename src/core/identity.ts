/**
 * 数据身份（dataId）：
 *
 * 一次成功导入生成一个 dataId，它在该批数据的整个生命周期内不变
 * （约束修改只递增 workspace.version）；导入另一批数据必定得到新值。
 *
 * 版本号会在不同批次间重复（每个新工作区都从 version=1 起步），
 * 因此「工作区 ↔ 求解快照」「恢复时的两份存储记录」是否配套，
 * 必须由 dataId 与 version 共同判定，绝不能只比版本号。
 */

/** 生成一个新的数据身份标识。优先使用密码学随机源。 */
export function newDataId(): string {
  const c = globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } };
  if (c.crypto?.randomUUID) {
    return c.crypto.randomUUID();
  }
  if (c.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    c.crypto.getRandomValues(bytes);
    // RFC 4122 v4 形态（随机源不足 UUID 版本位要求时仍保证唯一可用）
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
      .slice(6, 8)
      .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
  }
  // 极端环境（无 crypto）：时间戳 + Math.random 兜底，仍以不碰撞为目标
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** 宽松判断存储中读出的 dataId 是否形态合法（非空字符串）。 */
export function isDataId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
