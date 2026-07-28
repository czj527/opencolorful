import type { CSSProperties } from "react";
import type { DecorColor } from "../../lib/types.js";
import { decorColorFromId, decorColorCss, firstCharOf } from "./decor-color.js";
import styles from "./AgentAvatar.module.css";

export type AgentAvatarSize = "sm" | "md" | "lg";

export interface AgentAvatarProps {
  readonly agentId: string;
  readonly name: string;
  readonly size?: AgentAvatarSize;
}

const sizeClass: Record<AgentAvatarSize, string | undefined> = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
};

/**
 * 圆形装饰色徽章。背景色由 Agent ID 稳定生成，文字为名称首字。
 * 装饰用途，aria-hidden；名称由外层展示。
 */
export function AgentAvatar({ agentId, name, size = "md" }: AgentAvatarProps) {
  const color: DecorColor = decorColorFromId(agentId);
  const { bg, fg } = decorColorCss(color);
  const style: CSSProperties = { background: bg, color: fg };
  const classes = [styles.avatar, sizeClass[size]].filter(Boolean).join(" ");
  return (
    <span className={classes} style={style} aria-hidden="true">
      {firstCharOf(name)}
    </span>
  );
}
