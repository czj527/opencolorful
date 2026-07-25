import { useState } from "react";
import type { ContextUsage, TokenUsage } from "../../lib/types.js";

interface ContextUsageRingProps {
  /** 上下文占用（null 表示空会话/无数据，置灰空环） */
  readonly context: ContextUsage | null;
  /** 会话累计用量 */
  readonly totals: TokenUsage;
  /** 会话累计缓存命中率（null 显示 —） */
  readonly cacheHitRate: number | null;
}

const SIZE = 22;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN");
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

/**
 * 环形上下文用量组件：随 context.percent 填充，悬停展示详情卡片。
 * 颜色阈值：<60% accent；60–85% warning；>85% danger。
 */
export function ContextUsageRing({ context, totals, cacheHitRate }: ContextUsageRingProps) {
  const [hover, setHover] = useState(false);

  const percent = context?.percent ?? null;
  const ratio = percent === null ? 0 : Math.min(100, Math.max(0, percent)) / 100;
  const empty = context === null || percent === null;

  let colorClass = "context-ring-accent";
  if (empty) {
    colorClass = "context-ring-empty";
  } else if (percent !== null && percent > 85) {
    colorClass = "context-ring-danger";
  } else if (percent !== null && percent >= 60) {
    colorClass = "context-ring-warning";
  }

  const ariaLabel = empty
    ? "上下文用量：暂无数据"
    : `上下文用量 ${percent!.toFixed(0)}%`;

  return (
    <div
      className="context-usage-ring"
      data-testid="context-usage-ring"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={ariaLabel}
        data-level={colorClass}
      >
        <circle
          className="context-ring-track"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
        />
        <circle
          className={`context-ring-fill ${colorClass}`}
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>

      {hover && (
        <div className="context-ring-popover" role="tooltip" data-testid="context-ring-popover">
          <div className="context-ring-section">
            <div className="context-ring-title">上下文</div>
            {context === null || context.tokens === null ? (
              <div className="context-ring-row">等待下一次响应</div>
            ) : (
              <div className="context-ring-row">
                {formatNumber(context.tokens)} / {formatNumber(context.contextWindow)}
                {percent !== null ? `（${percent.toFixed(1)}%）` : ""}
              </div>
            )}
          </div>
          <div className="context-ring-section">
            <div className="context-ring-title">会话累计</div>
            <div className="context-ring-row">输入 {formatNumber(totals.input)}</div>
            <div className="context-ring-row">输出 {formatNumber(totals.output)}</div>
            <div className="context-ring-row">缓存读 {formatNumber(totals.cacheRead)}</div>
            <div className="context-ring-row">缓存写 {formatNumber(totals.cacheWrite)}</div>
            <div className="context-ring-row">总计 {formatNumber(totals.totalTokens)}</div>
          </div>
          <div className="context-ring-section">
            <div className="context-ring-row">缓存命中率 {formatPercent(cacheHitRate)}</div>
          </div>
        </div>
      )}
    </div>
  );
}
