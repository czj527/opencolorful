import type { ReactNode } from "react";
import styles from "./Badge.module.css";

export type BadgeVariant = "default" | "success" | "warning" | "danger" | "info";

export interface BadgeProps {
  readonly children: ReactNode;
  readonly variant?: BadgeVariant;
  readonly className?: string;
}

const variantClass: Record<BadgeVariant, string | undefined> = {
  default: styles.default,
  success: styles.success,
  warning: styles.warning,
  danger: styles.danger,
  info: styles.info,
};

export function Badge({ children, variant = "default", className }: BadgeProps) {
  const classes = [styles.badge, variantClass[variant], className ?? ""]
    .filter(Boolean)
    .join(" ");
  return <span className={classes}>{children}</span>;
}
