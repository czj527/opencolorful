import { useMemo } from "react";

import type { TimelineItem } from "../mock-data.js";
import "./TimelineNav.css";

export interface TimelineTurn {
  /** 轮次 id（turn-<userEntryId>；稳定锚点） */
  readonly turnId: string;
  readonly index: number;
  readonly summary: string;
  /** 相对时间文案（复用消息行 meta：刚刚 / N 分钟前…） */
  readonly relativeTime: string;
}

/**
 * 从 timeline 消息行派生当前分支的轮次节点（每条用户消息一个轮次起点）。
 * 摘要取用户消息正文截断——让用户一眼定位「我当时在问什么」，
 * 不展示工具调用等过程条目（参考 lobe-chat 话题列表的信息密度取舍）。
 */
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
      summary: trimmed.length <= 36 ? trimmed : `${trimmed.slice(0, 36)}…`,
      relativeTime: item.meta,
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
 * 当前分支的对话时间线：对话区左侧竖排导航（圆点 + 竖线串联轮次）。
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
            <span className="timeline-dot" aria-hidden="true" />
            <span className="timeline-text">
              <span className="timeline-summary">{turn.summary}</span>
              {turn.relativeTime !== "" && <span className="timeline-time">{turn.relativeTime}</span>}
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}
