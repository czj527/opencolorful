import type { SessionUsageView } from "../data/source.js";

interface UsageBadgeProps {
  readonly usage: SessionUsageView;
}

/** >=1000 格式化为 k，>=1M 格式化为 M（去掉无意义的 .0），否则原样显示 */
function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value >= 1_000_000) {
    const m = (value / 1_000_000).toFixed(1);
    return m.endsWith(".0") ? `${m.slice(0, -2)}M` : `${m}M`;
  }
  const k = (value / 1000).toFixed(1);
  return k.endsWith(".0") ? `${k.slice(0, -2)}k` : `${k}k`;
}

/** 服务端 percent 为 0-100；极小值给下界，正常值取整 */
function formatPercent(value: number): string {
  if (value > 0 && value < 0.1) return "<0.1";
  return String(Math.round(value));
}

export function UsageBadge({ usage }: UsageBadgeProps) {
  const hasContext = usage.contextTokens !== null && usage.contextWindow > 0;
  const text = hasContext
    ? `上下文 ${formatTokens(usage.contextTokens ?? 0)}/${formatTokens(usage.contextWindow)}${usage.contextPercent !== null ? ` · ${formatPercent(usage.contextPercent)}%` : ""}`
    : "上下文 —";
  const title = `本会话总用量 ${usage.totalTokens} tokens · ${usage.turns} 轮`;
  return (
    <span className="chip usage-badge" title={title}>{text}</span>
  );
}
