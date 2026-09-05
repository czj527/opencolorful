import { useMemo } from "react";

import type { TimelineItem } from "../mock-data.js";
import "./TimelineNav.css";

export interface TimelineTurn {
  /** 轮次 id（turn-<userEntryId>；稳定锚点） */
  readonly turnId: string;
  readonly index: number;
  readonly summary: string;
  readonly relativeTime: string;
}

/** 从 timeline 消息行派生当前分支的轮次节点（每条用户消息一个轮次起点） */
export function deriveTimelineTurns(items: readonly TimelineItem[]): TimelineTurn[] {
  const turns: TimelineTurn[] = [];
  let index = 0;
  for (const item of items) {
    if (item.type !== "message" || item.role !== "user" || item.turnId === undefined) continue;
    index += 1;
    const trimmed = item.body.trim();
    turns.push({
      turnId: item.turnId,
      index,
      summary: trimmed.length <= 20 ? trimmed : `${trimmed.slice(0, 20)}…`,
      relativeTime: item.timestamp ?? "",
    });
  }
  return turns;
}

interface TimelineNavProps {
  readonly items: readonly TimelineItem[];
  /** 当前视口所在轮次（滚动监听同步）；null = 未知 */
  readonly activeTurnId: string | null;
  readonly onSelectTurn: (turnId: string) => void;
}

/**
 * 波次 B3：当前分支的线性 timeline 导航（仅当前分支；分支切换器是独立视图）。
 * 节点以 turnId 为稳定锚点：entryId 在 JSONL 中不可变，跨刷新/重启/replay 有效。
 * 无锚点条目（旧会话回退投影/流式中）不产生节点。
 */
export function TimelineNav({ items, activeTurnId, onSelectTurn }: TimelineNavProps) {
  const turns = useMemo(() => deriveTimelineTurns(items), [items]);
  if (turns.length === 0) return null;
  return (
    <nav className="timeline-nav" aria-label="对话时间线" data-testid="oc-timeline-nav">
      <div className="timeline-track">
        {turns.map((turn) => (
          <button
            key={turn.turnId}
            type="button"
            className={`timeline-node${activeTurnId === turn.turnId ? " is-active" : ""}`}
            data-testid={`oc-timeline-node-${turn.turnId}`}
            aria-label={`第 ${turn.index} 轮：${turn.summary}`}
            title={turn.summary}
            onClick={() => onSelectTurn(turn.turnId)}
          >
            <span className="timeline-index" aria-hidden="true">{turn.index}</span>
            <span className="timeline-summary">{turn.summary}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
