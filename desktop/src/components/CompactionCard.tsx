import { useState } from "react";

import type { CompactionItem } from "../mock-data.js";
import "./CompactionCard.css";

/** 状态 → 卡片标题（§3.2.4 冻结：中止与失败分态可区分；no-op/busy 不产卡） */
function statusTitle(status: CompactionItem["status"]): string {
  switch (status) {
    case "compacting": return "正在压缩会话上下文…";
    case "aborted": return "压缩未完成：已中止";
    case "failed": return "压缩未完成";
    case "completed": return "上下文已压缩";
  }
}

/** tokens 展示：completed 且双值齐备才展示；tokensAfter 是服务端估算值 → 标注「约」 */
function TokensLine({ item }: { readonly item: CompactionItem }) {
  if (item.status !== "completed") return null;
  if (typeof item.tokensBefore !== "number" || typeof item.tokensAfter !== "number") return null;
  return (
    <span className="compaction-card-tokens" data-testid="oc-compaction-tokens">
      {item.tokensBefore} → 约{item.tokensAfter} tokens
    </span>
  );
}

/**
 * 波次 B4：压缩摘要卡（§3.2.4 冻结显示规则）。
 * - 正文不做客户端截断（服务端已脱敏 ≤500 字符）；长摘要默认折叠，可展开/收起；
 * - aborted 与 failed 分态可区分；compacting 无正文；
 * - 摘要正文不得写入日志（本组件无任何 console 输出）。
 */
export function CompactionCard({ item }: { readonly item: CompactionItem }) {
  const [expanded, setExpanded] = useState(false);
  const hasSummary = item.status === "completed" && typeof item.summary === "string" && item.summary !== "";
  // 长摘要（>160 字符）默认折叠；短摘要直接展示
  const longSummary = hasSummary && (item.summary as string).length > 160;
  const showBody = hasSummary && (expanded || !longSummary);
  return (
    <div
      className={`compaction-card compaction-card-${item.status}`}
      data-testid={`oc-compaction-card-${item.id}`}
    >
      <div className="compaction-card-head">
        <span className="compaction-card-title">{statusTitle(item.status)}</span>
        <TokensLine item={item} />
      </div>
      {item.status === "failed" && item.errorMessage !== undefined && (
        <div className="compaction-card-error" data-testid="oc-compaction-error">{item.errorMessage}</div>
      )}
      {longSummary && (
        <button
          type="button"
          className="compaction-card-toggle"
          data-testid="oc-compaction-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起摘要" : "展开摘要"}
        </button>
      )}
      {showBody && (
        <p className="compaction-card-summary" data-testid="oc-compaction-summary">{item.summary}</p>
      )}
    </div>
  );
}
