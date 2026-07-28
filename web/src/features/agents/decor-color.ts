// 装饰色调色板 —— 与 src 端 src/contracts/agent-identity.ts DECOR_COLORS 对齐。
// 仅用于 UI 视觉区分，不持久化，也无人格含义。基于 Agent ID 稳定生成。
import type { DecorColor } from "../../lib/types.js";

export const DECOR_COLORS = [
  "blue",
  "teal",
  "coral",
  "amber",
  "purple",
  "pink",
  "green",
] as const satisfies readonly DecorColor[];

/**
 * 根据 Agent ID 稳定生成装饰色。同一 ID 永远返回同一颜色。
 * 算法：简单字符串哈希 → 模 7 映射到调色板（与 src 端一致）。
 */
export function decorColorFromId(agentId: string): DecorColor {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0;
  }
  return DECOR_COLORS[Math.abs(hash) % DECOR_COLORS.length]!;
}

/**
 * 装饰色 → CSS 颜色值（bg / fg）。
 * 选取在 light/dark 两种主题下均具足够对比度的中饱和色，前景统一为白色。
 * 不依赖主题变量，避免在 themes/*.css 之外引入新令牌。
 */
export function decorColorCss(color: DecorColor): { bg: string; fg: string } {
  const map: Record<DecorColor, { bg: string; fg: string }> = {
    blue: { bg: "#3b82f6", fg: "#ffffff" },
    teal: { bg: "#14b8a6", fg: "#ffffff" },
    coral: { bg: "#f97316", fg: "#ffffff" },
    amber: { bg: "#f59e0b", fg: "#ffffff" },
    purple: { bg: "#8b5cf6", fg: "#ffffff" },
    pink: { bg: "#ec4899", fg: "#ffffff" },
    green: { bg: "#22c55e", fg: "#ffffff" },
  };
  return map[color];
}

/**
 * 提取名称首字。空字符串返回 "?"。
 * 使用 codePointAt 以正确处理 BMP 之外的字符（如 emoji）。
 */
export function firstCharOf(name: string): string {
  const cp = name.codePointAt(0);
  return cp === undefined ? "?" : String.fromCodePoint(cp);
}
